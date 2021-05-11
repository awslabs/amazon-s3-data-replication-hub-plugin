import { Construct, Duration, Aws} from '@aws-cdk/core';
import * as sqs from '@aws-cdk/aws-sqs';
import { SqsEventSource } from "@aws-cdk/aws-lambda-event-sources";
import * as lambda from '@aws-cdk/aws-lambda';
import * as path from 'path';

import { RetentionDays, FilterPattern } from '@aws-cdk/aws-logs';

export interface Env {
    [key: string]: any;
}

export interface LambdaWorkerProps {
    readonly env: Env,
    readonly sqsQueue: sqs.Queue
    readonly lambdaMemory?: number,
}

export class LambdaWorkerStack extends Construct {

    readonly handler: lambda.Function

    constructor(scope: Construct, id: string, props: LambdaWorkerProps) {
        super(scope, id);

        // 6. Setup Worker Lambda functions
        const layer = new lambda.LayerVersion(this, 'MigrationLayer', {
            code: lambda.Code.fromAsset(path.join(__dirname, '../../custom-resources'), {
                bundling: {
                    image: lambda.Runtime.PYTHON_3_8.bundlingDockerImage,
                    command: [
                        'bash', '-c',
                        [
                            'cd common',
                            `python setup.py sdist`,
                            `mkdir /asset-output/python`,
                            `pip install dist/migration_lib-1.0.0.tar.gz --target /asset-output/python`,
                        ].join(' && '),
                    ],
                },
            }),
            compatibleRuntimes: [lambda.Runtime.PYTHON_3_8],
            description: 'Migration Lambda layer',
        });

        this.handler = new lambda.Function(this, 'S3MigrationWorker', {
            runtime: lambda.Runtime.PYTHON_3_8,
            code: lambda.Code.fromAsset(path.join(__dirname, '../../custom-resources/lambda')),
            layers: [layer],
            handler: 'worker_handler.lambda_handler',
            memorySize: props.lambdaMemory,
            timeout: Duration.minutes(15),
            tracing: lambda.Tracing.ACTIVE,
            environment: props.env,
            logRetention: RetentionDays.TWO_WEEKS,
        })

        this.handler.addEventSource(new SqsEventSource(props.sqsQueue, {
            batchSize: 1
        }));

        // Create Custom Matrix by log filters

        this.handler.logGroup.addMetricFilter('CompletedBytes', {
            metricName: 'CompletedBytes',
            metricNamespace: `${Aws.STACK_NAME}`,
            metricValue: '$bytes',
            filterPattern: FilterPattern.literal('[level, date, sn, p="----->Complete", bytes, key]')
        })

        this.handler.logGroup.addMetricFilter('CompletedObjects', {
            metricName: 'CompletedObjects',
            metricNamespace: `${Aws.STACK_NAME}`,
            metricValue: '$n',
            filterPattern: FilterPattern.literal('[level, date, sn, p="----->Transferred", n, ...]')
        })

        this.handler.logGroup.addMetricFilter('MaxMemoryUsed', {
            metricName: 'MaxMemoryUsed',
            metricNamespace: `${Aws.STACK_NAME}`,
            metricValue: '$memory',
            filterPattern: FilterPattern.literal('[head="REPORT", a1, a2, a3, a4, a5, a6, a7, a8, a9, a10, a11, a12, a13, a14, a15, a16, memory, MB="MB", rest]')
        })


    }

}