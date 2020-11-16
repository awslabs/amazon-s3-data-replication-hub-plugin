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


def get_credentials():
    ssm = boto3.client('ssm')
    logger.info(f'Get ssm_parameter_credentials: {ssm_parameter_credentials}')
    credentials = json.loads(ssm.get_parameter(
        Name=ssm_parameter_credentials,
        WithDecryption=True
    )['Parameter']['Value'])

    return credentials


def find_and_send_jobs(src_client, des_client, queue_name, table_name, include_version=False):
    sqs = SQSService(queue_name=queue_name)
    sqs_empty = sqs.is_empty()

    # If job queue is not empty, no need to compare again.
    if sqs_empty:
        logger.info(
            'Job sqs queue is empty, now process comparing s3 bucket...')
        db = DBService(table_name)
        job_sender = JobSender(src_client, des_client, db, sqs)

        job_sender.send_jobs(include_version)
    else:
        logger.error(
            'Job sqs queue is not empty or fail to get_queue_attributes. Stop process.')


if __name__ == "__main__":
    logger.info('Start Finding Jobs')
    logger.info(migration_lib.__version__)

    ssm_parameter_credentials = os.environ['SSM_PARAMETER_CREDENTIALS']
    table_queue_name = os.environ['TABLE_QUEUE_NAME']
    sqs_queue_name = os.environ['SQS_QUEUE_NAME']
    src_bucket_name = os.environ['SRC_BUCKET_NAME']
    src_bucket_prefix = os.environ['SRC_BUCKET_PREFIX']
    dest_bucket_name = os.environ['DEST_BUCKET_NAME']
    dest_bucket_prefix = os.environ['DEST_BUCKET_PREFIX']
    job_type = os.environ['JOB_TYPE']
    source_type = os.environ['SOURCE_TYPE']
    # include_version = os.environ['INCLUDE_VERSION'].upper() == 'TRUE'
    include_version = True
    credentials = get_credentials()
    # Region name will not be part of credentials in the future.
    region_name = credentials.pop('region_name')

    src_credentials, des_credentials = {}, credentials
    src_region, des_region = '', region_name
    if job_type.upper() == 'GET':
        src_credentials, des_credentials = des_credentials, src_credentials
        src_region, des_region = des_region, src_region

    src_client = ClientManager.create_download_client(
        src_bucket_name, src_bucket_prefix, src_region, src_credentials, source_type)
    des_client = ClientManager.create_download_client(
        dest_bucket_name, dest_bucket_prefix, des_region, des_credentials)

    find_and_send_jobs(src_client, des_client, sqs_queue_name,
                       table_queue_name, include_version)
