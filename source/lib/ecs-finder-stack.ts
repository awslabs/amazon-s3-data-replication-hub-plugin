/*
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/


import { Construct, Duration, Aws, CfnMapping, CfnOutput, CustomResource, Stack } from '@aws-cdk/core';
import * as events from '@aws-cdk/aws-events';
import * as targets from '@aws-cdk/aws-events-targets';
import * as ecs from '@aws-cdk/aws-ecs';
import * as ec2 from '@aws-cdk/aws-ec2';
import * as lambda from '@aws-cdk/aws-lambda';
import * as iam from '@aws-cdk/aws-iam';
import * as cr from "@aws-cdk/custom-resources";
import { CfnLogGroup, RetentionDays, LogGroup } from '@aws-cdk/aws-logs';

import * as path from 'path';

import { addCfnNagSuppressRules } from "./main-stack";

export interface Env {
    [key: string]: any;
}

export interface EcsTaskProps {
    readonly env: Env,
    readonly vpc: ec2.IVpc,
    // readonly ecsVpcId: string,
    readonly ecsSubnetIds: string[],
    readonly ecsClusterName: string,
    readonly cpu?: number,
    readonly memory?: number,
    readonly cliRelease: string,
}

export class EcsStack extends Construct {

    readonly taskDefinition: ecs.TaskDefinition
    readonly securityGroup: ec2.SecurityGroup

    constructor(scope: Construct, id: string, props: EcsTaskProps) {
        super(scope, id);

        const image = `public.ecr.aws/aws-gcr-solutions/data-transfer-hub-cli:${props.cliRelease}`

        const ecsLG = new LogGroup(this, 'FinderLogGroup', {
            retention: RetentionDays.TWO_WEEKS,
            // removalPolicy: RemovalPolicy.DESTROY
        });

        const cfnEcsLG = ecsLG.node.defaultChild as CfnLogGroup
        addCfnNagSuppressRules(cfnEcsLG, [
            {
                id: 'W84',
                reason: 'log group is encrypted with the default master key'
            }
        ])

        this.taskDefinition = new ecs.FargateTaskDefinition(this, 'JobFinderTaskDef', {
            cpu: props.cpu ? props.cpu : 1024 * 4,
            memoryLimitMiB: props.memory ? props.memory : 1024 * 8,
            family: `${Aws.STACK_NAME}-DTHFinderTask`,
        });

        this.taskDefinition.addContainer('DefaultContainer', {
            image: ecs.ContainerImage.fromRegistry(image),
            environment: props.env,
            logging: ecs.LogDrivers.awsLogs({
                streamPrefix: 'ecsJobSender',
                logGroup: ecsLG,
            })
        });

        const cluster = ecs.Cluster.fromClusterAttributes(this, 'ECSCluster', {
            clusterName: props.ecsClusterName,
            vpc: props.vpc,
            securityGroups: []
        })

        this.securityGroup = new ec2.SecurityGroup(this, 'S3RepECSSG', {
            vpc: props.vpc,
            description: `Security Group for running ${Aws.STACK_NAME}-DTHFinderTask`,
            allowAllOutbound: true
        });

        const cfnSG = this.securityGroup.node.defaultChild as ec2.CfnSecurityGroup
        addCfnNagSuppressRules(cfnSG, [
            {
                id: 'W5',
                reason: 'Open egress rule is required to access public network'
            },
            {
                id: 'W40',
                reason: 'Open egress rule is required to access public network'
            },
        ])

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

        const cfnFn = onEventHandler.node.defaultChild as lambda.CfnFunction
        addCfnNagSuppressRules(cfnFn, [
            {
                id: 'W58',
                reason: 'False alarm: The Lambda function does have the permission to write CloudWatch Logs.'
            }, {
                id: 'W92',
                reason: 'No concurrencies required for this function'
            }, {
                id: 'W89',
                reason: 'This function does not need to be deployed in a VPC'
            }
        ])

        onEventHandler.node.addDependency(this.taskDefinition)

        const taskDefArnNoVersion = Stack.of(this).formatArn({
            service: 'ecs',
            resource: 'task-definition',
            resourceName: this.taskDefinition.family
        })


        const ecsTaskPolicy = new iam.Policy(this, 'ECSTaskPolicy', {
            statements: [
                new iam.PolicyStatement({
                    actions: ['ecs:ListTasks'],
                    effect: iam.Effect.ALLOW,
                    resources: ['*']
                }),
                new iam.PolicyStatement({
                    actions: ['ecs:RunTask'],
                    effect: iam.Effect.ALLOW,
                    resources: [taskDefArnNoVersion]
                })
            ]
        });

        const cfnEcsTaskPolicy = ecsTaskPolicy.node.defaultChild as iam.CfnPolicy
        addCfnNagSuppressRules(cfnEcsTaskPolicy, [
            {
                id: 'W12',
                reason: 'List Task Action requires any resources'
            },
        ])

        onEventHandler.role?.attachInlinePolicy(ecsTaskPolicy)

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