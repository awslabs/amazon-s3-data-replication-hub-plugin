import boto3
import os
import uuid
ecs = boto3.client('ecs')


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

    # print('Run fargate task')
    # run_fargate(props)
    print('Get Dual-way work, stop automated finder')

    physical_id = props['stack_name']
    return {'PhysicalResourceId': physical_id}


def on_update(event):
    physical_id = event["PhysicalResourceId"]
    props = event["ResourceProperties"]
    print("update resource %s with props %s" % (physical_id, props))
    
    print('Get Dual-way work, stop automated finder')
    # print('Run fargate task')
    # run_fargate(props)


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
