import { Construct, Duration, Aws } from '@aws-cdk/core';

import * as lambda from '@aws-cdk/aws-lambda';
import * as logs from '@aws-cdk/aws-logs';
import * as cw from '@aws-cdk/aws-cloudwatch';
import * as sqs from '@aws-cdk/aws-sqs';


export interface DBProps {
    // readonly logGroups: logs.LogGroup,
    readonly handler: lambda.Function
    readonly queue: sqs.Queue
    readonly queueDLQ: sqs.Queue
}

export class DashboardStack extends Construct {

    readonly dashboard: cw.Dashboard

    constructor(scope: Construct, id: string, props: DBProps) {
        super(scope, id);

        // Setup Cloudwatch Dashboard
        // Create Lambda logs filter to create network traffic metric
        const lambdaFunctionLogs = new logs.LogGroup(this, 'props.handlerLogGroup', {
            logGroupName: `/aws/lambda/${props.handler.functionName}`,
            retention: logs.RetentionDays.TWO_WEEKS
        });

        // // const cfnLambdaFunctionLogs = lambdaFunctionLogs.node.defaultChild as logs.CfnLogGroup;
        // // cfnLambdaFunctionLogs.retentionInDays = logs.RetentionDays.TWO_WEEKS;

        lambdaFunctionLogs.addMetricFilter('Completed-Bytes', {
            metricName: 'Completed-Bytes',
            metricNamespace: 's3_migrate',
            metricValue: '$bytes',
            filterPattern: logs.FilterPattern.literal('[info, date, sn, p="----->Complete", bytes, key]')
        })
        // lambdaFunctionLogs.addMetricFilter('Uploading-bytes', {
        //     metricName: 'Uploading-bytes',
        //     metricNamespace: 's3_migrate',
        //     metricValue: '$bytes',
        //     filterPattern: logs.FilterPattern.literal('[info, date, sn, p="----->Uploading", bytes, key]')
        // })
        // lambdaFunctionLogs.addMetricFilter('Downloading-bytes', {
        //     metricName: 'Downloading-bytes',
        //     metricNamespace: 's3_migrate',
        //     metricValue: '$bytes',
        //     filterPattern: logs.FilterPattern.literal('[info, date, sn, p="----->Downloading", bytes, key]')
        // })
        lambdaFunctionLogs.addMetricFilter('MaxMemoryUsed', {
            metricName: 'MaxMemoryUsed',
            metricNamespace: 's3_migrate',
            metricValue: '$memory',
            filterPattern: logs.FilterPattern.literal('[head="REPORT", a1, a2, a3, a4, a5, a6, a7, a8, a9, a10, a11, a12, a13, a14, a15, a16, memory, MB="MB", rest]')
        })
        const lambdaMetricComplete = new cw.Metric({
            namespace: 's3_migrate',
            metricName: 'Completed-bytes',
            statistic: 'Sum',
            period: Duration.minutes(1)
        })
        const lambdaMetricUpload = new cw.Metric({
            namespace: 's3_migrate',
            metricName: 'Uploading-bytes',
            statistic: 'Sum',
            period: Duration.minutes(1)
        })
        const lambdaMetricDownload = new cw.Metric({
            namespace: 's3_migrate',
            metricName: 'Downloading-bytes',
            statistic: 'Sum',
            period: Duration.minutes(1)
        })
        const lambdaMetricMaxMemoryUsed = new cw.Metric({
            namespace: 's3_migrate',
            metricName: 'MaxMemoryUsed',
            statistic: 'Maximum',
            period: Duration.minutes(1)
        })
        lambdaFunctionLogs.addMetricFilter('Error', {
            metricName: 'ERROR-Logs',
            metricNamespace: 's3_migrate',
            metricValue: '1',
            filterPattern: logs.FilterPattern.literal('"ERROR"')
        })
        lambdaFunctionLogs.addMetricFilter('WARNING', {
            metricName: 'WARNING-Logs',
            metricNamespace: 's3_migrate',
            metricValue: '1',
            filterPattern: logs.FilterPattern.literal('"WARNING"')
        })
        lambdaFunctionLogs.addMetricFilter('TIMEOUT', {
            metricName: 'TIMEOUT-Logs',
            metricNamespace: 's3_migrate',
            metricValue: '1',
            filterPattern: logs.FilterPattern.literal('"Task time out"')
        })
        const logMetricError = new cw.Metric({
            namespace: 's3_migrate',
            metricName: 'ERROR-Logs',
            statistic: 'SUM',
            period: Duration.minutes(1)
        })
        const logMetricWarning = new cw.Metric({
            namespace: 's3_migrate',
            metricName: 'WARNING-Logs',
            statistic: 'Sum',
            period: Duration.minutes(1)
        })
        const logMetricTimeout = new cw.Metric({
            namespace: 's3_migrate',
            metricName: 'TIMEOUT-Logs',
            statistic: 'Sum',
            period: Duration.minutes(1)
        })

        // Dashboard to monitor SQS and Lambda
        this.dashboard = new cw.Dashboard(this, 'S3Migration', {
            dashboardName: `${Aws.STACK_NAME}-Dashboard`
        });

        this.dashboard.addWidgets(
            new cw.GraphWidget({
                title: 'Lambda-NETWORK',
                left: [lambdaMetricDownload, lambdaMetricUpload, lambdaMetricComplete]
            }),
            new cw.GraphWidget({
                title: 'Lambda-concurrent',
                left: [props.handler.metric('ConcurrentExecutions', { period: Duration.minutes(1) })]
            }),
            new cw.GraphWidget({
                title: 'Lambda-invocations/errors/throttles',
                left: [
                    props.handler.metricInvocations({ period: Duration.minutes(1) }),
                    props.handler.metricErrors({ period: Duration.minutes(1) }),
                    props.handler.metricThrottles({ period: Duration.minutes(1) })
                ]
            }),
            new cw.GraphWidget({
                title: 'Lambda-duration',
                left: [props.handler.metricDuration({ period: Duration.minutes(1) })]
            })
        )

        this.dashboard.addWidgets(
            new cw.GraphWidget({
                title: 'Lambda_MaxMemoryUsed(MB)',
                left: [lambdaMetricMaxMemoryUsed]
            }),
            new cw.GraphWidget({
                title: 'ERROR/WARNING Logs',
                left: [logMetricError],
                right: [logMetricWarning, logMetricTimeout]
            }),
            new cw.GraphWidget({
                title: 'SQS-Jobs',
                left: [
                    props.queue.metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(1) }),
                    props.queue.metricApproximateNumberOfMessagesNotVisible({ period: Duration.minutes(1) })
                ]
            }),
            new cw.SingleValueWidget({
                title: 'Running/Waiting and Dead Jobs',
                metrics: [
                    props.queue.metricApproximateNumberOfMessagesNotVisible({ period: Duration.minutes(1) }),
                    props.queue.metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(1) }),
                    props.queueDLQ.metricApproximateNumberOfMessagesNotVisible({ period: Duration.minutes(1) }),
                    props.queueDLQ.metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(1) })
                ],
                height: 6
            })
        )


    }

}