import { Construct, Duration, Stack, CustomResource, Aws } from '@aws-cdk/core';

import * as iam from '@aws-cdk/aws-iam';
// import * as s3n from '@aws-cdk/aws-s3-notifications';
import * as s3 from '@aws-cdk/aws-s3';
import * as sqs from '@aws-cdk/aws-sqs';
import * as cr from "@aws-cdk/custom-resources";
import * as lambda from '@aws-cdk/aws-lambda';
import * as ecs from '@aws-cdk/aws-ecs';

import * as path from 'path';

export interface EventProps {
    readonly bucket: s3.IBucket,
    readonly prefix: string,
    readonly queue: sqs.Queue,
    readonly enableS3Event: string,
    readonly jobType: string,
    readonly ecsVpcId: string,
    readonly ecsSubnetIds: string[],
    readonly ecsClusterName: string,
    readonly taskDefinition: ecs.TaskDefinition
    readonly securityGroupName: string,
}

/***
 * Custom Handler to run when stack is on create, update or delete.
 */
export class StackEventHandler extends Construct {

    constructor(scope: Construct, id: string, props: EventProps) {
        super(scope, id);

        const onEventHandler = new lambda.Function(this, 'OnEventHandler', { /* ... */
            runtime: lambda.Runtime.PYTHON_3_8,
            code: lambda.Code.fromAsset(path.join(__dirname, '../lambda')),
            handler: 'lambda_event_handler.lambda_handler',
            memorySize: 256,
            timeout: Duration.minutes(15),
        });

        const taskDefArnNoVersion = Stack.of(this).formatArn({
            service: 'ecs',
            resource: 'task-definition',
            resourceName: props.taskDefinition.family
        })

        onEventHandler.addToRolePolicy(new iam.PolicyStatement({
            actions: ['ecs:RunTask'],
            effect: iam.Effect.ALLOW,
            resources: [taskDefArnNoVersion]
        }))

        onEventHandler.addToRolePolicy(new iam.PolicyStatement({
            actions: ['ecs:ListTasks'],
            effect: iam.Effect.ALLOW,
            resources: ['*']
        }))

        onEventHandler.addToRolePolicy(new iam.PolicyStatement({
            actions: ["S3:PutBucketNotification", "S3:GetBucketNotification"],
            resources: [props.bucket.bucketArn],
        }))

        props.taskDefinition.taskRole.grantPassRole(onEventHandler.grantPrincipal)
        props.taskDefinition.executionRole?.grantPassRole(onEventHandler.grantPrincipal)


        const lambdaProvider = new cr.Provider(this, 'Provider', {
            onEventHandler: onEventHandler,
            // logRetention: logs.RetentionDays.ONE_DAY   // default is INFINITE
        });

        new CustomResource(this, 'DRHS3CustomResource', {
            serviceToken: lambdaProvider.serviceToken,
            properties: {
                'cluster_name': props.ecsClusterName,
                'family': props.taskDefinition.family,
                'subnets': props.ecsSubnetIds,
                'security_group': props.securityGroupName,
                'bucket_name': props.bucket.bucketName,
                'prefix': props.prefix,
                'queue_arn': props.queue.queueArn,
                'enable_s3_event': props.enableS3Event,
                'job_type': props.jobType,
                'stack_name': Aws.STACK_NAME,
            }
        });

    }

}


