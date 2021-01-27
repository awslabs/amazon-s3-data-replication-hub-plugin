import { Construct, Fn, Duration, Stack, Aws, NestedStack, NestedStackProps } from '@aws-cdk/core';
import * as sqs from '@aws-cdk/aws-sqs';
import { SqsEventSource } from "@aws-cdk/aws-lambda-event-sources";
import * as lambda from '@aws-cdk/aws-lambda';

import * as path from 'path';

export interface Env {
    [key: string]: any;
}

export interface LambdaWorkerProps extends NestedStackProps {
    readonly env: Env,
    readonly sqsQueue: sqs.Queue
    readonly lambdaMemory?: number,
}

export class LambdaWorkerStack extends NestedStack {

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
        })

        // eventTable.grantReadWriteData(handler);
        // s3InCurrentAccount.grantReadWrite(handler);
        this.handler.addEventSource(new SqsEventSource(props.sqsQueue, {
            batchSize: 1
        }));

    }

}