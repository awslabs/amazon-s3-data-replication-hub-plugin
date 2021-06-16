import { Construct, Duration, Aws } from '@aws-cdk/core';

import * as lambda from '@aws-cdk/aws-lambda';
import * as cw from '@aws-cdk/aws-cloudwatch';
import * as sqs from '@aws-cdk/aws-sqs';

import { RunType } from './main-stack';

export interface DBProps {
    readonly runType: RunType,
    readonly queue: sqs.Queue
    // readonly queueDLQ: sqs.Queue
    readonly asgName?: string
    readonly handler?: lambda.Function
}

export class DashboardStack extends Construct {

    readonly dashboard: cw.Dashboard

    constructor(scope: Construct, id: string, props: DBProps) {
        super(scope, id);

        const completedBytes = new cw.Metric({
            namespace: `${Aws.STACK_NAME}`,
            metricName: 'CompletedBytes',
            statistic: 'Sum',
            period: Duration.minutes(1),
            label: 'Completed(Bytes)'
        })

        const transferredObjects = new cw.Metric({
            namespace: `${Aws.STACK_NAME}`,
            metricName: 'TransferredObjects',
            statistic: 'Sum',
            period: Duration.minutes(1),
            label: 'Transferred(Objects)'
        })

        const failedObjects = new cw.Metric({
            namespace: `${Aws.STACK_NAME}`,
            metricName: 'FailedObjects',
            statistic: 'Sum',
            period: Duration.minutes(1),
            label: 'Failed(Objects)'
        })

        const lambdaMemory = new cw.Metric({
            namespace: `${Aws.STACK_NAME}`,
            metricName: 'MaxMemoryUsed',
            statistic: 'Max',
            period: Duration.minutes(1),
            label: 'Max Memory Used'
        })

        const asgDesired = new cw.Metric({
            namespace: 'AWS/AutoScaling',
            metricName: 'GroupDesiredCapacity',
            dimensions: {
                'AutoScalingGroupName': props.asgName
            },
            statistic: 'Max',
            period: Duration.minutes(1),
            label: 'Desired Capacity'
        })

        const asgInSvc = new cw.Metric({
            namespace: 'AWS/AutoScaling',
            metricName: 'GroupInServiceInstances',
            dimensions: {
                'AutoScalingGroupName': props.asgName
            },
            statistic: 'Max',
            period: Duration.minutes(1),
            label: 'In Service Instances'
        })

        // const asgMax = new cw.Metric({
        //     namespace: 'AWS/AutoScaling',
        //     metricName: 'GroupMaxSize',
        //     dimensions: {
        //         'AutoScalingGroupName': props.asgName
        //     },
        //     statistic: 'Max',
        //     period: Duration.minutes(1),
        //     label: 'Max Capacity'

        // })
        // const asgMin = new cw.Metric({
        //     namespace: 'AWS/AutoScaling',
        //     metricName: 'GroupMinSize',
        //     dimensions: {
        //         'AutoScalingGroupName': props.asgName
        //     },
        //     statistic: 'Max',
        //     period: Duration.minutes(1),
        //     label: 'Min Capacity'
        // })


        const asgNetworkIn = new cw.Metric({
            namespace: 'AWS/EC2',
            metricName: 'NetworkIn',
            dimensions: {
                'AutoScalingGroupName': props.asgName
            },
            statistic: 'Sum',
            period: Duration.minutes(1)
        })
        const asgNetworkOut = new cw.Metric({
            namespace: 'AWS/EC2',
            metricName: 'NetworkOut',
            dimensions: {
                'AutoScalingGroupName': props.asgName
            },
            statistic: 'Sum',
            period: Duration.minutes(1)
        })

        const asgCPU = new cw.Metric({
            namespace: 'AWS/EC2',
            metricName: 'CPUUtilization',
            dimensions: {
                'AutoScalingGroupName': props.asgName
            },
            statistic: 'Average',
            period: Duration.minutes(1),
            label: 'CPU %'
        })

        const asgMemory = new cw.Metric({
            namespace: 'CWAgent',
            metricName: 'mem_used_percent',
            dimensions: {
                'AutoScalingGroupName': props.asgName
            },
            statistic: 'Average',
            period: Duration.minutes(1),
            label: 'MEM %'
        })

        // const asgTcp = new cw.Metric({
        //     namespace: 'CWAgent',
        //     metricName: 'tcp_established',
        //     dimensions: {
        //         'AutoScalingGroupName': props.asgName
        //     },
        //     statistic: 'Sum',
        //     period: Duration.minutes(1)
        // })



        const asgDisk = new cw.Metric({
            namespace: 'CWAgent',
            metricName: 'disk_used_percent',
            dimensions: {
                'AutoScalingGroupName': props.asgName
            },
            statistic: 'Average',
            period: Duration.minutes(1),
            label: 'Disk %'
        })



        // Main Dashboard
        this.dashboard = new cw.Dashboard(this, 'S3Migration', {
            dashboardName: `${Aws.STACK_NAME}-Dashboard-${Aws.REGION}`
        });

        this.dashboard.addWidgets(
            new cw.GraphWidget({
                title: 'Network',
                left: [completedBytes]
            }),

            new cw.GraphWidget({
                title: 'Transferred/Failed Objects',
                left: [transferredObjects, failedObjects]
            }),

            new cw.GraphWidget({
                title: 'Running/Waiting Jobs History',
                left: [
                    props.queue.metricApproximateNumberOfMessagesVisible({
                        period: Duration.minutes(1),
                        label: 'Waiting Jobs'
                    }),
                    props.queue.metricApproximateNumberOfMessagesNotVisible({
                        period: Duration.minutes(1),
                        label: 'Running Jobs'
                    })
                ]
            }),


            new cw.SingleValueWidget({
                title: 'Running/Waiting Jobs',
                metrics: [
                    props.queue.metricApproximateNumberOfMessagesVisible({
                        period: Duration.minutes(1),
                        label: 'Waiting Jobs'
                    }),
                    props.queue.metricApproximateNumberOfMessagesNotVisible({
                        period: Duration.minutes(1),
                        label: 'Running Jobs'
                    })
                ],
                height: 6
            })
        )

        if (props.handler) {

            this.dashboard.addWidgets(
                new cw.GraphWidget({
                    title: 'Max Memory Used(MB)',
                    left: [lambdaMemory]
                }),

                new cw.GraphWidget({
                    title: 'Concurrency',
                    left: [props.handler.metric('ConcurrentExecutions', {
                        period: Duration.minutes(1),
                        statistic: 'Max'
                    }),]
                }),
                new cw.GraphWidget({
                    title: 'Invocations / Errors',
                    left: [
                        props.handler.metricInvocations({
                            period: Duration.minutes(1),
                            statistic: 'Sum'
                        }),
                        props.handler.metricErrors({
                            period: Duration.minutes(1),
                            statistic: 'Sum'
                        }),
                        // props.handler.metricThrottles({ period: Duration.minutes(1) })
                    ]
                }),
                new cw.GraphWidget({
                    title: 'Duration (Average)',
                    left: [props.handler.metricDuration({ period: Duration.minutes(1) })]
                })

            )
        }
        else {

            this.dashboard.addWidgets(
                // new cw.GraphWidget({
                //     title: 'Lambda_MaxMemoryUsed(MB)',
                //     left: [lambdaMetricMaxMemoryUsed]
                // }),
                // new cw.GraphWidget({
                //     title: 'ERROR/WARNING Logs',
                //     left: [logMetricError],
                //     right: [logMetricWarning, logMetricTimeout]
                // }),

                new cw.GraphWidget({
                    title: 'Network In/Out',
                    left: [asgNetworkIn, asgNetworkOut]
                }),

                new cw.GraphWidget({
                    title: 'CPU Utilization (Average)',
                    left: [asgCPU]
                }),

                new cw.GraphWidget({
                    title: 'Memory / Disk (Average)',
                    left: [asgMemory, asgDisk]
                }),


                new cw.GraphWidget({
                    title: 'Desired / InService Instances',
                    left: [asgDesired, asgInSvc]
                }),


            )

        }


    }

}