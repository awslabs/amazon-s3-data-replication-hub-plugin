import json
import logging
import os
import time
from pathlib import Path, PurePosixPath

import boto3
from boto3.dynamodb.conditions import Key, Attr

from migration_lib.config import QUEUE_BATCH_SIZE
from migration_lib.client import JobInfo

logger = logging.getLogger(__name__)


class DBService():
    """ A basic DynamoDB service to write migration job into DynamoDB """

    def __init__(self, table_name):
        super().__init__()
        # self._client = boto3.client('dynamodb')
        dynamodb = boto3.resource('dynamodb')
        self._table_name = table_name
        self._table = dynamodb.Table(table_name)

    def log_job_start(self, src_bucket, src_prefix, des_bucket, des_prefix, job: JobInfo, extra_args):
        """  create an item(record) in dynamoDB table when a job is started """

        logger.debug(
            f'DynamoDB> Create job record for {src_bucket} - {job.key} - {extra_args}')
        cur_time = time.time()
        table_key = str(PurePosixPath(src_bucket) / job.key)

        # TODO double check this.
        if job.key[-1] == '/':  # 针对空目录对象
            table_key += '/'

        # Expires is with datetime format and can't be directly stored in DynamoDB.
        if 'Expires' in extra_args:
            extra_args['Expires'] = str(extra_args['Expires'].timestamp())

        try:
            self._table.put_item(
                Item={
                    'objectKey':  table_key,
                    'size': job.size,
                    'storageClass': job.storage_class,
                    'desBucket':  des_bucket,
                    'desKey':  job.key,
                    'extraInfo':  extra_args,
                    # 'startTime':  time.asctime(time.localtime(cur_time)),
                    'startTime': int(cur_time),
                    'jobStatus':  'Started',
                    'tryTime': 1,
                    'versionId':  job.version,
                }
            )
            # logger.info(f"DynamoDB> Write to DB response - {response}")

        except Exception as e:
            logger.error(
                f'DynamoDB> Fail to put log to DDB at start job - {src_bucket}/{job.key} - {str(e)}')

    def log_job_end(self, src_bucket, key, etag, err):
        """ Update an item(record) with a updated Status and completed time """
        logger.debug(
            f'DynamoDB> Update job record for {src_bucket} - {key}')

        cur_time = time.time()
        table_key = str(PurePosixPath(src_bucket) / key)

        # TODO double check this.
        if key[-1] == '/':  # for empty dir?
            table_key += '/'

        try:
            status = 'DONE'
            if err:
                status = 'ERROR'

            response = self._table.update_item(
                ExpressionAttributeValues={
                    # ':et': time.asctime(time.localtime(cur_time)),
                    ':et': int(cur_time),
                    ':js': status,
                    ':etag': etag,
                    ':err': err,
                },
                Key={'objectKey':  table_key, },
                UpdateExpression='SET endTime = :et, totalSpentTime=:et-startTime, jobStatus = :js, etag = :etag, err = :err',
            )

            logger.debug(f'DynamoDB> Write DB response: {response}')

        except Exception as e:
            logger.error(
                f'DynamoDB> Fail to put log to DDB at end - {src_bucket}/{key} - {str(e)}')
        return

    def get_versionid(self, des_bucket):
        logger.debug(f'DynamoDB> Get des_bucket versionId list')

        # TODO Test this.
        ver_list = {}
        try:
            r = self._table.query(
                IndexName='desBucket-index',
                KeyConditionExpression='desBucket=:b',
                ExpressionAttributeValues={":b": des_bucket}
            )
            if 'Items' in r:
                for i in r['Items']:
                    ver_list[i['desKey']] = i['versionId']
            logger.info(f'Got versionId list {des_bucket}: {len(ver_list)}')
        except Exception as e:
            logger.error(
                f'Fail to query DDB for versionId {des_bucket}- {str(e)}')
        return ver_list

    def check_sequencer(self, key, sequencer):
        ''' Returns True if this event should be handled, otherwise False 

        The sequencer in the event message provides a way to determine the sequence of events. 
        A event message should only be handled if the current sequencer has a greater hexadecimal value.

        More info: Check https://docs.aws.amazon.com/AmazonS3/latest/dev/notification-content-structure.html

        If there is no existing record for the key. A record will be created in event table, and True is returned.. 

        If existing record has smaller hexadecimal value, the record will be updated with new sequencer, and True is returned.

        If existing record has bigger hexadecimal value, nothing will happen, and False is returned.
        '''
        logger.info(
            f'DynamoDB> Validate sequencer for key {key} in Event Table')

        try:
            response = self._table.query(
                KeyConditionExpression=Key('objectKey').eq(key)
            )

            logger.debug(f'DynamoDB> Query Response {response}')
            items = response['Items']
            logger.debug(f'DynamoDB> Returned Item {items}')

            if items:  # if item found.
                seq = items[0]['sequencer']
                logger.debug(
                    f'DynamoDB> Key {key} found in event Table with sequence {seq}')
                old_seq = int(seq, 16)
                new_seq = int(sequencer, 16)
                logger.debug(
                    f'DynamoDB> Comparing new {new_seq} to old {old_seq}')
                if new_seq <= old_seq:
                    logger.debug(
                        f'DynamoDB > Existing sequencer is bigger, event should be ignored')
                    return False

                else:
                    logger.debug(
                        f'DynamoDB > Existing sequencer is smaller. Update {key} with new sequencer {sequencer}')
                    self._table.update_item(
                        Key={
                            'objectKey': key,
                        },
                        UpdateExpression='SET sequencer = :val1',
                        ExpressionAttributeValues={
                            ':val1': sequencer
                        }
                    )
            else:
                logger.debug(
                    f'key {key} not found, create new event record with sequencer {sequencer}')
                self._table.put_item(
                    Item={
                        'objectKey':  key,
                        'sequencer': sequencer,
                    }
                )
        except Exception as e:
            logger.error(
                f'DynamoDB> Exception on {key}- {str(e)}')
        return True


class SQSService():
    """ A basic SQS service to perform the sending and receiving of messages with SQS """

    def __init__(self, queue_name):
        super().__init__()
        self._sqs = boto3.client('sqs')
        self._sqs_queue_name = queue_name
        self._sqs_queue_url = self._sqs.get_queue_url(
            QueueName=queue_name)['QueueUrl']

    def send_jobs(self, job_list):
        """ Send a list of jobs into SQS queue """

        sqs_message = []
        logger.info(
            f'SQS> Start sending jobs to queue: {self._sqs_queue_name}')

        batch_id = 0

        for job in job_list:
            # construct sqs messages
            sqs_message.append({
                "Id": str(batch_id),
                "MessageBody": json.dumps(job),
            })
            batch_id += 1

            # write to sqs in batch 10 or is last one
            if batch_id == QUEUE_BATCH_SIZE or job == job_list[-1]:
                try:
                    self._sqs.send_message_batch(
                        QueueUrl=self._sqs_queue_url, Entries=sqs_message)
                except Exception as e:
                    logger.error(
                        f'Fail to send sqs message: {str(sqs_message)}, {str(e)}')
                batch_id = 0
                sqs_message = []

        logger.info(
            f'SQS> Complete sending job to queue: {self._sqs_queue_name}')

    def receive_jobs(self, max_messages=1):
        """ Receive messages from SQS queue """
        logger.info(
            f'SQS> Start receiving messages from queue: {self._sqs_queue_name}')

        job_list = []
        response = self._sqs.receive_message(
            QueueUrl=self._sqs_queue_url,
            # AttributeNames=[
            #     'SentTimestamp'
            # ],
            MaxNumberOfMessages=1,
            MessageAttributeNames=[
                'All'
            ],
            VisibilityTimeout=0,
            # WaitTimeSeconds=0
        )

        messages = response['Messages']
        for message in messages:
            body = message['Body']
            job_list.append(json.loads(body))
            logger.info(f'SQS> Received message: {body}')

        return json.loads(body)

    def is_empty(self):
        """ Return true if the queue is empty """
        try:
            sqs_in_flight = self._sqs.get_queue_attributes(
                QueueUrl=self._sqs_queue_url,
                AttributeNames=[
                    'ApproximateNumberOfMessagesNotVisible', 'ApproximateNumberOfMessages']
            )
        except Exception as e:
            logger.error(f'SQS> Fail to get_queue_attributes: {str(e)}')
            return False  # Can't get sqs status, then consider it is not empty
        NotVisible = sqs_in_flight['Attributes']['ApproximateNumberOfMessagesNotVisible']
        Visible = sqs_in_flight['Attributes']['ApproximateNumberOfMessages']
        logger.info(f'SQS> NotVisible: {NotVisible}, Visable: {Visible}')
        if NotVisible == '0' and (Visible == '0' or Visible == '1'):
            # In init state, the new created bucket trigger SQS will send one test message to SQS.
            # So here to ignore the case Visible == '1'
            return True  # sqs is empty
        return False  # sqs is not empty
