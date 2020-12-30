import os
import logging
import boto3
import json
import migration_lib

from migration_lib.job import JobMigrator, JobSender
from migration_lib.service import SQSService, DBService
from migration_lib.client import ClientManager


log_level = str(os.environ.get('LOG_LEVEL')).upper()
if log_level not in ['DEBUG', 'INFO', 'WARNING', 'ERROR', 'CRITICAL']:
    log_level = 'WARNING'

logging.basicConfig(format='%(levelname)s:%(message)s', level=log_level)
logger = logging.getLogger()
logger.info("The log level is %s", log_level)


def find_and_send_jobs(src_client, des_client, queue_name, table_name, include_version=False):
    sqs = SQSService(queue_name=queue_name)
    sqs_empty = sqs.is_empty()

    # If job queue is not empty, no need to compare again.
    if sqs_empty:
        logger.info(
            'SQS Queue is empty, start comparing source and destination object list...')
        db = DBService(table_name)
        job_sender = JobSender(src_client, des_client, db, sqs)

        job_sender.send_jobs(include_version)
    else:
        logger.warning(
            'SQS Queue is not empty or fail to get_queue_attributes. This might because the last job have not completed. Stop processing.')


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
        logger.debug(
            f'Get ssm_parameter_credentials: {ssm_parameter_credentials}')
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


def init_client():
    ''' Returns a DownloadClient for Source and a UploadClient for Destination '''
    # read env info
    job_type = os.environ['JOB_TYPE'].upper()
    source_type = os.environ['SOURCE_TYPE']
    src_bucket_name = os.environ['SRC_BUCKET_NAME']
    src_bucket_prefix = os.environ['SRC_BUCKET_PREFIX']
    dest_bucket_name = os.environ['DEST_BUCKET_NAME']
    dest_bucket_prefix = os.environ['DEST_BUCKET_PREFIX']
    ssm_parameter_credentials = os.environ['SSM_PARAMETER_CREDENTIALS']
    region_name = os.environ['REGION_NAME']

    # Get credentials and regions
    src_credentials, des_credentials, no_auth = get_credentials(
        ssm_parameter_credentials, job_type)
    src_region, des_region = get_regions(region_name, job_type)

    # Use ClientManager to create clients
    src_client = ClientManager.create_download_client(
        src_bucket_name, src_bucket_prefix, src_region, src_credentials, source_type, no_auth)
    des_client = ClientManager.create_download_client(
        dest_bucket_name, dest_bucket_prefix, des_region, des_credentials)

    return src_client, des_client


if __name__ == "__main__":
    logger.info('Start Finding Jobs')
    logger.info(migration_lib.__version__)

    job_table_name = os.environ['JOB_TABLE_NAME']
    sqs_queue_name = os.environ['SQS_QUEUE_NAME']

    include_version = False
    src_client, des_client = init_client()
    find_and_send_jobs(src_client, des_client, sqs_queue_name,
                       job_table_name, include_version)
