import { Construct, Fn, Duration, Aws, CfnMapping, CfnOutput, CustomResource, Stack } from '@aws-cdk/core';
import * as events from '@aws-cdk/aws-events';
import * as targets from '@aws-cdk/aws-events-targets';
import * as ecs from '@aws-cdk/aws-ecs';
import * as ec2 from '@aws-cdk/aws-ec2';
import * as ecr from '@aws-cdk/aws-ecr';
import * as lambda from '@aws-cdk/aws-lambda';
import * as iam from '@aws-cdk/aws-iam';
import * as cr from "@aws-cdk/custom-resources";
import { RetentionDays, LogGroup, FilterPattern } from '@aws-cdk/aws-logs';

import * as path from 'path';

export interface Env {
    [key: string]: any;
}

export interface EcsTaskProps {
    readonly env: Env,
    readonly vpc: ec2.IVpc,
    // readonly ecsVpcId: string,
    readonly ecsSubnetIds: string[],
    readonly ecsClusterName: string,
    readonly version?: string,
    readonly cpu?: number,
    readonly memory?: number,
}

export class EcsStack extends Construct {

    readonly taskDefinition: ecs.TaskDefinition
    readonly securityGroup: ec2.SecurityGroup

    constructor(scope: Construct, id: string, props: EcsTaskProps) {
        super(scope, id);

        const repoTable = new CfnMapping(this, 'ECRRepoTable', {
            mapping: {
                'aws': {
                    repoArn: 'arn:aws:ecr:us-west-2:627627941158:repository/s3-replication-cli',
                },
                'aws-cn': {
                    repoArn: 'arn:aws-cn:ecr:cn-northwest-1:382903357634:repository/s3-replication-cli',
                },
            }
        });

        const ecrRepositoryArn = repoTable.findInMap(Aws.PARTITION, 'repoArn')

        // const repo = ecr.Repository.fromRepositoryArn(this, 'JobFinderRepo', ecrRepositoryArn)
        const repo = ecr.Repository.fromRepositoryAttributes(this, 'JobFinderRepo', {
            repositoryArn: ecrRepositoryArn,
            repositoryName: 's3-replication-cli'
        })
        this.taskDefinition = new ecs.FargateTaskDefinition(this, 'JobFinderTaskDef', {
            cpu: props.cpu ? props.cpu : 1024 * 4,
            memoryLimitMiB: props.memory ? props.memory : 1024 * 8,
            family: `${Aws.STACK_NAME}-DTHFinderTask`,
        });


        this.taskDefinition.addContainer('DefaultContainer', {
            image: ecs.ContainerImage.fromEcrRepository(repo, props.version),
            environment: props.env,
            logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'ecsJobSender', logRetention: RetentionDays.TWO_WEEKS })
        });

        // Get existing ecs cluster.
        // const vpc = ec2.Vpc.fromVpcAttributes(this, 'ECSVpc', {
        //     vpcId: props.ecsVpcId, //ecsVpcId.valueAsString,
        //     availabilityZones: Fn.getAzs(),
        //     publicSubnetIds: props.ecsSubnetIds, //ecsSubnets.valueAsList
        // })

        const cluster = ecs.Cluster.fromClusterAttributes(this, 'ECSCluster', {
            clusterName: props.ecsClusterName,
            vpc: props.vpc,
            securityGroups: []
        })

        this.securityGroup = new ec2.SecurityGroup(this, 'SecurityGroup', {
            vpc: props.vpc,
            securityGroupName: `${Aws.STACK_NAME}-ECS-TASK-SG`,
            description: `Security Group for running ${Aws.STACK_NAME}-DTHFinderTask`,
            allowAllOutbound: true
        });

        // 8. CloudWatch Rule. 
        // Schedule CRON event to trigger JobSender per hour
        const trigger = new events.Rule(this, 'DTHFinderSchedule', {
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

        const onEventHandler = new lambda.Function(this, 'EventHandler', {
            runtime: lambda.Runtime.PYTHON_3_8,
            code: lambda.Code.fromAsset(path.join(__dirname, '../lambda')),
            handler: 'lambda_event_handler.lambda_handler',
            memorySize: 256,
            timeout: Duration.minutes(15),
        });

        onEventHandler.node.addDependency(this.taskDefinition)

        const taskDefArnNoVersion = Stack.of(this).formatArn({
            service: 'ecs',
            resource: 'task-definition',
            resourceName: this.taskDefinition.family
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

        this.taskDefinition.taskRole.grantPassRole(onEventHandler.grantPrincipal)
        this.taskDefinition.executionRole?.grantPassRole(onEventHandler.grantPrincipal)


        const lambdaProvider = new cr.Provider(this, 'Provider', {
            onEventHandler: onEventHandler,
        });

        lambdaProvider.node.addDependency(this.taskDefinition)

        const ecsCr = new CustomResource(this, 'DRHS3CustomResource', {
            serviceToken: lambdaProvider.serviceToken,
            properties: {
                'cluster_name': props.ecsClusterName,
                'family': this.taskDefinition.family,
                'subnets': props.ecsSubnetIds,
                'security_group': this.securityGroup.securityGroupName,
                'stack_name': Aws.STACK_NAME,
            }
        });

        ecsCr.node.addDependency(lambdaProvider, this.taskDefinition)

        new CfnOutput(this, 'TaskDefinitionName', {
            value: this.taskDefinition.family,
            description: 'Task Definition Name'
        })

    }

}