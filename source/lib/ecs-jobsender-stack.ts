import { Construct, Fn, Duration, Stack, Aws } from '@aws-cdk/core';
import * as events from '@aws-cdk/aws-events';
import * as targets from '@aws-cdk/aws-events-targets';
import * as cr from '@aws-cdk/custom-resources';
import * as iam from '@aws-cdk/aws-iam';
import * as ecs from '@aws-cdk/aws-ecs';
import * as ec2 from '@aws-cdk/aws-ec2';
import * as ecr from '@aws-cdk/aws-ecr';
import * as lambda from '@aws-cdk/aws-lambda';
import * as path from 'path';

import { JobDetails } from './aws-data-replication-component-s3-stack';


export interface EcsTaskProps {
    readonly job: JobDetails,
    readonly ecsVpcId: string,
    readonly ecsSubnetIds: string[],
    readonly ecsClusterName: string,
    readonly cpu?: number,
    readonly memory?: number,
}

export class EcsStack extends Construct {

    readonly taskDefinition: ecs.TaskDefinition

    constructor(scope: Construct, id: string, props: EcsTaskProps) {
        super(scope, id);

        // 7. Setup JobSender ECS Task
        const ecrRepositoryArn = 'arn:aws:ecr:us-west-2:627627941158:repository/s3-replication-jobsender'
        // const repo = ecr.Repository.fromRepositoryName(this, 'JobSenderRepo', 's3-replication-jobsender')
        const repo = ecr.Repository.fromRepositoryArn(this, 'JobSenderRepo', ecrRepositoryArn)
        this.taskDefinition = new ecs.FargateTaskDefinition(this, 'JobSenderTaskDef', {
            cpu: props.cpu ? props.cpu : 1024 * 4,
            memoryLimitMiB: props.memory ? props.memory : 1024 * 8,
            family: `${Aws.STACK_NAME}-S3ReplicationTask`,
        });
        this.taskDefinition.addContainer('DefaultContainer', {
            image: ecs.ContainerImage.fromEcrRepository(repo),
            environment: {
                AWS_DEFAULT_REGION: Aws.REGION,
                // TABLE_QUEUE_NAME: props.tableName,
                SQS_QUEUE_NAME: props.job.queueName,
                SSM_PARAMETER_CREDENTIALS: props.job.credParamName,
                SRC_BUCKET_NAME: props.job.srcBucketName,
                SRC_BUCKET_PREFIX: props.job.srcPrefix,
                DEST_BUCKET_NAME: props.job.destBucketName,
                DEST_BUCKET_PREFIX: props.job.destPrefix,
                JOB_TYPE: props.job.jobType,
                SOURCE_TYPE: props.job.sourceType,
            },
            logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'ecsJobSender' })
        });


        // Get existing ecs cluster.
        const vpc = ec2.Vpc.fromVpcAttributes(this, 'ECSVpc', {
            vpcId: props.ecsVpcId, //ecsVpcId.valueAsString,
            availabilityZones: Fn.getAzs(),
            publicSubnetIds: props.ecsSubnetIds, //ecsSubnets.valueAsList

        })

        const cluster = ecs.Cluster.fromClusterAttributes(this, 'ECSCluster', {
            clusterName: props.ecsClusterName, // ecsClusterName.valueAsString,
            vpc: vpc,
            securityGroups: []
        })

        const ecsSg = new ec2.SecurityGroup(this, 'SecurityGroup', {
            vpc,
            securityGroupName: `${Aws.STACK_NAME}-ECS-TASK-SG`,
            description: `Security Group for running ${Aws.STACK_NAME}-S3ReplicationTask`,
            allowAllOutbound: true   // Can be set to false
        });

        // 8. CloudWatch Rule. 
        // Schedule CRON event to trigger JobSender per hour
        const trigger = new events.Rule(this, 'CronTriggerJobSender', {
            schedule: events.Schedule.rate(Duration.hours(1)),
        })

        // Add target to cloudwatch rule.
        trigger.addTarget(new targets.EcsTask({
            cluster: cluster,
            taskDefinition: this.taskDefinition,
            taskCount: 1,
            subnetSelection: {
                subnetType: ec2.SubnetType.PUBLIC,
            },
            securityGroups: [ecsSg]
        }));

        const ecsTriggerLambda = new lambda.Function(this, 'ECSTriggerLambda', {
            runtime: lambda.Runtime.PYTHON_3_8,
            code: lambda.Code.fromAsset(path.join(__dirname, '../lambda')),
            // layers: [layer],
            handler: 'lambda_ecs_trigger.lambda_handler',
            memorySize: 256,
            timeout: Duration.minutes(15),
            // tracing: lambda.Tracing.ACTIVE,
            environment: {
                CLUSTER_NAME: props.ecsClusterName,
                TASK_ARN: this.taskDefinition.taskDefinitionArn,
                FAMILY: this.taskDefinition.family,
                SUBNETS: Fn.join(',', props.ecsSubnetIds),
                SECURITY_GROUP: ecsSg.securityGroupId,
                LOG_LEVEL: 'INFO',
            }
        })

        const taskDefArnNoVersion = Stack.of(this).formatArn({
            service: 'ecs',
            resource: 'task-definition',
            resourceName: this.taskDefinition.family
        })

        ecsTriggerLambda.addToRolePolicy(new iam.PolicyStatement({
            actions: ['ecs:RunTask'],
            effect: iam.Effect.ALLOW,
            resources: [taskDefArnNoVersion]
        }))

        ecsTriggerLambda.addToRolePolicy(new iam.PolicyStatement({
            actions: ['ecs:ListTasks'],
            effect: iam.Effect.ALLOW,
            resources: ['*']
        }))

        this.taskDefinition.taskRole.grantPassRole(ecsTriggerLambda.grantPrincipal)
        this.taskDefinition.executionRole?.grantPassRole(ecsTriggerLambda.grantPrincipal)


        const jobSenderTrigger = new cr.AwsCustomResource(this, 'JobSenderTrigger', {
            resourceType: 'Custom::CustomResource',
            policy: cr.AwsCustomResourcePolicy.fromStatements([new iam.PolicyStatement({
                actions: ['lambda:InvokeFunction'],
                effect: iam.Effect.ALLOW,
                resources: [ecsTriggerLambda.functionArn]
            })]),
            timeout: Duration.minutes(15),
            onCreate: {
                service: 'Lambda',
                action: 'invoke',
                parameters: {
                    FunctionName: ecsTriggerLambda.functionName,
                    InvocationType: 'Event'
                },
                physicalResourceId: cr.PhysicalResourceId.of('JobSenderTriggerPhysicalId')
            },
        })

        jobSenderTrigger.node.addDependency(this.taskDefinition)
    }

}