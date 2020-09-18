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

from migration_lib.client import ClientManager
from migration_lib.service import SQSService, DBService
from migration_lib.job import JobSender
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
src_credentials, des_credentials = {}, credentials
if job_type.upper() == 'GET':
    src_credentials, des_credentials = des_credentials, src_credentials

src_client = ClientManager.create_download_client(src_bucket_name, src_bucket_prefix, src_credentials, source_type)
des_client = ClientManager.create_download_client(dest_bucket_name, dest_bucket_prefix, des_credentials)

# handler
def lambda_handler(event, context):

    sqs = SQSService(queue_name=sqs_queue_name)
    sqs_empty = sqs.is_empty()

    # If job queue is not empty, no need to compare again.
    if sqs_empty:
        logger.info(
            'Job sqs queue is empty, now process comparing s3 bucket...')

        db = DBService(table_queue_name)
        job_sender = JobSender(src_client, des_client, db, sqs)
        job_sender.send_jobs(include_version)
    else:
        logger.error(
            'Job sqs queue is not empty or fail to get_queue_attributes. Stop process.')
