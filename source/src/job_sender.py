import os
import logging
import boto3
import json
import migration_lib

from migration_lib.job import JobMigrator, JobSender
from migration_lib.service import SQSService, DBService
from migration_lib.client import S3DownloadClient, AliOSSDownloadClient


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


def create_client(bucket_name, prefix, credentials, client_type='S3'):
    if client_type == 'AliOSS':
        client = AliOSSDownloadClient(
            bucket_name=bucket_name, prefix=prefix, **credentials)
    elif client_type == 'Qiniu':
        if 'endpoint_url' not in credentials:
            # if endpoint url is not provided, use region_name to create the endpoint url.
            if 'region_name' not in credentials:
                logger.warning(
                    f'Cannot find Qiniu Region in SSM parameter {ssm_parameter_credentials}, default to cn-south-1')
                src_credentials['region_name'] = 'cn-south-1'
            endpoint_url = 'https://s3-{}.qiniucs.com'.format(
                src_credentials['region_name'])
            src_credentials['endpoint_url'] = endpoint_url

        client = S3DownloadClient(
            bucket_name=bucket_name, prefix=prefix, **credentials)
    else:
        client = S3DownloadClient(
            bucket_name=bucket_name, prefix=prefix, **credentials)
    return client


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
    des_bucket_name = os.environ['DEST_BUCKET_NAME']
    des_bucket_prefix = os.environ['DEST_BUCKET_PREFIX']
    job_type = os.environ['JOB_TYPE']
    source_type = os.environ['SOURCE_TYPE']
    max_retries = int(os.environ['MAX_RETRY'])
    include_version = os.environ['INCLUDE_VERSION'].upper() == 'TRUE'

    credentials = get_credentials()
    src_credentials, des_credentials = {}, credentials
    if job_type.upper() == 'GET':
        src_credentials, des_credentials = des_credentials, src_credentials

    src_client = create_client(
        src_bucket_name, src_bucket_prefix, src_credentials, source_type)
    des_client = create_client(
        des_bucket_name, des_bucket_prefix, des_credentials)

    find_and_send_jobs(src_client, des_client, sqs_queue_name, table_queue_name, include_version)
