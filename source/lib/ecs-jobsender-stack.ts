import { Construct, Fn, Duration, Aws } from '@aws-cdk/core';
import * as events from '@aws-cdk/aws-events';
import * as targets from '@aws-cdk/aws-events-targets';
import * as ecs from '@aws-cdk/aws-ecs';
import * as ec2 from '@aws-cdk/aws-ec2';
import * as ecr from '@aws-cdk/aws-ecr';

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
    readonly securityGroup: ec2.SecurityGroup

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
                REGION_NAME: props.job.regionName,
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

        this.securityGroup = new ec2.SecurityGroup(this, 'SecurityGroup', {
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
            securityGroups: [this.securityGroup]
        }));

    }

}