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

log_level = str(os.environ.get('LOG_LEVEL')).upper()
if log_level not in ['DEBUG', 'INFO', 'WARNING', 'ERROR', 'CRITICAL']:
    log_level = 'INFO'

logger = logging.getLogger()
logger.setLevel(log_level)


def lambda_handler(event, context):
    logger.debug(json.dumps(event, default=str))

    job_table_name = os.environ['JOB_TABLE_NAME']
    event_table_name = os.environ['EVENT_TABLE_NAME']
    default_storage_class = os.environ['STORAGE_CLASS']

    src_client, des_client = init_client()

    for record in event['Records']:
        body = record['body']
        message = json.loads(body)
        logger.info(json.dumps(message, default=str))

        # Store a list of objects to be transferred
        transfer_list, delete_list = [], []

        # First message is a test message only, no need to process.
        if 'Event' in message:
            if message['Event'] == 's3:TestEvent':
                logger.info('Skip s3:TestEvent')
                continue

        if 'Records' in message:  # S3 Events
            event_table = DBService(event_table_name)
            transfer_list, delete_list = process_events(message, event_table)

        else:
            if 'key' not in message:  # Invaid message.
                logger.warning(
                    f'Invalid Job Info: {json.dumps(message, default=str)}')
                raise WrongRecordFormat
            else:
                transfer_list.append(message)

        # If transfer list is not empty .
        if transfer_list:
            logger.debug(transfer_list)

            config = get_config()
            job_table = DBService(job_table_name)

            for job in transfer_list:
                job['storage_class'] = default_storage_class
                job_info = JobInfo(**job)
                migrator = JobMigrator(src_client, des_client,
                                       config, job_table, job_info)

                migrator.start_migration()
        else:
            logger.info('No Objects to be transferred.')

        # If delete list is not empty.
        if delete_list:
            logger.info(f'A list of objects to be deleted: {delete_list}')

            for key in delete_list:
                key = '{}/{}'.format(des_client.prefix,
                                     key) if des_client.prefix else key
                des_client.delete_object(key)

    return {
        'statusCode': 200,
        'body': 'Jobs completed'
    }


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
    des_client = ClientManager.create_upload_client(
        dest_bucket_name, dest_bucket_prefix, des_region, des_credentials)

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


def process_events(event_message, event_table):
    ''' Returns a list of jobs to be transferred and deleted based on event messages 

    Transfer list in a format of 
    [{'key': key, 'size': size, 'version': version}, ... ]

    Delete List in a format of 
    [key1, key2 ...]
    '''

    logger.debug(f'process event: {event_message}')

    size = len(event_message['Records'])
    logger.debug(f'Size of event: {size}')

    transfer_list, delete_list = [], []
    for record in event_message['Records']:
        if 's3' in record:
            # bucket = One_record['s3']['bucket']['name']
            # logger.debug(bucket)
            key = record['s3']['object']['key']
            # unquote and also replace plus signs with spaces
            key = urllib.parse.unquote_plus(key)
            logger.debug(key)

            sequencer = record['s3']['object']['sequencer']
            logger.debug(sequencer)

            valid_event = event_table.check_sequencer(key, sequencer)

            if not valid_event:
                # No need to process this message is check_sequencer returns False
                continue

            event_type = record['eventName']
            if 'ObjectRemoved' in event_type:
                logger.info(f'Delete Event Found {event_type}')
                # des_client.delete_object(key)
                delete_list.append(key)

            else:
                # assert 'ObjectCreated' in event_type
                size = record['s3']['object']['size']
                logger.debug(size)

                if "versionId" in record['s3']['object']:
                    version = record['s3']['object']['versionId']
                else:
                    version = 'null'

                transfer_list.append(
                    {'key': key, 'size': size, 'version': version})
        else:
            logger.warning(
                f'Cannot find S3 Object info. unknown message format: {json.dumps(job, default=str)}')
            logger.warning('Try to handle next message')
            raise WrongRecordFormat

    return transfer_list, delete_list


class TimeoutOrMaxRetry(Exception):
    pass


class WrongRecordFormat(Exception):
    pass
