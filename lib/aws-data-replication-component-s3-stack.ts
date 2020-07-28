import * as cdk from '@aws-cdk/core';
import * as ssm from '@aws-cdk/aws-ssm';
import * as ddb from '@aws-cdk/aws-dynamodb';
import * as sqs from '@aws-cdk/aws-sqs';
import * as api from '@aws-cdk/aws-apigateway';
import * as lambda from '@aws-cdk/aws-lambda';
import * as path from 'path';
import { SqsEventSource } from "@aws-cdk/aws-lambda-event-sources";
import * as s3 from '@aws-cdk/aws-s3';
import * as events from '@aws-cdk/aws-events';
import * as targets from '@aws-cdk/aws-events-targets';
import * as logs from '@aws-cdk/aws-logs';
import * as cw from '@aws-cdk/aws-cloudwatch';
import * as actions from '@aws-cdk/aws-cloudwatch-actions';
import * as sns from '@aws-cdk/aws-sns';
import * as sub from '@aws-cdk/aws-sns-subscriptions';
import * as cr from '@aws-cdk/custom-resources';
import {AwsCustomResourcePolicy, PhysicalResourceId} from "@aws-cdk/custom-resources";
import * as iam from '@aws-cdk/aws-iam';

const bucket_para = [{
  src_bucket: "aws-data-replication-hub-src",
  src_prefix: "",
  des_bucket: "aws-data-replication-hub-test",
  des_prefix: ""
}]
const StorageClass = 'STANDARD'
const Des_bucket_default = 'aws-data-replication-hub-test'
const Des_prefix_default = ''

const MaxRetry = '20'  // Max retry for requests
const MaxThread = '50'  // Max threads per file
const MaxParallelFile = '1'  // Recommend to be 1 in AWS Lambda
const JobTimeout = '870'  // Timeout for each job, should be less than AWS Lambda timeout
const JobsenderCompareVersionId = 'False'  // Jobsender should compare versioinId of source B3 bucket and versionId in DDB
const UpdateVersionId = 'False'  // get lastest version id from s3 before before get object
const GetObjectWithVersionId = 'False'  // get object together with the specified version id

const alarm_email = "qiaoshi@amazon.com"

// The region credential (not the same account as Lambda) setting in SSM Parameter Store
const ssm_parameter_credentials = 's3_migration_credentials'
/***
 * BEFORE DEPLOY CDK, please setup a "s3_migration_credentials" secure parameter in ssm parameter store MANUALLY!
 * This is the access_key which is not in the same account as ec2.
 * For example, if ec2 running in Global, this is China Account access_key. Example as below:
 * {
 *  "aws_access_key_id": "your_aws_access_key_id",
 *  "aws_secret_access_key": "your_aws_secret_access_key",
 *  "region": "cn-northwest-1"
 * }
 * CDK don not allow to deploy secure para, so you have to do it mannually
 * And then in this template will assign ec2 role to access it.
 * 请在部署CDK前，先在ssm parameter store手工创建一个名为 "s3_migration_credentials" 的 secure parameter：
 * 这个是跟EC2不在一个Account体系下的另一个Account的access_key
 * 例如EC2在Global，则这个是China Account access_key，反之EC2在中国，这就是Global Account
 * CDK 不允许直接部署加密Key，所以你需要先去手工创建，然后在CDK中会赋予EC2角色有读取权限
 */

// 'PUT': Destination Bucket is not the same account as Lambda.
// 'GET': Source bucket is not the same account as Lambda.
const JobType = 'PUT'

export class AwsDataReplicationComponentS3Stack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // 1. Setup SSM parameter of credentials, bucket parameters, ignore_list
    const ssmCredentialsParam = ssm.StringParameter.fromSecureStringParameterAttributes(this, 'SSMParameterCredentials', {
      parameterName: ssm_parameter_credentials,
      version: 1
    });

    const ssmBucketParam = new ssm.StringParameter(this, 'SSMParameterBucket', {
      stringValue: JSON.stringify(bucket_para, null, 2)
    })

    // 2. Setup DynamoDB
    const ddbFileList = new ddb.Table(this, 'S3MigrationTable', {
      partitionKey: { name: 'Key', type: ddb.AttributeType.STRING },
      billingMode: ddb.BillingMode.PAY_PER_REQUEST
    })

    ddbFileList.addGlobalSecondaryIndex({
      partitionKey: { name: 'desBucket', type: ddb.AttributeType.STRING },
      indexName: 'desBucket-index',
      projectionType: ddb.ProjectionType.INCLUDE,
      nonKeyAttributes: [ 'desKey', 'versionId' ]
    })

    // 3. Setup SQS
    const sqsQueueDLQ = new sqs.Queue(this, 'S3MigrationQueueDLQ', {
      visibilityTimeout: cdk.Duration.minutes(15),
      retentionPeriod: cdk.Duration.days(14),
    })

    const sqsQueue = new sqs.Queue(this, 'S3MigrationQueue', {
      visibilityTimeout: cdk.Duration.minutes(15),
      retentionPeriod: cdk.Duration.days(14),
      deadLetterQueue: {
        queue: sqsQueueDLQ,
        maxReceiveCount: 60
      }
    })

    // 4. Setup API for Lambda to get IP address (for debug networking routing purpose)
    const checkip = new api.RestApi(this, 'LambdaCheckIpAPI', {
      cloudWatchRole: true,
      deploy: true,
      description: 'For Lambda get IP address',
      defaultIntegration: new api.MockIntegration({
        integrationResponses: [{
          statusCode: '200',
          responseTemplates: { "application/json": "$context.identity.sourceIp" }
        }],
        requestTemplates: { "application/json": '{"statusCode": 200}' }
      }),
      endpointConfiguration: {
        types: [api.EndpointType.REGIONAL]
      }
    })

    checkip.root.addMethod('GET')

    // 5. Setup Lambda functions

    const handler = new lambda.Function(this, 'S3MigrationWorker', {
      runtime: lambda.Runtime.PYTHON_3_8,
      code: lambda.Code.fromAsset(path.join(__dirname, '../src')),
      handler: 'lambda_function_worker.lambda_handler',
      memorySize: 1024,
      timeout: cdk.Duration.minutes(15),
      tracing: lambda.Tracing.ACTIVE,
      environment: {
        table_queue_name: ddbFileList.tableName,
        Des_bucket_default: Des_bucket_default,
        Des_prefix_default: Des_prefix_default,
        StorageClass: StorageClass,
        checkip_url: checkip.url,
        ssm_parameter_credentials: ssm_parameter_credentials,
        JobType: JobType,
        MaxRetry: MaxRetry,
        MaxThread: MaxThread,
        MaxParallelFile: MaxParallelFile,
        JobTimeout: JobTimeout,
        UpdateVersionId: UpdateVersionId,
        GetObjectWithVersionId: GetObjectWithVersionId
      }
    })

    const handlerJobSender = new lambda.Function(this, 'S3MigrationJobSender', {
      runtime: lambda.Runtime.PYTHON_3_8,
      code: lambda.Code.fromAsset(path.join(__dirname, '../src')),
      handler: "lambda_function_jobsender.lambda_handler",
      memorySize: 1024,
      timeout: cdk.Duration.minutes(15),
      tracing: lambda.Tracing.ACTIVE,
      environment: {
       table_queue_name: ddbFileList.tableName,
       StorageClass: StorageClass,
       checkip_url: checkip.url,
       sqs_queue: sqsQueue.queueName,
       ssm_parameter_credentials: ssm_parameter_credentials,
       ssm_parameter_bucket: ssmBucketParam.parameterName,
       JobType: JobType,
       MaxRetry: MaxRetry,
       JobsenderCompareVersionId: JobsenderCompareVersionId
      }
    })

    ddbFileList.grantReadWriteData(handler);
    ddbFileList.grantReadWriteData(handlerJobSender);
    sqsQueue.grantSendMessages(handlerJobSender);
    handler.addEventSource(new SqsEventSource(sqsQueue, {
      batchSize: 1
    }));

    let bucketName = '';
    bucket_para.forEach( bucket => {
      if (bucketName !== bucket.src_bucket) {
        bucketName = bucket.src_bucket;
        const s3existBucket = s3.Bucket.fromBucketName(this, `Src${bucketName}`, bucketName)
        s3existBucket.grantRead(handler);
        s3existBucket.grantRead(handlerJobSender);
      }
    })

    // Allow Lambda read ssm parameters
    ssmBucketParam.grantRead(handlerJobSender);
    ssmCredentialsParam.grantRead(handler);
    ssmCredentialsParam.grantRead(handlerJobSender);

    // Schedule CRON event to trigger lambda JobSender per hour
    const trigger = new events.Rule(this, 'CronTriggerJobSender', {
      schedule: events.Schedule.rate(cdk.Duration.hours(1)),
      targets: [new targets.LambdaFunction(handlerJobSender)]
    })

    // Create Lambda logs filter to create network traffic metric
    handler.logGroup.addMetricFilter('Completed-bytes', {
      metricName: 'Completed-bytes',
      metricNamespace: 's3_migrate',
      metricValue: '$bytes',
      filterPattern: logs.FilterPattern.literal('[info, date, sn, p="--->Complete", bytes, key]')
    })
    handler.logGroup.addMetricFilter('Uploading-bytes', {
      metricName: 'Uploading-bytes',
      metricNamespace: 's3_migrate',
      metricValue: '$bytes',
      filterPattern: logs.FilterPattern.literal('[info, date, sn, p="--->Uploading", bytes, key]')
    })
    handler.logGroup.addMetricFilter('Downloading-bytes', {
      metricName: 'Downloading-bytes',
      metricNamespace: 's3_migrate',
      metricValue: '$bytes',
      filterPattern: logs.FilterPattern.literal('[info, date, sn, p="--->Downloading", bytes, key]')
    })
    handler.logGroup.addMetricFilter('MaxMemoryUsed', {
      metricName: 'MaxMemoryUsed',
      metricNamespace: 's3_migrate',
      metricValue: '$memory',
      filterPattern: logs.FilterPattern.literal('[head="REPORT", a1, a2, a3, a4, a5, a6, a7, a8, a9, a10, a11, a12, a13, a14, a15, a16, memory, MB="MB", rest]')
    })
    const lambdaMetricComplete = new cw.Metric({
      namespace: 's3_migrate',
      metricName: 'Completed-bytes',
      statistic: 'Sum',
      period: cdk.Duration.minutes(1)
    })
    const lambdaMetricUpload = new cw.Metric({
      namespace: 's3_migrate',
      metricName: 'Uploading-bytes',
      statistic: 'Sum',
      period: cdk.Duration.minutes(1)
    })
    const lambdaMetricDownload = new cw.Metric({
      namespace: 's3_migrate',
      metricName: 'Downloading-bytes',
      statistic: 'Sum',
      period: cdk.Duration.minutes(1)
    })
    const lambdaMetricMaxMemoryUsed = new cw.Metric({
      namespace: 's3_migrate',
      metricName: 'MaxMemoryUsed',
      statistic: 'Maximum',
      period: cdk.Duration.minutes(1)
    })
    handler.logGroup.addMetricFilter('Error', {
      metricName: 'ERROR-Logs',
      metricNamespace: 's3_migrate',
      metricValue: '1',
      filterPattern: logs.FilterPattern.literal('"ERROR"')
    })
    handler.logGroup.addMetricFilter('WARNING', {
      metricName: 'WARNING-Logs',
      metricNamespace: 's3_migrate',
      metricValue: '1',
      filterPattern: logs.FilterPattern.literal('"WARNING"')
    })
    handler.logGroup.addMetricFilter('TIMEOUT', {
      metricName: 'TIMEOUT-Logs',
      metricNamespace: 's3_migrate',
      metricValue: '1',
      filterPattern: logs.FilterPattern.literal('"Task time out"')
    })
    const logMetricError = new cw.Metric({
      namespace: 's3_migrate',
      metricName: 'ERROR-Logs',
      statistic: 'SUM',
      period: cdk.Duration.minutes(1)
    })
    const logMetricWarning = new cw.Metric({
      namespace: 's3_migrate',
      metricName: 'WARNING-Logs',
      statistic: 'Sum',
      period: cdk.Duration.minutes(1)
    })
    const logMetricTimeout = new cw.Metric({
      namespace: 's3_migrate',
      metricName: 'TIMEOUT-Logs',
      statistic: 'Sum',
      period: cdk.Duration.minutes(1)
    })

    // Dashboard to monitor SQS and Lambda
    const board = new cw.Dashboard(this, 'S3Migration');
    board.addWidgets(
      new cw.GraphWidget({
        title: 'Lambda-NETWORK',
        left: [ lambdaMetricDownload, lambdaMetricUpload, lambdaMetricComplete ]
      }),
      new cw.GraphWidget({
        title: 'Lambda-concurrent',
        left: [ handler.metric('ConcurrentExecutions', {period: cdk.Duration.minutes(1)}) ]
      }),
      new cw.GraphWidget({
        title: 'Lambda-invocations/errors/throttles',
        left: [
          handler.metricInvocations({period: cdk.Duration.minutes(1)}),
          handler.metricErrors({period: cdk.Duration.minutes(1)}),
          handler.metricThrottles({period: cdk.Duration.minutes(1)})
        ]
      }),
      new cw.GraphWidget({
        title: 'Lambda-duration',
        left: [ handler.metricDuration({period: cdk.Duration.minutes(1)}) ]
      })
    )

    board.addWidgets(
      new cw.GraphWidget({
        title: 'Lambda_MaxMemoryUsed(MB)',
        left: [ lambdaMetricMaxMemoryUsed ]
      }),
      new cw.GraphWidget({
        title: 'ERROR/WARNING Logs',
        left: [ logMetricError ],
        right: [ logMetricWarning, logMetricTimeout ]
      }),
      new cw.GraphWidget({
        title: 'SQS-Jobs',
        left: [
          sqsQueue.metricApproximateNumberOfMessagesVisible({period: cdk.Duration.minutes(1)}),
          sqsQueue.metricApproximateNumberOfMessagesNotVisible({period: cdk.Duration.minutes(1)})
        ]
      }),
      new cw.SingleValueWidget({
        title: 'Running/Waiting and Dead Jobs',
        metrics: [
          sqsQueue.metricApproximateNumberOfMessagesNotVisible({period: cdk.Duration.minutes(1)}),
          sqsQueue.metricApproximateNumberOfMessagesVisible({period: cdk.Duration.minutes(1)}),
          sqsQueueDLQ.metricApproximateNumberOfMessagesNotVisible({period: cdk.Duration.minutes(1)}),
          sqsQueueDLQ.metricApproximateNumberOfMessagesVisible({period: cdk.Duration.minutes(1)})
        ],
        height: 6
      })
    )

    // Alarm for queue - DLQ
    const alarmDLQ = new cw.Alarm(this, 'SQSDLQAlarm', {
      metric: sqsQueueDLQ.metricApproximateNumberOfMessagesVisible(),
      threshold: 0,
      comparisonOperator: cw.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      datapointsToAlarm: 1
    });
    const alarmTopic = new sns.Topic(this, 'SQS queue-DLQ has dead letter');
    alarmTopic.addSubscription(new sub.EmailSubscription(alarm_email));
    alarmDLQ.addAlarmAction(new actions.SnsAction(alarmTopic));

    // Custom resource to trigger JobSender Lambda once
    const jobSenderTrigger = new cr.AwsCustomResource(this, 'JobSenderTrigger', {
      policy: AwsCustomResourcePolicy.fromStatements([new iam.PolicyStatement({
        actions: ['lambda:InvokeFunction'],
        effect: iam.Effect.ALLOW,
        resources: [handlerJobSender.functionArn]
      })]),
      timeout: cdk.Duration.minutes(15),
      logRetention: logs.RetentionDays.ONE_DAY,
      onCreate: {
        service: 'Lambda',
        action: 'invoke',
        parameters: {
          FunctionName: handlerJobSender.functionName,
          InvocationType: 'Event'
        },
        physicalResourceId: PhysicalResourceId.of('JobSenderTriggerPhysicalId')
      }
    })
    jobSenderTrigger.node.addDependency(handler, handlerJobSender, sqsQueue)

    new cdk.CfnOutput(this, 'Dashboard', {
      value: 'CloudWatch Dashboard name is S3Migration'
    })

    // The code that defines your stack goes here
  }
}
