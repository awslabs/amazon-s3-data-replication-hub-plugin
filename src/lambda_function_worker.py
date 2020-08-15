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


from migration_lib.job import JobMigrator, JobFinder
from migration_lib.service import SQSService, DBService
from migration_lib.client import S3DownloadClient, AliOSSDownloadClient, S3UploadClient, JobInfo
from migration_lib.config import JobConfig

# Env
table_queue_name = os.environ['table_queue_name']
default_storage_class = os.environ['StorageClass']

# TODO: update lambda env
# try:
#     Des_bucket_default = os.environ['DEST_BUCKET']
#     Des_prefix_default = os.environ['DEST_BUCKET_PREFIX']
# except Exception as e:
#     print('No Env DEST_BUCKET/DEST_BUCKET_PREFIX ', e)
#     Des_bucket_default, Des_prefix_default = "", ""

src_bucket_name = os.environ['SRC_BUCKET_NAME']
src_bucket_prefix = os.environ['SRC_BUCKET_PREFIX']
dest_bucket_name = os.environ['DEST_BUCKET_NAME']
dest_bucket_prefix = os.environ['DEST_BUCKET_PREFIX']
ssm_parameter_credentials = os.environ['ssm_parameter_credentials']
checkip_url = os.environ['checkip_url']
job_type = os.environ['JobType']
source_type = os.environ['SOURCE_TYPE']
max_retries = int(os.environ['MaxRetry'])
max_threads = int(os.environ['MaxThread'])
max_parallel_file = int(os.environ['MaxParallelFile'])  # Not used in lambda
job_timeout = int(os.environ['JobTimeout'])
# UpdateVersionId = os.environ['UpdateVersionId'].upper() == 'TRUE'  # get lastest version id from s3 before get object
# GetObjectWithVersionId = os.environ['GetObjectWithVersionId'].upper() == 'TRUE'  # get object with version id
include_version = False  # not ready yet.

# Below are moved into migration_lib.config
# ResumableThreshold = 5 * 1024 * 1024  # Accelerate to ignore small file
# CleanUnfinishedUpload = False  # For debug
# ChunkSize = 5 * 1024 * 1024  # For debug, will be auto-change
# ifVerifyMD5Twice = False  # For debug

logger = logging.getLogger()
logger.setLevel(logging.INFO)


# Get connection credentials
ssm = boto3.client('ssm')
logger.info(f'Get ssm_parameter_credentials: {ssm_parameter_credentials}')
credentials = json.loads(ssm.get_parameter(
    Name=ssm_parameter_credentials,
    WithDecryption=True
)['Parameter']['Value'])

# Default Jobtype is GET, Only S3 supports PUT type.
src_credentials, des_credentials = credentials, {}
if job_type.upper() == 'PUT':
    src_bucket_name, src_bucket_prefix, dest_bucket_name, dest_bucket_prefix = dest_bucket_name, \
        dest_bucket_prefix, src_bucket_name, src_bucket_prefix
    src_credentials, des_credentials = des_credentials, src_credentials

# TODO Add an env var as source type. Valid options are ['S3', 'AliOSS', ...]
# source_type = 'S3'
if source_type == 'AliOSS':
    src_client = AliOSSDownloadClient(
        bucket_name=src_bucket_name, prefix=src_bucket_prefix, **src_credentials)
else:
    # Default to S3
    src_client = S3DownloadClient(
            bucket_name=src_bucket_name, prefix=src_bucket_prefix, **src_credentials)

des_client = S3UploadClient(
            bucket_name=dest_bucket_name, prefix=dest_bucket_prefix, **des_credentials)

try:
    context = ssl.SSLContext(ssl.PROTOCOL_TLS)
    response = urllib.request.urlopen(
        urllib.request.Request(checkip_url), timeout=3, context=context
    ).read()
    instance_id = "lambda-" + response.decode('utf-8')
except urllib.error.URLError as e:
    logger.warning(f'Fail to connect to checkip api: {checkip_url} - {str(e)}')
    instance_id = 'lambda-ip-timeout'


class TimeoutOrMaxRetry(Exception):
    pass


class WrongRecordFormat(Exception):
    pass


def lambda_handler(event, context):
    print("Lambda or NAT IP Address:", instance_id)
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

        # TODO Check if message is from S3? why?
        # if 'Records' in job:  # S3 message contains 'Records'
        #     for One_record in job['Records']:
        #         if 's3' in One_record:
        #             Src_bucket = One_record['s3']['bucket']['name']
        #             Src_key = One_record['s3']['object']['key']
        #             Src_key = urllib.parse.unquote_plus(Src_key)  # 加号转回空格
        #             Size = One_record['s3']['object']['size']
        #             ...

        if 'key' not in job:  # Invaid message.
            logger.warning(f'Wrong sqs job: {json.dumps(job, default=str)}')
            logger.warning('Try to handle next message')
            raise WrongRecordFormat

        job['storage_class'] = default_storage_class

        jobinfo = JobInfo(**job)
        config = JobConfig(include_version=include_version,
                           job_timeout=job_timeout)
        db = DBService(table_queue_name)
        migrator = JobMigrator(src_client, des_client,
                               config, db, jobinfo, instance_id)

        migrator.start_migration()

        # TODO update with more exceptional handling.
        # if upload_etag_full != "TIMEOUT" and upload_etag_full != "ERR":
        #     ...
        # else:
        #     raise TimeoutOrMaxRetry

    return {
        'statusCode': 200,
        'body': 'Jobs completed'
    }
