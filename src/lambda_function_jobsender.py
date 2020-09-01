# PROJECT LONGBOW - JOBSENDER FOR COMPARE AMAZON S3 AND CREATE DELTA JOB LIST TO SQS

import json
import logging
import os
import ssl
import urllib.request
import urllib.error
from operator import itemgetter
from botocore.config import Config
import boto3

from migration_lib.client import S3DownloadClient, AliOSSDownloadClient
from migration_lib.service import SQSService, DBService
from migration_lib.job import JobFinder
from migration_lib.config import JobConfig

# Env
table_queue_name = os.environ['TABLE_QUEUE_NAME']
ssm_parameter_credentials = os.environ['SSM_PARAMETER_CREDENTIALS']
sqs_queue_name = os.environ['SQS_QUEUE_NAME']
src_bucket_name = os.environ['SRC_BUCKET_NAME']
src_bucket_prefix = os.environ['SRC_BUCKET_PREFIX']
dest_bucket_name = os.environ['DEST_BUCKET_NAME']
dest_bucket_prefix = os.environ['DEST_BUCKET_PREFIX']
job_type = os.environ['JOB_TYPE']
source_type = os.environ['SOURCE_TYPE']
max_retries = int(os.environ['MAX_RETRY'])
include_version = os.environ['INCLUDE_VERSION'].upper() == 'TRUE'

logger = logging.getLogger()
logger.setLevel(logging.INFO)

# Get credentials of the other account
ssm = boto3.client('ssm')
logger.info(f'Get ssm_parameter_credentials: {ssm_parameter_credentials}')
credentials = json.loads(ssm.get_parameter(
    Name=ssm_parameter_credentials,
    WithDecryption=True
)['Parameter']['Value'])

# Default Jobtype is GET, Only S3 supports PUT type.
src_credentials, des_credentials =  {}, credentials
if job_type.upper() == 'GET':
    src_credentials, des_credentials = des_credentials, src_credentials

# TODO Add an env var as source type. Valid options are ['S3', 'AliOSS', ...]
# source_type = 'S3'
if source_type == 'AliOSS':
    src_client = AliOSSDownloadClient(
        bucket_name=src_bucket_name, prefix=src_bucket_prefix, **src_credentials)
elif source_type == 'Qiniu':
    if 'endpoint_url' not in src_credentials:
        # if endpoint url is not provided, use region_name to create the endpoint url.
        if 'region_name' not in src_credentials:
            logger.warning(f'Cannot find Qiniu Region in SSM parameter {ssm_parameter_credentials}, default to cn-south-1')
            src_credentials['region_name'] = 'cn-south-1'
        endpoint_url = 'https://s3-{}.qiniucs.com'.format(src_credentials['region_name'])
        src_credentials['endpoint_url'] = endpoint_url
    
    src_client = S3DownloadClient(
        bucket_name=src_bucket_name, prefix=src_bucket_prefix, **src_credentials)
else:
    # Default to S3
    src_client = S3DownloadClient(
        bucket_name=src_bucket_name, prefix=src_bucket_prefix, **src_credentials)

des_client = S3DownloadClient(
    bucket_name=dest_bucket_name, prefix=dest_bucket_prefix, **des_credentials)

# handler
def lambda_handler(event, context):

    sqs = SQSService(queue_name=sqs_queue_name)

    sqs_empty = sqs.is_empty()

    # If job queue is not empty, no need to compare again.
    if sqs_empty:
        logger.info(
            'Job sqs queue is empty, now process comparing s3 bucket...')

        db = DBService(table_queue_name)
        job_finder = JobFinder(src_client, des_client, db)

        job_list = job_finder.find_jobs(include_version)

        if job_list:
            sqs.send_jobs(job_list)

        # TODO update this.
        # Upload jobs to sqs
        # if len(job_list) != 0:
        #     job_upload_sqs_ddb(
        #         sqs=sqs,
        #         sqs_queue=sqs_queue,
        #         job_list=job_list
        #     )
        #     max_object = max(job_list, key=itemgetter('Size'))
        #     MaxChunkSize = int(max_object['Size'] / 10000) + 1024
        #     if MaxChunkSize < 5 * 1024 * 1024:
        #         MaxChunkSize = 5 * 1024 * 1024
        #     logger.warning(f'Max object size is {max_object["Size"]}. Require AWS Lambda memory > '
        #                    f'MaxChunksize({MaxChunkSize}) x MaxThread(default: 1) x MaxParallelFile(default: 50)')
        # else:
        #     logger.info('Source list are all in Destination, no job to send.')

    else:
        logger.error(
            'Job sqs queue is not empty or fail to get_queue_attributes. Stop process.')
