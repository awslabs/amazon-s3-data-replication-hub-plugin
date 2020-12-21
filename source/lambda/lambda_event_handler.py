import boto3
import os
import uuid
ecs = boto3.client('ecs')
s3 = boto3.client('s3')


def lambda_handler(event, context):
    print(event)
    request_type = event['RequestType']
    if request_type == 'Create':
        return on_create(event)
    if request_type == 'Update':
        return on_update(event)
    if request_type == 'Delete':
        return on_delete(event)
    raise Exception("Invalid request type: %s" % request_type)


def on_create(event):
    props = event["ResourceProperties"]
    print("create new resource with props %s" % props)

    print('Run fargate task')
    run_fargate(props)

    print('Add notification to s3 bucket')
    put_s3_notification(props)

    physical_id = props['stack_name']
    return {'PhysicalResourceId': physical_id}


def on_update(event):
    physical_id = event["PhysicalResourceId"]
    props = event["ResourceProperties"]
    print("update resource %s with props %s" % (physical_id, props))

    print('Run fargate task')
    run_fargate(props)

    print('Add notification to s3 bucket')
    put_s3_notification(props)


def on_delete(event):
    physical_id = event["PhysicalResourceId"]
    print("delete resource %s" % physical_id)


def run_fargate(props):
    ''' Check if there is any running fargate task, if not, run a new one '''
    cluster_name = props['cluster_name']
    family = props['family']
    subnets = props['subnets']
    sg = props['security_group']

    try:
        response = ecs.list_tasks(
            cluster=cluster_name,
            family=family,
            maxResults=1,
            desiredStatus='RUNNING',
        )
        print(response)

        # if no tasks is running, start a new task
        if not response['taskArns']:
            response = ecs.run_task(
                cluster=cluster_name,
                count=1,
                launchType='FARGATE',
                networkConfiguration={
                    'awsvpcConfiguration': {
                        'subnets': subnets,
                        'securityGroups': [
                            sg,
                        ],
                        'assignPublicIp': 'ENABLED'
                    }
                },
                taskDefinition=family
            )
    except Exception as e:
        print(e)


def put_s3_notification(props):
    ''' create or update notification configurtion to S3 Bucket only if Enable S3 Event is required. '''
    bucket_name = props['bucket_name']
    queue_arn = props['queue_arn']
    enable_s3_event = props['enable_s3_event']
    prefix = props['prefix']
    job_type = props['job_type']
    stack_name = props['stack_name']

    if job_type == 'PUT' and enable_s3_event == 'Yes':

        response = s3.put_bucket_notification_configuration(
            Bucket=bucket_name,
            NotificationConfiguration={
                'QueueConfigurations': [
                    {
                        'Id': 'Data Replication Hub Notification - {}'.format(stack_name),
                        'QueueArn': queue_arn,
                        'Events': [
                            's3:ObjectCreated:*'
                        ],
                        'Filter': {
                            'Key': {
                                'FilterRules': [
                                    {
                                        'Name': 'prefix',
                                        'Value': prefix
                                    },
                                ]
                            }
                        }
                    },
                ],
            },
        )
        print(response)
    else:
        print('No need to add S3 bucket notitication')
