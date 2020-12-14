import boto3
import os
client = boto3.client('ecs')


def lambda_handler(event, context):
    # logger.info(json.dumps(event, default=str))
    cluster_name = os.environ['CLUSTER_NAME']

    family = os.environ['FAMILY']
    subnets = os.environ['SUBNETS']
    sg = os.environ['SECURITY_GROUP']

    try:
        response = client.list_tasks(
            cluster=cluster_name,
            family=family,
            maxResults=1,
            desiredStatus='RUNNING',
        )
        print(response)

        # if no tasks is running, start a new task
        if not response['taskArns']:
            response = client.run_task(
                cluster=cluster_name,
                count=1,
                launchType='FARGATE',
                networkConfiguration={
                    'awsvpcConfiguration': {
                        'subnets': subnets.split(','),
                        'securityGroups': [
                            sg,
                        ],
                        'assignPublicIp': 'ENABLED'
                    }
                },
                taskDefinition=family
            )
        return {
            'statusCode': 200,
            'body': "OK"
        }
    except Exception as e:
        print(e)

        return {
            'statusCode': 500,
            'body': str(e)
        }
