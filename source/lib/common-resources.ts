import { Construct, Duration, RemovalPolicy, CfnOutput } from '@aws-cdk/core';
import * as ddb from '@aws-cdk/aws-dynamodb';
import * as sqs from '@aws-cdk/aws-sqs';
import * as cw from '@aws-cdk/aws-cloudwatch';
import * as actions from '@aws-cdk/aws-cloudwatch-actions';
import * as sns from '@aws-cdk/aws-sns';
import * as sub from '@aws-cdk/aws-sns-subscriptions';

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
            removalPolicy: RemovalPolicy.DESTROY
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
                reason: 'No need to use encryption'
            }
        ]);
        cfnJobTable.overrideLogicalId('S3TransferTable')

        // Setup SQS
        const sqsQueueDLQ = new sqs.Queue(this, 'S3TransferQueueDLQ', {
            visibilityTimeout: Duration.minutes(15),
            retentionPeriod: Duration.days(14),
        })

        const cfnSqsQueueDLQ = sqsQueueDLQ.node.defaultChild as sqs.CfnQueue;
        cfnSqsQueueDLQ.overrideLogicalId('S3TransferQueueDLQ')
        addCfnNagSuppressRules(cfnSqsQueueDLQ, [
            {
                id: 'W48',
                reason: 'No need to use encryption'
            }
        ]);

        this.sqsQueue = new sqs.Queue(this, 'S3TransferQueue', {
            visibilityTimeout: Duration.minutes(30),
            retentionPeriod: Duration.days(14),
            deadLetterQueue: {
                queue: sqsQueueDLQ,
                maxReceiveCount: 5
            }
        })

        const cfnSqsQueue = this.sqsQueue.node.defaultChild as sqs.CfnQueue;
        addCfnNagSuppressRules(cfnSqsQueue, [
            {
                id: 'W48',
                reason: 'No need to use encryption'
            }
        ]);

        cfnSqsQueue.overrideLogicalId('S3TransferQueue')

        // Setup Alarm for queue - DLQ
        const alarmDLQ = new cw.Alarm(this, 'SQSDLQAlarm', {
            metric: sqsQueueDLQ.metricApproximateNumberOfMessagesVisible(),
            threshold: 0,
            comparisonOperator: cw.ComparisonOperator.GREATER_THAN_THRESHOLD,
            evaluationPeriods: 1,
            datapointsToAlarm: 1
        });
        const alarmTopic = new sns.Topic(this, 'SQS queue-DLQ has dead letter');
        alarmTopic.addSubscription(new sub.EmailSubscription(props.alarmEmail));
        alarmDLQ.addAlarmAction(new actions.SnsAction(alarmTopic));

        const cfnAlarmTopic = alarmTopic.node.defaultChild as sns.CfnTopic;
        addCfnNagSuppressRules(cfnAlarmTopic, [
            {
                id: 'W47',
                reason: 'No need to use encryption'
            }
        ]);

        new CfnOutput(this, 'QueueName', {
            value: this.sqsQueue.queueName,
            description: 'Queue Name'
        })

        new CfnOutput(this, 'DLQQueueName', {
            value: sqsQueueDLQ.queueName,
            description: 'Dead Letter Queue Name'
        })
    }

}