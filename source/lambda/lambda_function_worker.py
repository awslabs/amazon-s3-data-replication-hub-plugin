# AWS LAMBDA WORKER NODE FOR TRANSMISSION

import json
import logging
import os
import ssl
import urllib
import urllib.error
import urllib.parse
import urllib.request
from pathlib import PurePosixPath

import boto3
from botocore.config import Config


from migration_lib.job import JobMigrator
from migration_lib.service import DBService
from migration_lib.client import ClientManager, JobInfo
from migration_lib.config import JobConfig

# Env
job_timeout = 870
include_version = True
table_queue_name = os.environ['TABLE_QUEUE_NAME']
default_storage_class = os.environ['STORAGE_CLASS']
src_bucket_name = os.environ['SRC_BUCKET_NAME']
src_bucket_prefix = os.environ['SRC_BUCKET_PREFIX']
dest_bucket_name = os.environ['DEST_BUCKET_NAME']
dest_bucket_prefix = os.environ['DEST_BUCKET_PREFIX']
ssm_parameter_credentials = os.environ['SSM_PARAMETER_CREDENTIALS']
job_type = os.environ['JOB_TYPE']
source_type = os.environ['SOURCE_TYPE']
multipart_threshold = int(os.environ['MULTIPART_THRESHOLD']) * 1024 * 1024
chunk_size = int(os.environ['CHUNK_SIZE']) * 1024 * 1024
max_threads = int(os.environ['MAX_THREADS'])


log_level = str(os.environ.get('LOG_LEVEL')).upper()
if log_level not in ['DEBUG', 'INFO', 'WARNING', 'ERROR', 'CRITICAL']:
    log_level = 'INFO'

# logging.basicConfig(level=log_level)
logger = logging.getLogger()
# logger.setLevel(logging.INFO)
logger.setLevel(log_level)


# Get connection credentials
ssm = boto3.client('ssm')
logger.info(f'Get ssm_parameter_credentials: {ssm_parameter_credentials}')
credentials = json.loads(ssm.get_parameter(
    Name=ssm_parameter_credentials,
    WithDecryption=True
)['Parameter']['Value'])

# Region name will not be part of credentials in the future.
region_name = credentials.pop('region_name')

# Default Jobtype is GET, Only S3 supports PUT type.
src_credentials, des_credentials = {}, credentials
src_region, des_region = '', region_name
if job_type.upper() == 'GET':
    src_credentials, des_credentials = des_credentials, src_credentials
    src_region, des_region = des_region, src_region

# if src_credentials:
#     src_region = src_credentials
src_client = ClientManager.create_download_client(
    src_bucket_name, src_bucket_prefix, src_region, src_credentials, source_type)
des_client = ClientManager.create_upload_client(
    dest_bucket_name, dest_bucket_prefix, des_region, des_credentials)

# try:
#     context = ssl.SSLContext(ssl.PROTOCOL_TLS)
#     response = urllib.request.urlopen(
#         urllib.request.Request(checkip_url), timeout=3, context=context
#     ).read()
#     instance_id = "lambda-" + response.decode('utf-8')
# except urllib.error.URLError as e:
#     logger.warning(f'Fail to connect to checkip api: {checkip_url} - {str(e)}')
#     instance_id = 'lambda-ip-timeout'


class TimeoutOrMaxRetry(Exception):
    pass


class WrongRecordFormat(Exception):
    pass


def lambda_handler(event, context):
    logger.info(json.dumps(event, default=str))

    for trigger_record in event['Records']:
        trigger_body = trigger_record['body']
        job = json.loads(trigger_body)
        logger.info(json.dumps(job, default=str))

        # First message is a test message only, no need to process.
        if 'Event' in job:
            if job['Event'] == 's3:TestEvent':
                logger.info('Skip s3:TestEvent')
                continue

        if 'key' not in job:  # Invaid message.
            logger.warning(f'Wrong sqs job: {json.dumps(job, default=str)}')
            logger.warning('Try to handle next message')
            raise WrongRecordFormat

        job['storage_class'] = default_storage_class

        jobinfo = JobInfo(**job)
        config = JobConfig(include_version=include_version,
                           job_timeout=job_timeout,
                           multipart_threshold=multipart_threshold,
                           chunk_size=chunk_size,
                           max_threads=max_threads)
        db = DBService(table_queue_name)
        migrator = JobMigrator(src_client, des_client,
                               config, db, jobinfo)

        migrator.start_migration()

    return {
        'statusCode': 200,
        'body': 'Jobs completed'
    }
