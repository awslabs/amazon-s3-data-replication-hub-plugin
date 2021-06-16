import { Construct, Duration, RemovalPolicy, CfnOutput, Aws } from '@aws-cdk/core';
import * as ddb from '@aws-cdk/aws-dynamodb';
import * as sqs from '@aws-cdk/aws-sqs';
import * as cw from '@aws-cdk/aws-cloudwatch';
import * as actions from '@aws-cdk/aws-cloudwatch-actions';
import * as sns from '@aws-cdk/aws-sns';
import * as sub from '@aws-cdk/aws-sns-subscriptions';
import * as kms from '@aws-cdk/aws-kms'
import * as iam from '@aws-cdk/aws-iam';

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

        // this.jobTable.addGlobalSecondaryIndex({
        //     partitionKey: { name: 'desBucket', type: ddb.AttributeType.STRING },
        //     indexName: 'desBucket-index',
        //     projectionType: ddb.ProjectionType.INCLUDE,
        //     nonKeyAttributes: ['desKey', 'versionId']
        // })

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

        const cfnSqsQueueDLQ = sqsQueueDLQ.node.defaultChild as sqs.CfnQueue;
        cfnSqsQueueDLQ.overrideLogicalId('S3TransferQueueDLQ')

        this.sqsQueue = new sqs.Queue(this, 'S3TransferQueue', {
            visibilityTimeout: Duration.minutes(15),
            retentionPeriod: Duration.days(14),
            deadLetterQueue: {
                queue: sqsQueueDLQ,
                maxReceiveCount: 5
            },
            // encryption: sqs.QueueEncryption.KMS_MANAGED,
        })

        const cfnSqsQueue = this.sqsQueue.node.defaultChild as sqs.CfnQueue;
        cfnSqsQueue.overrideLogicalId('S3TransferQueue')

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
    }

}