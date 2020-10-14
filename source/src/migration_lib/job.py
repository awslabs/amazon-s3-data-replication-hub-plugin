import logging
import time
import base64
import boto3
import json

from migration_lib.client import DownloadClient, UploadClient, JobInfo
from migration_lib.config import JobConfig, MAX_PARTS
from migration_lib.service import DBService, SQSService
from migration_lib.processor import job_processor

from pathlib import PurePosixPath, Path

logger = logging.getLogger(__name__)


class JobSender():
    """ This class perform a role of find a list of delta objects by comparing the source and destination bucket,
    then send the list to SQS

    Example Usage:
        job_sender = JobSender(src_oss_client, des_s3_client)
        job_finder.send_jobs()

    """

    def __init__(self, src_client: DownloadClient, des_client: DownloadClient, db: DBService, sqs: SQSService):
        super().__init__()
        self._src_client = src_client
        self._des_client = des_client
        self._db = db
        self._sqs = sqs

    def _get_source_set(self, src_list_gen, include_version):
        # logger.info(
        #     f'JobSender> list source bucket: {self._src_client.bucket_name}')
        try:
            src_list = next(src_list_gen)
            if include_version:
                src_file_set = set([(obj.key, obj.size, obj.version)
                                    for obj in src_list])
            else:
                src_file_set = set([(obj.key, obj.size)
                                    for obj in src_list])
            return src_file_set
        except StopIteration:
            return None

    def _get_target_set(self, des_list_gen, include_version):
        # logger.info(
        #     f'JobSender> list destination bucket: {self._des_client.bucket_name}')
        # There is no need to check the version from destination bucket.
        # always listed without version.
        if include_version:
            # TODO: Get versions from DynamoDB and update the des_list with version info.
            # TODO: Check performance issue here.
            pass
        start = time.time()
        result = set()
        for des_list in des_list_gen:
            for obj in des_list:
                result.add(
                    (remove_prefix(obj.key, self._des_client.prefix), obj.size))
        end = time.time()
        logger.info(
            f'JobSender> Time elapsed in getting full destination list is {end-start} seconds')
        return result

    def _get_delta_and_send(self, include_version=False):
        src_list_gen = self._src_client.list_objects(
            include_version=include_version)
        des_list_gen = self._des_client.list_objects(include_version=False)

        des_file_set = self._get_target_set(des_list_gen, include_version)
        # logger.info(f'JobSender> Destination list: {des_file_set}')

        # Get Delta list.
        logger.info(
            f'JobSender> Start comparing...')
        start_time = int(time.time())

        while True:
            src_file_set = self._get_source_set(src_list_gen, include_version)
            # no more file in src.
            if not src_file_set:
                break

            # Use Set difference() to get the delta
            delta = src_file_set - des_file_set

            # if has delta
            if delta:
                job_list = []
                logger.info(
                    f'JobSender> Get a delta list of {len(delta)}, start sending...')
                for src in delta:
                    Des_key = str(PurePosixPath(
                        self._des_client.prefix) / src[0])

                    # TODO Check do we need this?
                    if src[0][-1] == '/':  # for dir
                        Des_key += '/'

                    version = src[2] if include_version else 'null'
                    job_list.append(
                        {
                            "key": src[0],
                            "size": src[1],
                            "version": version,
                        }
                    )
                self._sqs.send_jobs(job_list)
        spent_time = int(time.time()) - start_time
        if include_version:
            logger.info(
                f'JobSender> Job completed in {spent_time} seconds (include_version is enabled)')
        else:
            logger.info(
                f'JobSender> Job completed in {spent_time} seconds (include_version is disabled)')

    def send_jobs(self, include_version=False):
        self._get_delta_and_send(include_version)


class JobMigrator():
    """ This class is used to migrate an object from the source to the destination. 

    If the object size is too big, it will automatically use multiple part upload.

    Example Usage:
        migrator = JobMigrator(s3c_oss_client, des_s3_client, config, job, table_name)
        migrator.start_migration()

    """

    def __init__(self, src_client: DownloadClient, des_client: UploadClient,
                 config: JobConfig, db: DBService, job: JobInfo, instance_id: str):
        super().__init__()

        self._src_client = src_client
        self._des_client = des_client
        self._config = config
        self._job = job
        self._db = db
        self._instance_id = instance_id
        self._des_key = append_prefix(self._job.key, self._des_client.prefix)

    def _migration_small_file(self, **extra_args):
        logger.info(
            f"Migrator> Migrating small file {self._job.key}")

        upload_etag_full = ''
        err = ''
        try:
            # Get object from client, upload Object to destination.
            logger.info(
                f'----->Downloading {self._job.size} Bytes {self._src_client.bucket_name}/{self._job.key}')
            body, body_md5 = self._src_client.get_object(
                self._job.key, self._job.size)
            content_md5 = base64.b64encode(
                body_md5.digest()).decode('utf-8')
            logger.info(
                f'----->Uploading {self._job.size} Bytes {self._src_client.bucket_name}/{self._des_key}')

            upload_etag_full = self._des_client.upload_object(
                self._des_key, body, content_md5, self._job.storage_class, **extra_args)

            logger.info(
                f'----->Complete {self._job.size} Bytes {self._src_client.bucket_name}/{self._des_key}')
        except Exception as e:
            logger.error(
                f'Migrator> Unexpected error during migration of small file - {str(e)}')
            err = str(e)

        return upload_etag_full, err

    def _migration_big_file(self, **extra_args):
        logger.info(
            f"Migrator> Migrating big file {self._job.key}")

        upload_id, part_list = self._start_multipart_upload(**extra_args)
        # logger.info(f'Resume upload id: {upload_id}')

        upload_etag_full = self._parallel_upload(upload_id, part_list)

        if upload_etag_full in ["TIMEOUT", "ERR", "QUIT"]:
            return '', 'Failed in Parallel Upload - {}'.format(upload_etag_full)

        complete_etag, err = self._complete_upload(upload_id)

        if self._config.verify_md5_twice and upload_etag_full != "QUIT":
            # TODO implement verify_md5_twice
            # ... if doesn't match, resumit
            pass

        return complete_etag, err

    def start_migration(self):
        logger.info("Migrator> Start a migration Job")

        src_bucket = self._src_client.bucket_name
        src_prefix = self._src_client.prefix
        des_bucket = self._des_client.bucket_name
        des_prefix = self._des_client.prefix

        logger.info(
            f"Migrator> Migrating from {src_bucket}/{src_prefix}/{self._job.key} to {des_bucket}/{des_prefix}/{self._job.key}")

        extra_args = {}
        if self._config.include_metedata:

            extra_args = self._src_client.head_object(self._job.key)
            logger.info(
                f"Migrator> Get extra metadata info for {extra_args}")

        # if self._config.log_to_db:
        logger.info(f'Migrator> Log into DB')
        self._db.log_job_start(src_bucket, src_prefix, des_bucket, des_prefix,
                               self._job, self._instance_id, extra_args)

        if self._job.size <= self._config.multipart_threshold:
            etag, status = self._migration_small_file(**extra_args)
        else:
            etag, status = self._migration_big_file(**extra_args)

        logger.info(f'Migrator> Complete load into DB')
        self._db.log_job_end(src_bucket, self._job.key, etag, status)

    def _split(self, size, chunk_size, max_parts=MAX_PARTS):
        """ Split the file into parts, automatically adjust the chunk size as there is limit of maximum parts"""
        part_number = 1
        index_list = [0]
        if int(size / chunk_size) + 1 > max_parts:
            chunk_size = int(size / max_parts) + 1024
            logger.info(
                f'Size excess {max_parts} parts limit. Auto change ChunkSize to {chunk_size}')
        while chunk_size * part_number < size:
            index_list.append(chunk_size * part_number)
            part_number += 1
        return index_list, chunk_size

    def _start_multipart_upload(self, **extra_args):
        """ Firstly, check if an upload ID already exists for the key. 

            * if yes:
                Get the list of parts uploaded and return the list of parts and uploadID

            * if not: 
                Initialize the multiple upload process to generate an uploadID and return.
        """

        logger.info(
            f"Migrator> Try get or create a new upload ID for multipart load")

        # try finding existing upload ID and parts.
        uploaded_list = self._des_client.list_multipart_uploads(self._des_key)
        # if exists
        if uploaded_list:
            if self._config.clean_unfinished_upload:
                logger.info("Migrator> Clean unfinished uploads")
                self._des_client.clean_unfinished_unload(uploaded_list)

            else:
                upload_id = uploaded_list[0]['UploadId']
                part_list = self._des_client.list_parts(
                    self._des_key, upload_id)
                part_numbers = [p['PartNumber'] for p in part_list]

                return upload_id, part_numbers

        response_new_upload = self._des_client.create_multipart_upload(
            self._des_key,
            self._job.storage_class,
            **extra_args
        )

        return response_new_upload, []

    def _parallel_upload(self, upload_id, part_list):
        logger.info(
            f"Migrator> Start Uploading ...{upload_id} in Parallel")

        index_list, chunk_size_auto = self._split(
            self._job.size,
            self._config.chunk_size
        )

        logger.info(
            f'Migrator> Index List: {index_list}, chunk size: {chunk_size_auto}')

        job_dict = {'Key': self._job.key, 'DesKey': self._des_key,
                    'Size': self._job.size, 'Version': self._job.version}

        # TODO Change to return two values (status, etag)
        upload_etag_full = job_processor(
            upload_id=upload_id,
            index_list=index_list,
            partnumber_list=part_list,
            job=job_dict,
            src_client=self._src_client,
            des_client=self._des_client,
            max_thread=self._config.max_threads,
            chunk_size=chunk_size_auto,
            max_retry=self._config.max_retries,
            job_timeout=self._config.job_timeout,
            verify_md5_twice=self._config.verify_md5_twice,
            include_version=self._config.include_version
        )

        if upload_etag_full == "TIMEOUT" or upload_etag_full == "QUIT":
            # TODO update this
            logger.warning(
                f'Migrator> Quit job upload_etag_full == {upload_etag_full} - {self._job.key}')

        return upload_etag_full

    def _complete_upload(self, upload_id):
        logger.info(f"Migrator> Complete Upload...{upload_id}")
        complete_etag = ''
        try:
            complete_etag = self._des_client.complete_multipart_upload(
                self._des_key, upload_id)
            # if not complete_etag:
            #     logger.error(f'complete_etag ERR - {self._job.key}')

        except Exception as e:
            logger.error(
                f'Migrator> Fail to complete upload for {self._des_key}')

            # if unable to merge the upload. Clean all the parts.
            # The job will be restarted in the next run.
            logger.error(
                f'Migrator> Clean uploaded parts for upload id: {upload_id}')
            upload_list = [{'Key': self._des_key, 'UploadId': upload_id}]
            self._des_client.clean_unfinished_unload(upload_list)
            return complete_etag, str(e)

        return complete_etag, ''


def remove_prefix(key: str, prefix=''):
    ''' helper function to remove prefix from key path

    for example remove_prefix('a/b/c/d', 'a/b') = 'c/d'
    '''
    return key.replace(prefix+'/', '') if prefix else key


def append_prefix(key: str, prefix=''):
    ''' helper function to append prefix from key path

    for example append_prefix('c/d', 'a/b') = 'a/b/c/d'
    '''
    return '{}/{}'.format(prefix, key) if prefix else key
