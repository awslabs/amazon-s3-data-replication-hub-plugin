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


import {
    Construct,
} from 'constructs';
import {
    Aws,
    Duration,
    CfnOutput,
    RemovalPolicy,
    aws_iam as iam,
    aws_dynamodb as ddb,
    aws_sqs as sqs,
    aws_cloudwatch as cw,
    aws_cloudwatch_actions as actions,
    aws_sns as sns,
    aws_sns_subscriptions as sub,
    aws_kms as kms
} from 'aws-cdk-lib';
import { NagSuppressions } from "cdk-nag";

import { addCfnNagSuppressRules } from "./main-stack";

export interface CommonProps {
    readonly alarmEmail: string,
}

export class CommonStack extends Construct {

    readonly jobTable: ddb.Table
    readonly sqsQueue: sqs.Queue

    constructor(scope: Construct, id: string, props: CommonProps) {
        super(scope, id);

        // Setup DynamoDB
        this.jobTable = new ddb.Table(this, 'S3TransferTable', {
            partitionKey: { name: 'ObjectKey', type: ddb.AttributeType.STRING },
            billingMode: ddb.BillingMode.PAY_PER_REQUEST,
            removalPolicy: RemovalPolicy.DESTROY,
            encryption: ddb.TableEncryption.DEFAULT,
            pointInTimeRecovery: true,
        })

        const cfnJobTable = this.jobTable.node.defaultChild as ddb.CfnTable;
        addCfnNagSuppressRules(cfnJobTable, [
            {
                id: 'W74',
                reason: 'Use deafult encryption. Encryption key owned by Amazon'
            }
        ]);
        cfnJobTable.overrideLogicalId('S3TransferTable')

        // Setup SQS
        const sqsQueueDLQ = new sqs.Queue(this, 'S3TransferQueueDLQ', {
            visibilityTimeout: Duration.minutes(30),
            retentionPeriod: Duration.days(14),
            encryption: sqs.QueueEncryption.KMS_MANAGED,
        })
        NagSuppressions.addResourceSuppressions(sqsQueueDLQ, [
            { id: "AwsSolutions-SQS3", reason: "it is a DLQ" },
            { id: "AwsSolutions-SQS2", reason: "it is a DLQ" },
            { id: "AwsSolutions-SQS4", reason: "it is a DLQ" },
        ]);

        const cfnSqsQueueDLQ = sqsQueueDLQ.node.defaultChild as sqs.CfnQueue;
        cfnSqsQueueDLQ.overrideLogicalId('S3TransferQueueDLQ')

        this.sqsQueue = new sqs.Queue(this, 'S3TransferQueue', {
            visibilityTimeout: Duration.minutes(15),
            retentionPeriod: Duration.days(14),
            deadLetterQueue: {
                queue: sqsQueueDLQ,
                maxReceiveCount: 5
            },
        })
        NagSuppressions.addResourceSuppressions(this.sqsQueue, [
            { id: "AwsSolutions-SQS2", reason: "this queue only used by DTH solution" },
            { id: "AwsSolutions-SQS4", reason: "this queue only used by DTH solution" },
        ]);

        const cfnSqsQueue = this.sqsQueue.node.defaultChild as sqs.CfnQueue;
        cfnSqsQueue.overrideLogicalId('S3TransferQueue')
        addCfnNagSuppressRules(cfnSqsQueue, [
            {
                id: 'W48',
                reason: 'No need to use encryption'
            }
        ]);

        // Setup Alarm for queue - DLQ
        const alarmDLQ = new cw.Alarm(this, 'S3TransferDLQAlarm', {
            metric: sqsQueueDLQ.metricApproximateNumberOfMessagesVisible(),
            threshold: 0,
            comparisonOperator: cw.ComparisonOperator.GREATER_THAN_THRESHOLD,
            evaluationPeriods: 1,
            datapointsToAlarm: 1
        });

        const snsKey = new kms.Key(this, 'SNSTopicEncryptionKey', {
            enableKeyRotation: true,
            enabled: true,
            alias: `alias/dth/sns/${Aws.STACK_NAME}`,
            // policy: snsKeyPolicy,
            policy: new iam.PolicyDocument({
                assignSids: true,
                statements: [
                    new iam.PolicyStatement({
                        actions: [
                            "kms:GenerateDataKey*",
                            "kms:Decrypt",
                            "kms:Encrypt",
                        ],
                        resources: ["*"],
                        effect: iam.Effect.ALLOW,
                        principals: [
                            new iam.ServicePrincipal("sns.amazonaws.com"),
                            new iam.ServicePrincipal("cloudwatch.amazonaws.com"),
                        ],
                    }),
                    // This policy is in CDK v1, we just move it to here
                    new iam.PolicyStatement({
                        actions: [
                            "kms:Create*",
                            "kms:Describe*",
                            "kms:Enable*",
                            "kms:List*",
                            "kms:Put*",
                            "kms:Update*",
                            "kms:Revoke*",
                            "kms:Disable*",
                            "kms:Get*",
                            "kms:Delete*",
                            "kms:ScheduleKeyDeletion",
                            "kms:CancelKeyDeletion",
                            "kms:GenerateDataKey",
                            "kms:TagResource",
                            "kms:UntagResource"
                        ],
                        resources: ["*"],
                        effect: iam.Effect.ALLOW,
                        principals: [
                            new iam.AccountRootPrincipal()                        
                        ],
                    }),
                ],
            }),

        })

        const alarmTopic = new sns.Topic(this, 'S3TransferAlarmTopic', {
            masterKey: snsKey,
            displayName: `Data Transfer Hub Alarm (${Aws.STACK_NAME})`
        })

        const cfnAlarmTopic = alarmTopic.node.defaultChild as sns.CfnTopic;
        cfnAlarmTopic.overrideLogicalId('S3TransferAlarmTopic')

        alarmTopic.addSubscription(new sub.EmailSubscription(props.alarmEmail));
        alarmDLQ.addAlarmAction(new actions.SnsAction(alarmTopic));


        new CfnOutput(this, 'TableName', {
            value: this.jobTable.tableName,
            description: 'DynamoDB Table Name'
        })

        new CfnOutput(this, 'QueueName', {
            value: this.sqsQueue.queueName,
            description: 'Queue Name'
        })

        new CfnOutput(this, 'DLQQueueName', {
            value: sqsQueueDLQ.queueName,
            description: 'Dead Letter Queue Name'
        })

        new CfnOutput(this, 'AlarmTopicName', {
            value: alarmTopic.topicName,
            description: 'Alarm Topic Name'
        })

        new CfnOutput(this, 'StackName', {
            value: Aws.STACK_NAME,
            description: 'Stack Name'
        })
    }

}