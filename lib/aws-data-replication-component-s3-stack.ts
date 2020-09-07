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
import * as iam from '@aws-cdk/aws-iam';
import * as ecs from '@aws-cdk/aws-ecs';
import * as ec2 from '@aws-cdk/aws-ec2';

const StorageClass = 'STANDARD'
const MaxRetry = '20'  // Max retry for requests
const MaxThread = '50'  // Max threads per file
const MaxParallelFile = '1'  // Recommend to be 1 in AWS Lambda
const JobTimeout = '870'  // Timeout for each job, should be less than AWS Lambda timeout
const IncludeVersion = 'False'  // Whethere versionId should be considered during delta comparation and object migration
/***
 * BEFORE DEPLOY CDK, please setup a "drh-credentials" secure parameter in ssm parameter store MANUALLY!
 * This is the access_key which is not in the same account as ec2.
 * For example, if ec2 running in Global, this is China Account access_key. Example as below:
 * {
 *  "aws_access_key_id": "<Your AccessKeyID>",
 *  "aws_secret_access_key": ""<Your AccessKeySecret>",
 *  "region_name": "cn-northwest-1"
 * }
 * 
 * If source is Aliyun OSS. Example of credentials as below:
 * {
 *  "oss_access_key_id": "<Your AccessKeyID>",
 *  "oss_access_key_secret": "<Your AccessKeySecret>",
 *  "oss_endpoint": "http://oss-cn-hangzhou.aliyuncs.com"
 * }
 */

export class AwsDataReplicationComponentS3Stack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const runType = this.node.tryGetContext('runType');

    // 'PUT': Destination Bucket is not in current account.
    // 'GET': Source bucket is not in current account.
    const jobType = new cdk.CfnParameter(this, 'jobType', {
      description: 'Choose GET if source bucket is not in current account. Otherwise, choose PUT.',
      type: 'String',
      default: 'GET',
      allowedValues: ['PUT', 'GET']
    })

    const sourceType = new cdk.CfnParameter(this, 'sourceType', {
      description: 'Choose migration source, for example, S3 or AliOSS.',
      type: 'String',
      default: 'S3',
      allowedValues: ['S3', 'AliOSS', 'Qiniu']
    })

    const srcBucketName = new cdk.CfnParameter(this, 'srcBucketName', {
      description: 'Source Bucket Name',
      type: 'String'
    })

    const srcBucketPrefix = new cdk.CfnParameter(this, 'srcBucketPrefix', {
      description: 'Source Bucket Object Prefix',
      default: '',
      type: 'String'
    })

    const destBucketName = new cdk.CfnParameter(this, 'destBucketName', {
      description: 'Destination Bucket',
      type: 'String'
    })

    const destBucketPrefix = new cdk.CfnParameter(this, 'destBucketPrefix', {
      description: 'Destination Bucket Object Prefix',
      default: '',
      type: 'String'
    })

    const ecsClusterName = new cdk.CfnParameter(this, 'ecsClusterName', {
      description: 'ECS Cluster Name (Required if runType is ecs)',
      default: '',
      type: 'String'
    })

    const ecsVpcId = new cdk.CfnParameter(this, 'ecsVpcId', {
      description: 'ecs Cluster VPC ID (Required if runType is ecs)',
      default: '',
      type: 'String'
    })

    const ecsPublicSubnets = new cdk.CfnParameter(this, 'ecsPublicSubnets', {
      description: 'ecs Cluster Public Subnet IDs delimited by comma',
      default: '',
      type: 'String'
    })

    // The region credential (not the same account as Lambda) setting in SSM Parameter Store
    const credentialsParameterStore = new cdk.CfnParameter(this, 'credentialsParameterStore', {
      description: 'The Parameter Store used to keep AWS credentials for other regions',
      default: 'drh-credentials',
      type: 'String'
    })

    const alarmEmail = new cdk.CfnParameter(this, 'alarmEmail', {
      allowedPattern: '\\w[-\\w.+]*@([A-Za-z0-9][-A-Za-z0-9]+\\.)+[A-Za-z]{2,14}',
      type: 'String',
      description: 'Errors will be sent to this email.'
    })

    this.templateOptions.metadata = {
      ParameterGroups: [
        {
          Label: { default: 'Source & Destination' },
          Parameters: [srcBucketName.logicalId, srcBucketPrefix.logicalId, destBucketName.logicalId, destBucketPrefix.logicalId, jobType.logicalId, sourceType.logicalId]
        },
        {
          Label: { default: 'ECS Cluster' },
          Parameters: [ecsClusterName.logicalId, ecsVpcId.logicalId, ecsPublicSubnets.logicalId]
        },
        {
          Label: { default: 'Credentials' },
          Parameters: [credentialsParameterStore.logicalId]
        },
        {
          Label: { default: 'Notification' },
          Parameters: [alarmEmail.logicalId]
        }
      ],
      ParameterLabels: {
        [srcBucketName.logicalId]: {
          default: 'Source Bucket Name'
        },
        [srcBucketPrefix.logicalId]: {
          default: 'Source Bucket Prefix'
        },
        [destBucketName.logicalId]: {
          default: 'Destination Bucket Name'
        },
        [destBucketPrefix.logicalId]: {
          default: 'Destination Bucket Prefix'
        },
        [jobType.logicalId]: {
          default: 'Job Type'
        },
        [sourceType.logicalId]: {
          default: 'Source Type'
        },
        [credentialsParameterStore.logicalId]: {
          Default: 'Parameter Store for AWS Credentials'
        },
        [alarmEmail.logicalId]: {
          default: 'Alarm Email'
        },
        [ecsClusterName.logicalId]: {
          Default: 'ECS Cluster Name'
        },
        [ecsVpcId.logicalId]: {
          Default: 'VPC ID to run ECS task'
        },
        [ecsPublicSubnets.logicalId]: {
          Default: 'Public Subnet IDs to run ECS task'
        },
      }
    }

    // 1. Get SSM parameter of credentials
    const ssmCredentialsParam = ssm.StringParameter.fromStringParameterAttributes(this, 'SSMParameterCredentials', {
      parameterName: credentialsParameterStore.valueAsString,
      simpleName: true,
      type: ssm.ParameterType.SECURE_STRING,
      version: 1
    });

    // 2. Setup DynamoDB
    const ddbFileList = new ddb.Table(this, 'S3MigrationTable', {
      partitionKey: { name: 'objectKey', type: ddb.AttributeType.STRING },
      billingMode: ddb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY
    })

    ddbFileList.addGlobalSecondaryIndex({
      partitionKey: { name: 'desBucket', type: ddb.AttributeType.STRING },
      indexName: 'desBucket-index',
      projectionType: ddb.ProjectionType.INCLUDE,
      nonKeyAttributes: ['desKey', 'versionId']
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

    checkip.root.addMethod('GET', undefined, {
      methodResponses: [
        {
          statusCode: '200',
          responseModels: {
            'application/json': api.Model.EMPTY_MODEL
          }
        }
      ]
    })

    // 5. Get bucket
    // PUT - Source bucket in current account and destination in other account
    // GET - Dest bucket in current account and source bucket in other account
    const isGet = new cdk.CfnCondition(this, 'isGet', {
      expression: cdk.Fn.conditionEquals('GET', jobType),
    });

    const bucketName = cdk.Fn.conditionIf(isGet.logicalId, destBucketName.valueAsString, srcBucketName.valueAsString).toString();
    const s3InCurrentAccount = s3.Bucket.fromBucketName(this, `BucketName`, bucketName);

    // 6. Setup Worker Lambda functions
    const layer = new lambda.LayerVersion(this, 'MigrationLayer', {
      code: lambda.Code.fromAsset(path.join(__dirname, '../src'), {
        bundling: {
          image: lambda.Runtime.PYTHON_3_8.bundlingDockerImage,
          command: [
            'bash', '-c', `python setup.py sdist && 
            pip install dist/migration_lib-0.1.0.tar.gz --target /asset-output &&
            cp lambda_function_* /asset-output/`,
          ],
        },
      }),
      compatibleRuntimes: [lambda.Runtime.PYTHON_3_8],
      description: 'Migration Lambda layer',
    });

    const handler = new lambda.Function(this, 'S3MigrationWorker', {
      runtime: lambda.Runtime.PYTHON_3_8,
      code: lambda.Code.fromAsset(path.join(__dirname, '../src')),
      layers: [layer],
      handler: 'lambda_function_worker.lambda_handler',
      memorySize: 1024,
      timeout: cdk.Duration.minutes(15),
      tracing: lambda.Tracing.ACTIVE,
      environment: {
        TABLE_QUEUE_NAME: ddbFileList.tableName,
        SRC_BUCKET_NAME: srcBucketName.valueAsString,
        SRC_BUCKET_PREFIX: srcBucketPrefix.valueAsString,
        DEST_BUCKET_NAME: destBucketName.valueAsString,
        DEST_BUCKET_PREFIX: destBucketPrefix.valueAsString,
        STORAGE_CLASS: StorageClass,
        CHECK_IP_URL: checkip.url,
        SSM_PARAMETER_CREDENTIALS: credentialsParameterStore.valueAsString,
        JOB_TYPE: jobType.valueAsString,
        SOURCE_TYPE: sourceType.valueAsString,
        MAX_RETRY: MaxRetry,
        MAX_THREAD: MaxThread,
        MAX_PARALLEL_FILE: MaxParallelFile,
        JOB_TIMEOUT: JobTimeout,
        INCLUDE_VERSION: IncludeVersion
      }
    })

    ssmCredentialsParam.grantRead(handler);
    ddbFileList.grantReadWriteData(handler);
    s3InCurrentAccount.grantReadWrite(handler);
    handler.addEventSource(new SqsEventSource(sqsQueue, {
      batchSize: 1
    }));

    // 7. CloudWatch Rule. 
    // Schedule CRON event to trigger JobSender per hour
    const trigger = new events.Rule(this, 'CronTriggerJobSender', {
      schedule: events.Schedule.rate(cdk.Duration.hours(1)),
    })

    // 8. Setup JobSender
    // if runType == ecs, use ecs to jobfinder , otherwise use lambda
    if (runType == 'ecs') {
      const taskDefinition = new ecs.FargateTaskDefinition(this, 'JobSenderTaskDef', {
        cpu: 1024 * 4,
        memoryLimitMiB: 1024 * 8,
      });
      taskDefinition.addContainer('DefaultContainer', {
        image: ecs.ContainerImage.fromAsset(path.join(__dirname, '../src')),
        memoryLimitMiB: 1024 * 8,
        environment: {
          AWS_DEFAULT_REGION: this.region,
          TABLE_QUEUE_NAME: ddbFileList.tableName,
          SQS_QUEUE_NAME: sqsQueue.queueName,
          SSM_PARAMETER_CREDENTIALS: credentialsParameterStore.valueAsString,
          SRC_BUCKET_NAME: srcBucketName.valueAsString,
          SRC_BUCKET_PREFIX: srcBucketPrefix.valueAsString,
          DEST_BUCKET_NAME: destBucketName.valueAsString,
          DEST_BUCKET_PREFIX: destBucketPrefix.valueAsString,
          JOB_TYPE: jobType.valueAsString,
          SOURCE_TYPE: sourceType.valueAsString,
          MAX_RETRY: MaxRetry,
          INCLUDE_VERSION: IncludeVersion
        },
        logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'ecsJobSender' })
      });

      ssmCredentialsParam.grantRead(taskDefinition.taskRole)
      ddbFileList.grantReadData(taskDefinition.taskRole);
      sqsQueue.grantSendMessages(taskDefinition.taskRole);
      s3InCurrentAccount.grantReadWrite(taskDefinition.taskRole);

      // Get existing ecs cluster.
      const subnets: string[] = ecsPublicSubnets.valueAsString.split(',')

      const vpc = ec2.Vpc.fromVpcAttributes(this, 'ECSVpc', {
        vpcId: ecsVpcId.valueAsString,
        availabilityZones: this.availabilityZones,
        publicSubnetIds: [subnets[0], subnets[1]]

      })

      const cluster = ecs.Cluster.fromClusterAttributes(this, 'ECSCluster', {
        clusterName: ecsClusterName.valueAsString,
        vpc: vpc,
        securityGroups: []
      })

      // Add target to cloudwatch rule.
      trigger.addTarget(new targets.EcsTask({
        cluster,
        taskDefinition,
        taskCount: 1,
        subnetSelection: {
          subnetType: ec2.SubnetType.PUBLIC,
        },
      }));

    }
    else {
      const handlerJobSender = new lambda.Function(this, 'S3MigrationJobSender', {
        runtime: lambda.Runtime.PYTHON_3_8,
        code: lambda.Code.fromAsset(path.join(__dirname, '../src')),
        layers: [layer],
        handler: "lambda_function_jobsender.lambda_handler",
        memorySize: 1024,
        timeout: cdk.Duration.minutes(15),
        tracing: lambda.Tracing.ACTIVE,
        environment: {
          TABLE_QUEUE_NAME: ddbFileList.tableName,
          SQS_QUEUE_NAME: sqsQueue.queueName,
          SSM_PARAMETER_CREDENTIALS: credentialsParameterStore.valueAsString,
          SRC_BUCKET_NAME: srcBucketName.valueAsString,
          SRC_BUCKET_PREFIX: srcBucketPrefix.valueAsString,
          DEST_BUCKET_NAME: destBucketName.valueAsString,
          DEST_BUCKET_PREFIX: destBucketPrefix.valueAsString,
          JOB_TYPE: jobType.valueAsString,
          SOURCE_TYPE: sourceType.valueAsString,
          MAX_RETRY: MaxRetry,
          INCLUDE_VERSION: IncludeVersion
        }
      })

      ssmCredentialsParam.grantRead(handlerJobSender);
      ddbFileList.grantReadData(handlerJobSender);
      sqsQueue.grantSendMessages(handlerJobSender);
      s3InCurrentAccount.grantReadWrite(handlerJobSender);

      // Add target to cloudwatch rule.
      trigger.addTarget(new targets.LambdaFunction(handlerJobSender));

      // Custom resource to trigger JobSender Lambda once
      const jobSenderTrigger = new cr.AwsCustomResource(this, 'JobSenderTrigger', {
        policy: cr.AwsCustomResourcePolicy.fromStatements([new iam.PolicyStatement({
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
          physicalResourceId: cr.PhysicalResourceId.of('JobSenderTriggerPhysicalId')
        }
      })
      jobSenderTrigger.node.addDependency(handler, handlerJobSender, sqsQueue)

    }

    // 9. Setup Cloudwatch Dashboard
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
        left: [lambdaMetricDownload, lambdaMetricUpload, lambdaMetricComplete]
      }),
      new cw.GraphWidget({
        title: 'Lambda-concurrent',
        left: [handler.metric('ConcurrentExecutions', { period: cdk.Duration.minutes(1) })]
      }),
      new cw.GraphWidget({
        title: 'Lambda-invocations/errors/throttles',
        left: [
          handler.metricInvocations({ period: cdk.Duration.minutes(1) }),
          handler.metricErrors({ period: cdk.Duration.minutes(1) }),
          handler.metricThrottles({ period: cdk.Duration.minutes(1) })
        ]
      }),
      new cw.GraphWidget({
        title: 'Lambda-duration',
        left: [handler.metricDuration({ period: cdk.Duration.minutes(1) })]
      })
    )

    board.addWidgets(
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
          sqsQueue.metricApproximateNumberOfMessagesVisible({ period: cdk.Duration.minutes(1) }),
          sqsQueue.metricApproximateNumberOfMessagesNotVisible({ period: cdk.Duration.minutes(1) })
        ]
      }),
      new cw.SingleValueWidget({
        title: 'Running/Waiting and Dead Jobs',
        metrics: [
          sqsQueue.metricApproximateNumberOfMessagesNotVisible({ period: cdk.Duration.minutes(1) }),
          sqsQueue.metricApproximateNumberOfMessagesVisible({ period: cdk.Duration.minutes(1) }),
          sqsQueueDLQ.metricApproximateNumberOfMessagesNotVisible({ period: cdk.Duration.minutes(1) }),
          sqsQueueDLQ.metricApproximateNumberOfMessagesVisible({ period: cdk.Duration.minutes(1) })
        ],
        height: 6
      })
    )

    // 10. Alarm for queue - DLQ
    const alarmDLQ = new cw.Alarm(this, 'SQSDLQAlarm', {
      metric: sqsQueueDLQ.metricApproximateNumberOfMessagesVisible(),
      threshold: 0,
      comparisonOperator: cw.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      datapointsToAlarm: 1
    });
    const alarmTopic = new sns.Topic(this, 'SQS queue-DLQ has dead letter');
    alarmTopic.addSubscription(new sub.EmailSubscription(alarmEmail.valueAsString));
    alarmDLQ.addAlarmAction(new actions.SnsAction(alarmTopic));

    new cdk.CfnOutput(this, 'Dashboard', {
      value: 'CloudWatch Dashboard name is S3Migration'
    })

  }
}
