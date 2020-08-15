import logging
import time
import base64
import boto3
import json

from migration_lib.client import DownloadClient, UploadClient, JobInfo
from migration_lib.config import JobConfig, MAX_PARTS
from migration_lib.service import DBService
from migration_lib.processor import job_processor

from pathlib import PurePosixPath, Path

logger = logging.getLogger(__name__)


class JobFinder():
    """ This class perform a role of find a list of delta objects by comparing the source and destination bucket 

    Example Usage:
        job_finder = JobFinder(src_oss_client, des_s3_client)
        job_list = job_finder.find_jobs()
        print(job_list)  

    """

    def __init__(self, src_client: DownloadClient, des_client: DownloadClient, db: DBService):
        super().__init__()
        self._src_client = src_client
        self._des_client = des_client
        self._db = db

    def _get_source_list(self, include_version):
        # logger.info(
        #     f'JobFinder> list source bucket: {self._src_client.bucket_name}')
        src_list = self._src_client.list_objects(include_version)

        # Convert object into a tuple (key, size, version)
        result = []
        for obj in src_list:
            result.append((obj.key, obj.size, obj.version))
        return result

    def _get_target_list(self, include_version):
        # logger.info(
        #     f'JobFinder> list destination bucket: {self._des_client.bucket_name}')
        # There is no need to check the version from destination bucket.
        # always listed without version.
        des_list = self._des_client.list_objects(include_version=False)
        if include_version:
            # TODO: Get versions from DynamoDB and update the des_list with version info.
            # TODO: Check performance issue here.
            pass

        # Convert object into a tuple (key, size, version)
        result = []
        for obj in des_list:
            result.append((obj.key, obj.size, obj.version))
        return result

    def _get_delta_list(self, include_version=False):
        src_file_list = self._get_source_list(include_version)
        logger.info(f'JobFinder> Source list: {src_file_list}')
        des_file_list = self._get_target_list(include_version)
        logger.info(f'JobFinder> Destination list: {des_file_list}')
        # Get Delta list.
        logger.info(
            f'JobFinder> Start comparing...')
        start_time = int(time.time())
        job_list = []

        for src in src_file_list:
            # if exists in destination, do nothing.
            if src in des_file_list:
                continue
            # else append that into the output list.
            else:
                Des_key = str(PurePosixPath(
                    self._des_client.prefix) / src[0])

                # TODO Check do we need this?
                if src[0][-1] == '/':  # for dir
                    Des_key += '/'

                job_list.append(
                    {
                        "key": src[0],
                        "size": src[1],
                        "version": src[2],
                    }
                )
        spent_time = int(time.time()) - start_time
        if include_version:
            logger.info(
                f'JobFinder> Finish compare key/size/versionId in {spent_time} Seconds (include_version is enable)')
        else:
            logger.info(
                f'JobFinder> Finish compare key/size in {spent_time} Seconds (include_version is disable)')

        logger.info(f'JobFinder> Get Job List {len(job_list)}')
        return job_list

    def find_jobs(self, include_version=False):
        return self._get_delta_list(include_version)


class JobMigrator():
    """ This class perform a role of find a list of delta objects by comparing the source and destination bucket 

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

    def _migration_small_file(self, **extra_args):
        logger.info(
            f"Migrator> Migrating small file {self._job.key}")

        # Get object from client, upload Object to destination.
        body, body_md5 = self._src_client.get_object(self._job.key, 0, -1)
        content_md5 = base64.b64encode(
            body_md5.digest()).decode('utf-8')

        upload_etag_full = self._des_client.upload_object(
            self._job.key, body, content_md5, self._job.storage_class, **extra_args)

        logger.info(
            f'Migrator> Complete migration of small file {upload_etag_full}')

        status = 'DONE'
        return upload_etag_full, status

    def _migration_big_file(self, **extra_args):
        logger.info(
            f"Migrator> Migrating big file {self._job.key}")

        upload_id, part_list = self._start_multipart_upload(**extra_args)
        # logger.info(f'Resume upload id: {upload_id}')

        self._parallel_upload(upload_id, part_list)

        upload_etag_full = self._complete_upload(upload_id)

        if self._config.verify_md5_twice and upload_etag_full != "QUIT":
            # TODO implement verify_md5_twice
            # ... if doesn't match, resumit
            pass

        # TODO update this.
        if upload_etag_full not in ["TIMEOUT", "ERR", "QUIT"]:
            status = "DONE"
        else:
            status, upload_etag_full = upload_etag_full, 'null'
        return upload_etag_full, status

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
        """ First check if an upload ID exists for the key. 

            * if yes:
                Get the list of parts uploaded and return the list of parts and uploadID

            * if not: 
                Initialize the multiple upload process to generate an uploadID and return.
        """

        logger.info(
            f"Migrator> Try get or create a new upload ID for multipart load")

        # try finding existing upload ID and parts.
        uploaded_list = self._des_client.list_multipart_uploads(self._job.key)
        # if exists
        if uploaded_list:
            if self._config.clean_unfinished_upload:
                logger.info("Migrator> Clean Unfinished Job")
                self._des_client.clean_unfinished_unload(uploaded_list)

            else:
                upload_id = uploaded_list[0]['UploadId']
                part_list = self._des_client.list_parts(
                    self._job.key, upload_id)
                part_numbers = [p['PartNumber'] for p in part_list]

                return upload_id, part_numbers

        response_new_upload = self._des_client.create_multipart_upload(
            self._job.key,
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

        job_dict = {'Key': self._job.key,
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
                f'Quit job upload_etag_full == {upload_etag_full} - {self._job.key}')

        elif upload_etag_full == "ERR":
            # TODO clean existing upload? why?
            logger.error(f'upload_etag_full ERR - {str(self._job.key)}')

    def _complete_upload(self, upload_id):
        logger.info(f"Migrator> Complete Upload...{upload_id}")

        complete_etag = self._des_client.complete_multipart_upload(
            self._job.key, upload_id)
        if not complete_etag:
            # TODO implement retry
            logger.error(f'complete_etag ERR - {self._job.key}')

        return complete_etag
