import os
import time
import logging
import boto3
import json
import migration_lib
import collections

from migration_lib.job import JobMigrator, JobSender, JobConfig
from migration_lib.service import SQSService, DBService
from migration_lib.client import ClientManager, JobInfo
from migration_lib.config import JobConfig

MAX_NUMBER_OF_MESSAGES = 1


logger = logging.getLogger(__name__)


def get_log_level():
    log_level = str(os.environ.get('LOG_LEVEL')).upper()
    if log_level not in ['DEBUG', 'INFO', 'WARNING', 'ERROR', 'CRITICAL']:
        log_level = 'WARNING'
    return log_level


def get_logger():
    log_level = get_log_level()
    # format = '%(asctime)s %(levelname)s - %(message)s'
    # format = '%(message)s'
    format = '%(levelname)s:%(message)s'
    format = '[%(levelname)s] %(message)s'

    logging.basicConfig(format=format, level=log_level)
    # logging.basicConfig(level=log_level)
    logger = logging.getLogger()
    # logger.info(migration_lib.__version__)
    # logger.info("The log level is %s", log_level)
    return logger


def get_regions(region_name, job_type):
    src_region, des_region = '', region_name
    if job_type == 'GET':
        src_region, des_region = des_region, src_region
    return src_region, des_region


def get_credentials(ssm_parameter_credentials, job_type):
    no_auth = False

    # Get connection credentials
    if ssm_parameter_credentials:
        ssm = boto3.client('ssm')
        credentials = json.loads(ssm.get_parameter(
            Name=ssm_parameter_credentials,
            WithDecryption=True
        )['Parameter']['Value'])

        # Default Jobtype is GET, Only S3 supports PUT type.
        src_credentials, des_credentials = {}, credentials
        if job_type == 'GET':
            src_credentials, des_credentials = des_credentials, src_credentials
    else:
        # no_auth will enable accessing S3 with no-sign-request
        no_auth = True
        src_credentials, des_credentials = {}, {}

    return src_credentials, des_credentials, no_auth


def get_env():
    """ Get General Job Info """
    env = collections.namedtuple(
        'JobBasis', 'job_table_name job_queue_name job_type source_type src_bucket_name \
                src_bucket_prefix dest_bucket_name dest_bucket_prefix default_storage_class')
    # read env info
    env.job_table_name = os.environ['JOB_TABLE_NAME']
    env.sqs_queue_name = os.environ['SQS_QUEUE_NAME']
    env.job_type = os.environ['JOB_TYPE'].upper()
    env.source_type = os.environ['SOURCE_TYPE']
    env.src_bucket_name = os.environ['SRC_BUCKET_NAME']
    env.src_bucket_prefix = os.environ['SRC_BUCKET_PREFIX']
    env.dest_bucket_name = os.environ['DEST_BUCKET_NAME']
    env.dest_bucket_prefix = os.environ['DEST_BUCKET_PREFIX']
    env.default_storage_class = os.environ['STORAGE_CLASS']

    return env


def get_finder_env():
    """ Get General Job Info for Finder"""
    env = collections.namedtuple(
        'JobBasis', 'job_table_name job_queue_name job_type source_type src_bucket_name \
                src_bucket_prefix dest_bucket_name dest_bucket_prefix default_storage_class')
    # read env info
    env.job_table_name = os.environ['JOB_TABLE_NAME']
    env.sqs_queue_name = os.environ['SQS_QUEUE_NAME']
    env.job_type = os.environ['JOB_TYPE'].upper()
    env.source_type = os.environ['SOURCE_TYPE']
    env.src_bucket_name = os.environ['SRC_BUCKET_NAME']
    env.src_bucket_prefix = os.environ['SRC_BUCKET_PREFIX']
    env.dest_bucket_name = os.environ['DEST_BUCKET_NAME']
    env.dest_bucket_prefix = os.environ['DEST_BUCKET_PREFIX']

    return env


class TimeoutOrMaxRetry(Exception):
    pass


class WrongRecordFormat(Exception):
    pass


def create_clients(type, env):
    ''' Returns a DownloadClient for Source and a Download/UploadClient for Destination '''

    ssm_parameter_credentials = os.environ['SSM_PARAMETER_CREDENTIALS']
    region_name = os.environ['REGION_NAME']

    # Get credentials and regions
    src_credentials, des_credentials, no_auth = get_credentials(
        ssm_parameter_credentials, env.job_type)
    src_region, des_region = get_regions(region_name, env.job_type)

    # Use ClientManager to create clients
    src_client = ClientManager.create_download_client(
        env.src_bucket_name, env.src_bucket_prefix, src_region, src_credentials, env.source_type, no_auth)

    if type == 'Finder':
        des_client = ClientManager.create_download_client(
            env.dest_bucket_name, env.dest_bucket_prefix, des_region, des_credentials)

    else:
        des_client = ClientManager.create_upload_client(
            env.dest_bucket_name, env.dest_bucket_prefix, des_region, des_credentials)

    return src_client, des_client


def get_config():
    ''' Returns migration_lib.config.JobConfig Object '''
    job_timeout = 870

    include_version = False
    multipart_threshold = int(os.environ['MULTIPART_THRESHOLD']) * 1024 * 1024
    chunk_size = int(os.environ['CHUNK_SIZE']) * 1024 * 1024
    max_threads = int(os.environ['MAX_THREADS'])

    return JobConfig(include_version=include_version,
                     job_timeout=job_timeout,
                     multipart_threshold=multipart_threshold,
                     chunk_size=chunk_size,
                     max_threads=max_threads)


def process_queue(src_client, des_client, config, env):
    sqs = SQSService(env.sqs_queue_name)
    job_table = DBService(env.job_table_name)

    # retry_total_time = 10
    retry_interval = 60

    # retry_time = retry_total_time

    while True:
        messages = sqs.receive_jobs(max_messages=MAX_NUMBER_OF_MESSAGES)

        if not messages:
            logger.info(
                f'SQS> No messages found, will retry after {retry_interval} seconds')
            time.sleep(retry_interval)
            # retry_time = retry_time - 1

            # if retry_time == 0:
            #     logger.info(
            #         f'SQS> No messages found after {retry_total_time} retries, process stopped')
            #     break
        # else:
        #     retry_time = retry_total_time

        for message in messages:
            job = json.loads(message['Body'])

            handler = message['ReceiptHandle']
            # logger.info(f'SQS> Received message: {job}')

            job['storage_class'] = env.default_storage_class
            job_info = JobInfo(**job)
            migrator = JobMigrator(src_client, des_client,
                                   config, job_table, job_info)

            status = migrator.start_migration()
            # logger.info(f'Migration Status is {status}')
            if not status:  # Migration is completed.
                logger.info('Delete Message')
                deleted = sqs.delete_job(handler)

                # if not deleted:
                #     time.sleep(30)
                #     deleted = sqs.delete_job(handler)


def find_and_send_jobs(src_client, des_client, env):
    sqs = SQSService(queue_name=env.sqs_queue_name)
    sqs_empty = sqs.is_empty()

    include_version = False

    # If job queue is not empty, no need to compare again.
    if sqs_empty:
        logger.info(
            'SQS Queue is empty, start comparing source and destination object list...')
        db = DBService(env.job_table_name)
        job_sender = JobSender(src_client, des_client, db, sqs)

        job_sender.send_jobs(include_version)
    else:
        logger.warning(
            'SQS Queue is not empty or fail to get_queue_attributes. This might because the last job have not completed. Stop processing.')
