import logging
import math
import os
import boto3
import hashlib
import base64
import oss2

from enum import Enum

from botocore.config import Config
from botocore.exceptions import ClientError
from botocore import UNSIGNED

from migration_lib.config import (MAX_ATTEMPTS, MAX_KEYS, MAX_PARTS,
                                  MAX_POOL_CONNECTION)


logger = logging.getLogger(__name__)

# METADATA_ARGS: List of supported system metadata and custom metadata keys.
S3_METADATA_ARGS = ['Metadata',
                    'ContentDisposition',
                    'ContentLanguage',
                    'ContentType',
                    'ContentEncoding',
                    'CacheControl',
                    'Expires',
                    'WebsiteRedirectLocation']


class JobInfo():
    """ a representation of an object to be migrated with minimum info.

    There is no need to include the bucket info, as it's already stored in lambda env.
    """

    def __init__(self, key, size, version=None, storage_class='STANDARD'):
        self.key = key
        self.size = size
        self.version = version
        self.storage_class = storage_class

    def __str__(self):
        return '({}, {}, {})'.format(self.key, self.size, self.version)

    def __repr__(self):
        return self.__str__()


class DownloadClient():
    """ An abstract client to handle the list and download operations from cloud storage service """

    def __init__(self, bucket_name, prefix='', **credentials):
        super().__init__()
        self._bucket_name = bucket_name
        self._prefix = prefix

    def get_object(self, key, size, start=0, chunk_size=0, version=None):
        """The method is used to get object data in chunks from cloud storage.

        :param key: unique object key

        :param size: object size in bytes

        :param start: start byte, default to 0 (beginning of the object)

        :param chunk_size: number of bytes to read, if chunk_size is 0, the full file will be downloaded

        :param version: if a value of version is passed, only that particular version will be downloaded

        :returns: a tuple (body, body_md5)

        This method must be implemented by subclasses.
        """
        raise NotImplementedError('get_object() must be implemented')

    def list_objects(self, include_version=False, latest_changes_only=False):
        """The method is used to list the objects stored from cloud storage.

        :param include_version: whether to list objects with version id info. Default to False

        :param latest_changes_only: whether to list objects with recent change only. Default to False.
        This is currently a placehold and it hasn't been implemented yet.

        :returns: a list of `JobInfo` objects

        This method must be implemented by subclasses.
        """
        raise NotImplementedError('list_objects() must be implemented')

    def head_object(self, key):
        """The method is used to get extra info (like metadata) for an object stored from cloud storage.

        :param key: unique object key

        :returns: A dictionary representing the metadata info. For example:
            {'ContentType': 'image/jpeg', ...}

        This method must be implemented by subclasses.
        """
        raise NotImplementedError('head_object() must be implemented')

    @property
    def prefix(self):
        return self._prefix

    @property
    def bucket_name(self):
        return self._bucket_name


class S3DownloadClient(DownloadClient):
    r""" An implementation of download client with Amazon S3.

    Example Usage:

        client = S3DownloadClient(bucket_name='my-bucket')
        for obj in client.list_objects():
            print(obj)

    Note:
        credentials is optional. If it should be provided, below is an example:

        credentials = {
            "aws_access_key_id": "<Your AccessKeyID>",
            "aws_secret_access_key": "<Your AccessKeySecret>",
            "region_name": "cn-northwest-1"
        }

        This client also supports Qiniu Kodo and Tencent COS with native S3 SDK support.
        For them, the credentials must contain the related endpoint url, for example:

        credentials = {
            "aws_access_key_id": "<Your AccessKeyID>",
            "aws_secret_access_key": "<Your AccessKeySecret>",
            "endpoint_url": "https://s3-ap-southeast-1.qiniucs.com"
        }
    """

    def __init__(self, bucket_name, prefix='', **credentials):
        super().__init__(bucket_name, prefix, **credentials)

        if credentials.get('no_auth'):
            credentials.pop('no_auth')
            s3_config = Config(max_pool_connections=MAX_POOL_CONNECTION,
                               signature_version=UNSIGNED,
                               retries={'max_attempts': MAX_ATTEMPTS})
        else:
            s3_config = Config(max_pool_connections=MAX_POOL_CONNECTION,
                               retries={'max_attempts': MAX_ATTEMPTS})
        try:
            self._client = boto3.client('s3', config=s3_config, **credentials)
        except Exception as e:
            logger.error(f'Fail to create a client session: {str(e)}')

    def get_object(self, key, size, start=0, chunk_size=0, version=None):
        logger.debug("S3> Get Object from S3")

        if not version:
            version = 'null'

        if chunk_size:
            logger.debug(
                f'S3> Downloading {key} with {chunk_size} bytes start from {start}')
            response_get_object = self._client.get_object(
                Bucket=self._bucket_name,
                Key=key,
                # VersionId=version,
                Range="bytes=" + str(start) + "-" +
                str(start + chunk_size - 1)
            )
        else:
            logger.debug(
                f'S3> Downloading {key} with full size')
            response_get_object = self._client.get_object(
                Bucket=self._bucket_name,
                Key=key,
                # VersionId=version,
            )
        body = response_get_object["Body"].read()
        # TODO whether to return md5 string, currently it's a hash object. This is used in job processor as well.
        # content_md5 = base64.b64encode(
        #     chunkdata_md5.digest()).decode('utf-8')

        body_md5 = hashlib.md5(body)
        return body, body_md5

    def _list_objects_without_version(self, latest_changes_only=False):
        logger.debug(
            f'S3> list objects in bucket {self._bucket_name} from S3 without version info')
        # TODO implement latest_changes_only.
        job_list = []

        # Use list_objects_v2() to get the list.
        continuation_token = None
        while True:
            list_kwargs = {'Bucket': self._bucket_name,
                           'MaxKeys': MAX_KEYS,
                           'Prefix': self._prefix, }
            if continuation_token:
                list_kwargs['ContinuationToken'] = continuation_token
            response = self._client.list_objects_v2(**list_kwargs)
            # logger.debug(response.get('Contents', []))
            contents = response.get('Contents', [])

            # Exclude objects with GLACIER and DEEP_ARCHIVE storage class, they can't be downloaded.
            job_list = [JobInfo(x['Key'], x['Size']) for x in contents
                        if x['StorageClass'] not in ['GLACIER', 'DEEP_ARCHIVE']]
            # logger.debug(
            #     f'S3> {str(len(job_list))} objects found in bucket {self._bucket_name} ')

            if not response.get('IsTruncated'):  # At the end of the list
                break
            yield job_list
            continuation_token = response.get('NextContinuationToken')
        yield job_list

    def _list_objects_versions(self, latest_changes_only=False):
        """List objects from S3 bucket"""
        logger.debug(
            f'S3> List objects in bucket {self._bucket_name} with version info')

        # TODO implement latest_changes_only.
        job_list = []

        # Use list_object_versions() to get the list.
        key_marker = None
        while True:
            list_kwargs = {'Bucket': self._bucket_name,
                           'MaxKeys': MAX_KEYS,
                           'Prefix': self._prefix, }
            if key_marker:
                list_kwargs['KeyMarker'] = key_marker
            response = self._client.list_object_versions(**list_kwargs)
            # logger.debug(response.get('Contents', []))

            contents = response.get('Versions', [])
            job_list = [JobInfo(x['Key'], x['Size'], x['VersionId'])
                        for x in contents
                        if x['IsLatest'] and x['StorageClass'] not in ['GLACIER', 'DEEP_ARCHIVE']]
            # logger.debug(
            #     f'S3> {str(len(job_list))} objects found in bucket {self._bucket_name} ')

            if not response.get('IsTruncated'):  # At the end of the list
                break
            yield job_list

            key_marker = response.get('NextKeyMarker')
        yield job_list

    def list_objects(self, include_version=False, latest_changes_only=False):
        if include_version:
            return self._list_objects_versions(latest_changes_only=latest_changes_only)
        else:
            return self._list_objects_without_version(latest_changes_only=latest_changes_only)

    def head_object(self, key):
        logger.debug("S3> Get extra metadata info")
        head = self._client.head_object(
            Bucket=self._bucket_name,
            Key=key
        )
        extra_args = {m: head[m] for m in S3_METADATA_ARGS if head.get(m)}
        return extra_args


class AliOSSDownloadClient(DownloadClient):
    r""" An implemented download client with Aliyun OSS.

    Example Usage:

        client = AliOSSDownloadClient(bucket_name='my-bucket', **credentials)
        for obj in client.list_objects():
            print(obj)

    Note:
        credentials must be in a form of dict. Below is an example:

        credentials = {
            "oss_access_key_id": "<Your AccessKeyID>",
            "oss_secret_access_key": "<Your AccessKeySecret>",
            "oss_endpoint": "http://oss-cn-hangzhou.aliyuncs.com"
        }
    """

    def __init__(self, bucket_name, prefix='', **credentials):
        super().__init__(bucket_name, prefix, **credentials)
        endpoint = credentials['oss_endpoint']
        access_key_id = credentials['oss_access_key_id']
        access_key_secret = credentials['oss_secret_access_key']
        auth = oss2.Auth(access_key_id, access_key_secret)

        self._client = oss2.Bucket(auth, endpoint, bucket_name)

    def get_object(self, key, size, start=0, chunk_size=0, version=None):
        logger.debug("OSS> Get Object from Aliyun OSS")

        if chunk_size:
            end = start + chunk_size
            # For OSS, if range end is greater than size, the full file will be downloaded for the last chunk.
            if end > size:
                end = size

            logger.debug(
                f'OSS> Downloading {key} with {end-start} bytes start from {start}')

            byte_range = (start, end-1)
            result = self._client.get_object(key=key,
                                             byte_range=byte_range
                                             )

        else:
            logger.debug(
                f'OSS> Downloading {key} with full size')
            result = self._client.get_object(key=key)

        body = result.read()
        body_md5 = hashlib.md5(body)

        # TODO whether to return md5 string, currently it's a hash object. This is used in job processor as well.
        # content_md5 = base64.b64encode(body_md5.digest()).decode('utf-8')
        return body, body_md5

    def _list_objects_without_version(self, latest_changes_only=False):
        logger.debug(
            f'OSS> list objects from OSS in bucket {self._bucket_name} without version info')
        # TODO implement latest_changes_only.
        job_list = []

        marker = None
        while True:
            list_kwargs = {'max_keys': MAX_KEYS,
                           'prefix': self._prefix, }
            if marker:
                list_kwargs['marker'] = marker
            result = self._client.list_objects(**list_kwargs)

            job_list = [JobInfo(x.key, x.size, 'null')
                        for x in result.object_list]
            # logger.debug(
            #     f'OSS> {str(len(job_list))} objects found in bucket {self._bucket_name} ')

            if not result.is_truncated:  # At the end of the list
                break
            yield job_list
            marker = result.next_marker
        yield job_list

    def _list_objects_versions(self, latest_changes_only=False):
        logger.debug(
            f'OSS> List objects in bucket {self._bucket_name} with version info')
        # TODO implement latest_changes_only.
        job_list = []

        key_marker = None
        while True:
            list_kwargs = {'max_keys': MAX_KEYS,
                           'prefix': self._prefix, }
            if key_marker:
                list_kwargs['key_marker'] = key_marker
            result = self._client.list_object_versions(**list_kwargs)

            job_list = [JobInfo(x.key, x.size, x.versionid)
                        for x in result.versions if x.is_latest]

            # logger.debug(
            #     f'OSS> {str(len(job_list))} objects found in bucket {self._bucket_name} ')
            if not result.is_truncated:  # At the end of the list
                break
            yield job_list
            key_marker = result.next_key_marker

        yield job_list

    def list_objects(self, include_version=False, latest_changes_only=False):
        """ List of objects from Aliyun OSS. """
        if include_version:
            return self._list_objects_versions(latest_changes_only=latest_changes_only)
        else:
            return self._list_objects_without_version(latest_changes_only=latest_changes_only)

    def head_object(self, key):
        logger.debug("OSS> head Object")
        # TODO check this.
        head = self._client.head_object(key)
        content_type = head.content_type
        logger.warning(
            'OSS> Only ContentType is currently supported by OSS.')

        return {'ContentType': content_type}


class UploadClient():
    """ An abstract client to handle upload of object to cloud storage service """

    def __init__(self, bucket_name, prefix="", **credentials):
        super().__init__()
        self._bucket_name = bucket_name
        self._prefix = prefix

    def upload_object(self, key, body, content_md5, storage_class, **extra_args):
        """The method is used to upload an object cloud storage in one piece.

       This method must be implemented by subclasses.
        """
        raise NotImplementedError('upload_object() must be implemented')

    def clean_unfinished_unload(self, uploaded_list):
        """The method is used to clean all the uploaded parts but not yet merged for multipart load.

       This method must be implemented by subclasses.
        """
        raise NotImplementedError(
            'clean_unfinished_unload() must be implemented')

    def create_multipart_upload(self, key, storage_class, **extra_args):
        """The method is to initialize multipart upload with a upload ID

        This method must be implemented by subclasses.
        """
        raise NotImplementedError(
            'create_multipart_upload() must be implemented')

    def complete_multipart_upload(self, key, upload_id):
        """The method is to complete the multipart process after successfully uploading all relevant parts.

        This method must be implemented by subclasses.
        """
        raise NotImplementedError(
            'complete_multipart_upload() must be implemented')

    def upload_part(self, key, body, body_md5, part_number, upload_id=None):
        """The method is to upload a part in a multipart upload.

        This method must be implemented by subclasses.
        """
        raise NotImplementedError('upload_part() must be implemented')

    def list_parts(self, key, upload_id):
        """The method is get uploaded parts in a multipart upload.

        :returns: A list of dictionary representing a part:

            [{'Etag': etag_value, 'PartNumber': part_number},...]

        This method must be implemented by subclasses.
        """
        raise NotImplementedError('list_parts() must be implemented')

    def list_multipart_uploads(self, key=None):
        """ this method is used to list in-progress multipart uploads.

        An in-progress multipart upload is a multipart upload that
        has been initiated using the Initiate Multipart Upload request,
        but has not yet been completed or aborted.

        :returns: A list of keys and the relevent upload IDs:

            [{'Key': object_key, 'UploadID': multipart_upload_id,
                'Initiated': initiated_datetime},...]

        This method must be implemented by subclasses.
        """
        raise NotImplementedError(
            'list_multipart_uploads() must be implemented')

    @property
    def prefix(self):
        return self._prefix

    @property
    def bucket_name(self):
        return self._bucket_name


class S3UploadClient(UploadClient):
    r""" An implementation of upload client with Amazon S3.

    Example Usage:

        client = S3UploadClient(bucket_name='my-bucket')
        ...

    Note:
        credentials is optional,

        credentials = {
            "aws_access_key_id": "<Your AccessKeyID>",
            "aws_secret_access_key": "<Your AccessKeySecret>",
            "region_name": "cn-northwest-1"
        }
    """

    def __init__(self, bucket_name, prefix='',  **credentials):
        super().__init__(bucket_name, prefix, **credentials)

        # TODO change to a parameter.
        s3_config = Config(max_pool_connections=MAX_POOL_CONNECTION,
                           retries={'max_attempts': MAX_ATTEMPTS})
        try:
            self._client = boto3.client('s3', config=s3_config, **credentials)
        except Exception as e:
            logger.error(f'Fail to create a client session: {str(e)}')

    def _put_object(self, key, body, content_md5, storage_class,  **extra_args):
        logger.debug(
            f'S3> Uploading Small file {self._bucket_name}/{key}')

        # TODO Currently, storage_class is default to the same one, do we need to update to used original storage class?
        response = self._client.put_object(
            Body=body,
            Bucket=self._bucket_name,
            Key=key,
            ContentMD5=content_md5,
            StorageClass=storage_class,
            **extra_args
        )

        etag = response['ETag']
        return etag

    def upload_object(self, key, body, content_md5, storage_class, **extra_args):
        """Upload a file to S3. """
        return self._put_object(key, body, content_md5, storage_class, **extra_args)

    def clean_unfinished_unload(self, uploaded_list):
        logger.debug(
            f'S3> clean unfinished uploads')
        for upload in uploaded_list:
            logger.debug(f'S3> Found upload: {upload}')
            try:
                self._client.abort_multipart_upload(
                    Bucket=self._bucket_name,
                    Key=upload['Key'],
                    UploadId=upload['UploadId']
                )
                logger.debug(
                    f'S3> Abort multipart upload for {upload["Key"]} with upload id {upload["UploadId"]}')
            except Exception as e:
                logger.error(
                    f'S3> Fail to abort multipart upload for {upload["Key"]} with upload id {upload["UploadId"]} - {str(e)}')
        pass

    def delete_object(self, key):
        logger.debug(f'S3> Delete {self._bucket_name}/{key}')
        try:
            self._client.delete_object(
                Bucket=self._bucket_name,
                Key=key
            )
        except Exception as e:
            logger.error(
                f'Fail to delete S3 object - {self._bucket_name}/{key} - {str(e)}')

    def create_multipart_upload(self, key, storage_class,  **extra_args):
        logger.debug("S3> Create multipart upload for big file")

        upload_id = self._client.create_multipart_upload(
            Bucket=self._bucket_name,
            Key=key,
            StorageClass=storage_class,
            **extra_args
        )

        return upload_id['UploadId']

    def list_parts(self, key, upload_id):
        part_list = []

        paginator = self._client.get_paginator('list_parts')
        try:
            response_iterator = paginator.paginate(
                Bucket=self._bucket_name,
                Key=key,
                UploadId=upload_id
            )

            for page in response_iterator:
                if "Parts" in page:
                    logger.debug(
                        f'Got list_parts: {len(page["Parts"])} - {self._bucket_name}/{key}')
                    for p in page["Parts"]:
                        part_list.append({
                            "ETag": p["ETag"],
                            "PartNumber": p["PartNumber"]
                        })
            # logger.debug(f'>> Found Part List: {part_list}')
        except Exception as e:
            logger.error(
                f'Fail to list parts while completeUpload - {self._bucket_name}/{key} - {str(e)}')
            return []
        return part_list

    def list_multipart_uploads(self, key=None):
        logger.debug(
            f'S3> List multipart upload for {key}')
        uploaded_list = []
        paginator = self._client.get_paginator('list_multipart_uploads')
        try:
            response_iterator = paginator.paginate(
                Bucket=self._bucket_name,
                Prefix=self._prefix
            )
            for page in response_iterator:
                if "Uploads" in page:
                    for i in page["Uploads"]:
                        # logger.debug(
                        #     f'S3> Unfinished upload, Key: {i["Key"]}, uploadId:{i["UploadId"]} - Time: {i["Initiated"]}')
                        if key:
                            # if Key is provided, only return the upload id for that key.
                            if i['Key'] == key:
                                logger.debug(
                                    f'Found upload ID: {i["UploadId"]}')
                                uploaded_list.append({
                                    "Key": i["Key"],
                                    "Initiated": i["Initiated"],
                                    "UploadId": i["UploadId"]
                                })
                        else:
                            # otherwise, return the whole list of upload IDs.
                            uploaded_list.append({
                                "Key": i["Key"],
                                "Initiated": i["Initiated"],
                                "UploadId": i["UploadId"]
                            })

                    logger.debug(f'S3> Found list: {uploaded_list}')
        except Exception as e:
            logger.error(
                f'Fail to list multipart upload - {self._bucket_name}/{self._prefix} - {str(e)}')
        return uploaded_list

    def complete_multipart_upload(self, key, upload_id):
        logger.debug(
            f'S3> Complete multipart upload for {key} - upload ID - {upload_id}')
        # List all the parts.
        past_list = self.list_parts(key, upload_id)
        part_list_args = {"Parts": past_list}
        # logger.info(f'S3> part_list:  {part_list}')

        try:
            response_complete = self._client.complete_multipart_upload(
                Bucket=self._bucket_name,
                Key=key,
                UploadId=upload_id,
                MultipartUpload=part_list_args
            )
            etag = response_complete['ETag']
            logger.debug(f'S3> Merged: {self._bucket_name}/{key}')
        except Exception as e:
            logger.error(
                f'S3> Fail to complete multipart upload {self._bucket_name}/{key}, {str(e)}')

        return etag

    def upload_part(self, key, body, body_md5, part_number, upload_id=None):
        # TODO update upload_part
        logger.debug(
            f'S3> Uploading part for {key} with part number {part_number}')
        # logger.debug(f'--->Uploading {len(getBody)} Bytes {Des_bucket}/{Des_key} - {partnumber}/{total}')
        self._client.upload_part(
            Body=body,
            Bucket=self._bucket_name,
            Key=key,
            PartNumber=part_number,
            UploadId=upload_id,
            ContentMD5=base64.b64encode(body_md5.digest()).decode('utf-8')
            # content_md5=content_md5
        )

    # def _adjust_for_max_parts(self, current_chunksize, file_size):
        # TODO check if this can be moved to client.
        # chunksize = current_chunksize
        # num_parts = int(math.ceil(file_size / float(chunksize)))

        # while num_parts > MAX_PARTS:
        #     chunksize *= 2
        #     num_parts = int(math.ceil(file_size / float(chunksize)))

        # if chunksize != current_chunksize:
        #     logger.debug(
        #         "Chunksize would result in the number of parts exceeding the "
        #         "maximum. Setting to %s from %s." %
        #         (chunksize, current_chunksize))

        # return chunksize
        # pass


class InvalidCredentialsError(Exception):
    pass


class DownloadClientError(Exception):
    pass


class UploadClientError(Exception):
    pass


class ClientManager():
    """ Client wrapper to create clients for different types of sources """

    def __init__(self):
        pass

    @classmethod
    def create_download_client(cls, bucket_name, prefix='', region_name='', credentials={}, source_type='Amazon_S3'):
        source = Source(source_type)
        if source == Source.ALIYUN_OSS:
            credentials['oss_access_key_id'] = credentials.pop('access_key_id')
            credentials['oss_secret_access_key'] = credentials.pop(
                'secret_access_key')
            credentials['oss_endpoint'] = source.get_endpoint_url(
                region_name)

            client = AliOSSDownloadClient(
                bucket_name=bucket_name, prefix=prefix, **credentials)
        else:  # for S3, Qiniu Kodo, Tencent COS
            if credentials:
                if credentials.get('access_key_id'):
                    credentials['aws_access_key_id'] = credentials.pop(
                        'access_key_id')
                    credentials['aws_secret_access_key'] = credentials.pop(
                        'secret_access_key')
                credentials['region_name'] = region_name
                credentials['endpoint_url'] = source.get_endpoint_url(
                    region_name)
            client = S3DownloadClient(
                bucket_name=bucket_name, prefix=prefix, **credentials)
        return client

    @classmethod
    def create_upload_client(cls, bucket_name, prefix='', region_name='', credentials={}):
        if credentials:
            credentials['aws_access_key_id'] = credentials.pop(
                'access_key_id')
            credentials['aws_secret_access_key'] = credentials.pop(
                'secret_access_key')
            credentials['region_name'] = region_name
        return S3UploadClient(bucket_name, prefix, **credentials)


class Source(Enum):
    """ Enum of Different Sources """
    AMAZON_S3 = 'Amazon_S3'
    ALIYUN_OSS = 'Aliyun_OSS'
    TENCENT_COS = 'Tencent_COS'
    QINIU_KODO = 'Qiniu_Kodo'

    def get_endpoint_url(self, region_name):
        ''' Helper func to get endpoint url based on region name '''
        if self == Source.QINIU_KODO:
            endpoint_url = 'https://s3-{}.qiniucs.com'.format(region_name)
        elif self == Source.TENCENT_COS:
            endpoint_url = 'https://cos.{}.myqcloud.com'.format(region_name)
        elif self == Source.ALIYUN_OSS:
            endpoint_url = 'https://oss-{}.aliyuncs.com'.format(region_name)
        else:
            endpoint_url = None

        logger.debug(f'Util> Endpoint url for {self.name} is {endpoint_url}')
        return endpoint_url
