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
import * as ecr from '@aws-cdk/aws-ecr';

/**
 * cfn-nag suppression rule interface
 */
interface CfnNagSuppressRule {
  readonly id: string;
  readonly reason: string;
}

/***
 * BEFORE DEPLOY CDK, please setup a "drh-credentials" secure parameter in ssm parameter store MANUALLY!
 */

export class AwsDataReplicationComponentS3Stack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // 'PUT': Destination Bucket is not in current account.
    // 'GET': Source bucket is not in current account.
    const jobType = new cdk.CfnParameter(this, 'jobType', {
      description: 'Choose GET if source bucket is not in current account. Otherwise, choose PUT',
      type: 'String',
      default: 'GET',
      allowedValues: ['PUT', 'GET']
    })

    const sourceType = new cdk.CfnParameter(this, 'sourceType', {
      description: 'Choose type of source storage, for example Amazon_S3, Aliyun_OSS, Qiniu_Kodo, Tencent_COS',
      type: 'String',
      default: 'Amazon_S3',
      allowedValues: ['Amazon_S3', 'Aliyun_OSS', 'Qiniu_Kodo', 'Tencent_COS']
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
      description: 'Destination Bucket Name',
      type: 'String'
    })

    const destBucketPrefix = new cdk.CfnParameter(this, 'destBucketPrefix', {
      description: 'Destination Bucket Object Prefix',
      default: '',
      type: 'String'
    })

    // 'STANDARD'|'REDUCED_REDUNDANCY'|'STANDARD_IA'|'ONEZONE_IA'|'INTELLIGENT_TIERING'|'GLACIER'|'DEEP_ARCHIVE'|'OUTPOSTS',
    const destStorageClass = new cdk.CfnParameter(this, 'destStorageClass', {
      description: 'Destination Storage Class, Default to STANDAD',
      default: 'STANDARD',
      type: 'String',
      allowedValues: ['STANDARD', 'STANDARD_IA', 'ONEZONE_IA', 'INTELLIGENT_TIERING']
    })

    const ecsClusterName = new cdk.CfnParameter(this, 'ecsClusterName', {
      description: 'ECS Cluster Name to run ECS task',
      default: '',
      type: 'String'
    })

    const ecsVpcId = new cdk.CfnParameter(this, 'ecsVpcId', {
      description: 'VPC ID to run ECS task, e.g. vpc-bef13dc7',
      default: '',
      type: 'AWS::EC2::VPC::Id'
    })

    const ecsSubnets = new cdk.CfnParameter(this, 'ecsSubnets', {
      description: 'Subnet IDs to run ECS task. Please provide two subnets at least delimited by comma, e.g. subnet-97bfc4cd,subnet-7ad7de32',
      default: '',
      type: 'List<AWS::EC2::Subnet::Id>'
    })

    // The region credential (not the same account as Lambda) setting in SSM Parameter Store
    const credentialsParameterStore = new cdk.CfnParameter(this, 'credentialsParameterStore', {
      description: 'The Parameter Store used to keep AK/SK credentials',
      default: 'drh-credentials',
      type: 'String'
    })

    const alarmEmail = new cdk.CfnParameter(this, 'alarmEmail', {
      allowedPattern: '\\w[-\\w.+]*@([A-Za-z0-9][-A-Za-z0-9]+\\.)+[A-Za-z]{2,14}',
      type: 'String',
      description: 'Errors will be sent to this email.'
    })

    // const includeMetadata = new cdk.CfnParameter(this, 'includeMetadata', {
    //   description: 'Including metadata',
    //   default: 'YES',
    //   type: 'String',
    //   allowedValues: ['TRUE', 'FALSE']
    // })

    const lambdaMemory = new cdk.CfnParameter(this, 'lambdaMemory', {
      description: 'Lambda Memory, default to 256 MB',
      default: '256',
      type: 'Number',
      allowedValues: ['128', '256', '512', '1024']
    })

    const multipartThreshold = new cdk.CfnParameter(this, 'multipartThreshold', {
      description: 'Threshold Size for multipart upload in MB, default to 10 (MB)',
      default: '10',
      type: 'String',
      allowedValues: ['10', '15', '20', '50', '100'],
    })

    const chunkSize = new cdk.CfnParameter(this, 'chunkSize', {
      description: 'Chunk Size for multipart upload in MB, default to 5 (MB)',
      default: '5',
      type: 'String',
      allowedValues: ['5', '10']
    })

    const maxThreads = new cdk.CfnParameter(this, 'maxThreads', {
      description: 'Max Theads to run multipart upload in lambda, default to 10',
      default: '10',
      type: 'String',
      allowedValues: ['5', '10', '20', '50'],
    })


    this.templateOptions.description = 'Data Replication Hub - S3 Plugin Cloudformation Template';

    this.templateOptions.metadata = {
      'AWS::CloudFormation::Interface': {
        ParameterGroups: [
          {
            Label: { default: 'General' },
            Parameters: [sourceType.logicalId, jobType.logicalId]
          },
          {
            Label: { default: 'Source' },
            Parameters: [srcBucketName.logicalId, srcBucketPrefix.logicalId]
          },
          {
            Label: { default: 'Destination' },
            Parameters: [destBucketName.logicalId, destBucketPrefix.logicalId, destStorageClass.logicalId]
          },
          {
            Label: { default: 'ECS Cluster' },
            Parameters: [ecsClusterName.logicalId, ecsVpcId.logicalId, ecsSubnets.logicalId]
          },
          {
            Label: { default: 'Credentials' },
            Parameters: [credentialsParameterStore.logicalId]
          },
          {
            Label: { default: 'Notification' },
            Parameters: [alarmEmail.logicalId]
          },
          {
            Label: { default: 'Advanced Options' },
            Parameters: [lambdaMemory.logicalId, multipartThreshold.logicalId, chunkSize.logicalId, maxThreads.logicalId]
          }
        ],
        ParameterLabels: {
          [sourceType.logicalId]: {
            default: 'Source Type'
          },
          [jobType.logicalId]: {
            default: 'Job Type'
          },
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
          [destStorageClass.logicalId]: {
            default: 'Destination Storage Class'
          },
          [ecsClusterName.logicalId]: {
            Default: 'ECS Cluster Name to run Fargate task'
          },
          [ecsVpcId.logicalId]: {
            Default: 'VPC ID to run Fargate task'
          },
          [ecsSubnets.logicalId]: {
            Default: 'Subnet IDs to run Fargate task'
          },
          [credentialsParameterStore.logicalId]: {
            Default: 'Parameter Store for Credentials'
          },
          [alarmEmail.logicalId]: {
            default: 'Alarm Email'
          },
          [lambdaMemory.logicalId]: {
            default: 'Lambda Memory'
          },
          [multipartThreshold.logicalId]: {
            default: 'Multipart Threshold'
          },
          [chunkSize.logicalId]: {
            default: 'Chunk Size'
          },
          [maxThreads.logicalId]: {
            default: 'Max Threads'
          },

        }
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

    const cfnDdb = ddbFileList.node.defaultChild as ddb.CfnTable;
    this.addCfnNagSuppressRules(cfnDdb, [
      {
        id: 'W74',
        reason: 'No need to use encryption'
      }
    ]);

    // 3. Setup SQS
    const sqsQueueDLQ = new sqs.Queue(this, 'S3MigrationQueueDLQ', {
      visibilityTimeout: cdk.Duration.minutes(15),
      retentionPeriod: cdk.Duration.days(14),
    })

    const cfnSqsQueueDLQ = sqsQueueDLQ.node.defaultChild as sqs.CfnQueue;
    this.addCfnNagSuppressRules(cfnSqsQueueDLQ, [
      {
        id: 'W48',
        reason: 'No need to use encryption'
      }
    ]);

    const sqsQueue = new sqs.Queue(this, 'S3MigrationQueue', {
      visibilityTimeout: cdk.Duration.minutes(15),
      retentionPeriod: cdk.Duration.days(14),
      deadLetterQueue: {
        queue: sqsQueueDLQ,
        maxReceiveCount: 60
      }
    })

    const cfnSqsQueue = sqsQueue.node.defaultChild as sqs.CfnQueue;
    this.addCfnNagSuppressRules(cfnSqsQueue, [
      {
        id: 'W48',
        reason: 'No need to use encryption'
      }
    ]);

    // 4. Setup API for Lambda to get IP address (for debug networking routing purpose)
    // No used.
    // const checkip = new api.RestApi(this, 'LambdaCheckIpAPI', {
    //   cloudWatchRole: true,
    //   deploy: true,
    //   description: 'For Lambda get IP address',
    //   defaultIntegration: new api.MockIntegration({
    //     integrationResponses: [{
    //       statusCode: '200',
    //       responseTemplates: { "application/json": "$context.identity.sourceIp" }
    //     }],
    //     requestTemplates: { "application/json": '{"statusCode": 200}' }
    //   }),
    //   endpointConfiguration: {
    //     types: [api.EndpointType.REGIONAL]
    //   }
    // })

    // checkip.root.addMethod('GET', undefined, {
    //   methodResponses: [
    //     {
    //       statusCode: '200',
    //       responseModels: {
    //         'application/json': api.Model.EMPTY_MODEL
    //       }
    //     }
    //   ]
    // })

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
            'bash', '-c', `python setup.py sdist && mkdir /asset-output/python &&
            pip install dist/migration_lib-0.1.0.tar.gz --target /asset-output/python`,
          ],
        },
      }),
      compatibleRuntimes: [lambda.Runtime.PYTHON_3_8],
      description: 'Migration Lambda layer',
    });

    const handler = new lambda.Function(this, 'S3MigrationWorker', {
      runtime: lambda.Runtime.PYTHON_3_8,
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda')),
      layers: [layer],
      handler: 'lambda_function_worker.lambda_handler',
      memorySize: lambdaMemory.valueAsNumber,
      timeout: cdk.Duration.minutes(15),
      // tracing: lambda.Tracing.ACTIVE,
      environment: {
        TABLE_QUEUE_NAME: ddbFileList.tableName,
        SRC_BUCKET_NAME: srcBucketName.valueAsString,
        SRC_BUCKET_PREFIX: srcBucketPrefix.valueAsString,
        DEST_BUCKET_NAME: destBucketName.valueAsString,
        DEST_BUCKET_PREFIX: destBucketPrefix.valueAsString,
        STORAGE_CLASS: destStorageClass.valueAsString,
        SSM_PARAMETER_CREDENTIALS: credentialsParameterStore.valueAsString,
        JOB_TYPE: jobType.valueAsString,
        SOURCE_TYPE: sourceType.valueAsString,
        MULTIPART_THRESHOLD: multipartThreshold.valueAsString,
        CHUNK_SIZE: chunkSize.valueAsString,
        MAX_THREADS: maxThreads.valueAsString,

      }
    })

    ssmCredentialsParam.grantRead(handler);
    ddbFileList.grantReadWriteData(handler);
    s3InCurrentAccount.grantReadWrite(handler);
    handler.addEventSource(new SqsEventSource(sqsQueue, {
      batchSize: 1
    }));

    // const cfnHandlerFunction = handler.node.defaultChild as lambda.CfnFunction;
    // this.addCfnNagSuppressRules(cfnHandlerFunction, [
    //   {
    //     id: 'W58',
    //     reason: 'False alarm: The Lambda function does have the permission to write CloudWatch Logs.'
    //   }
    // ]);

    // 7. Setup JobSender ECS Task
    const ecrRepositoryArn = 'arn:aws:ecr:us-west-2:347283850106:repository/s3-replication-jobsender'
    // const repo = ecr.Repository.fromRepositoryName(this, 'JobSenderRepo', 's3-replication-jobsender')
    const repo = ecr.Repository.fromRepositoryArn(this, 'JobSenderRepo', ecrRepositoryArn)
    const taskDefinition = new ecs.FargateTaskDefinition(this, 'JobSenderTaskDef', {
      cpu: 1024 * 4,
      memoryLimitMiB: 1024 * 8,
    });
    taskDefinition.addContainer('DefaultContainer', {
      // image: ecs.ContainerImage.fromAsset(path.join(__dirname, '../src')),
      image: ecs.ContainerImage.fromEcrRepository(repo),
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
      },
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'ecsJobSender' })
    });

    ssmCredentialsParam.grantRead(taskDefinition.taskRole)
    ddbFileList.grantReadData(taskDefinition.taskRole);
    sqsQueue.grantSendMessages(taskDefinition.taskRole);
    s3InCurrentAccount.grantReadWrite(taskDefinition.taskRole);

    // Get existing ecs cluster.
    const vpc = ec2.Vpc.fromVpcAttributes(this, 'ECSVpc', {
      vpcId: ecsVpcId.valueAsString,
      availabilityZones: cdk.Fn.getAzs(),
      publicSubnetIds: ecsSubnets.valueAsList

    })

    const cluster = ecs.Cluster.fromClusterAttributes(this, 'ECSCluster', {
      clusterName: ecsClusterName.valueAsString,
      vpc: vpc,
      securityGroups: []
    })

    // 8. CloudWatch Rule. 
    // Schedule CRON event to trigger JobSender per hour
    const trigger = new events.Rule(this, 'CronTriggerJobSender', {
      schedule: events.Schedule.rate(cdk.Duration.hours(1)),
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

    const taskDefArnNoVersion = this.formatArn({
      service: 'ecs',
      resource: 'task-definition',
      resourceName: taskDefinition.family
    })


    // Custom resource to trigger JobSender ECS task once
    const jobSenderTrigger = new cr.AwsCustomResource(this, 'JobSenderTrigger', {
      resourceType: 'Custom::CustomResource',
      policy: cr.AwsCustomResourcePolicy.fromStatements([new iam.PolicyStatement({
        actions: ['ecs:RunTask'],
        effect: iam.Effect.ALLOW,
        resources: [taskDefArnNoVersion]
      }),
      new iam.PolicyStatement({
        actions: ['iam:PassRole'],
        effect: iam.Effect.ALLOW,
        resources: [taskDefinition.taskRole.roleArn]
      }),
      new iam.PolicyStatement({
        actions: ['iam:PassRole'],
        effect: iam.Effect.ALLOW,
        resources: [taskDefinition.executionRole ? taskDefinition.executionRole.roleArn : taskDefinition.taskRole.roleArn]
      }),
      ]),
      timeout: cdk.Duration.minutes(15),
      // logRetention: logs.RetentionDays.ONE_DAY,
      onCreate: {
        service: 'ECS',
        action: 'runTask',
        parameters: {
          launchType: ecs.LaunchType.FARGATE,
          taskDefinition: taskDefinition.family,
          cluster: cluster.clusterName,
          count: 1,
          networkConfiguration: {
            awsvpcConfiguration: {
              subnets: ecsSubnets.valueAsList,
              assignPublicIp: "ENABLED",
            }
          },
        },
        physicalResourceId: cr.PhysicalResourceId.of('JobSenderTriggerPhysicalId')
      }
    })
    jobSenderTrigger.node.addDependency(taskDefinition, sqsQueue)

    // 9. Setup Cloudwatch Dashboard
    // Create Lambda logs filter to create network traffic metric
    const lambdaFunctionLogs = new logs.LogGroup(this, 'HandlerLogGroup', {
      logGroupName: `/aws/lambda/${handler.functionName}`,
      retention: logs.RetentionDays.TWO_WEEKS
    });

    // const cfnLambdaFunctionLogs = lambdaFunctionLogs.node.defaultChild as logs.CfnLogGroup;
    // cfnLambdaFunctionLogs.retentionInDays = logs.RetentionDays.TWO_WEEKS;

    lambdaFunctionLogs.addMetricFilter('Completed-bytes', {
      metricName: 'Completed-bytes',
      metricNamespace: 's3_migrate',
      metricValue: '$bytes',
      filterPattern: logs.FilterPattern.literal('[info, date, sn, p="----->Complete", bytes, key]')
    })
    lambdaFunctionLogs.addMetricFilter('Uploading-bytes', {
      metricName: 'Uploading-bytes',
      metricNamespace: 's3_migrate',
      metricValue: '$bytes',
      filterPattern: logs.FilterPattern.literal('[info, date, sn, p="----->Uploading", bytes, key]')
    })
    lambdaFunctionLogs.addMetricFilter('Downloading-bytes', {
      metricName: 'Downloading-bytes',
      metricNamespace: 's3_migrate',
      metricValue: '$bytes',
      filterPattern: logs.FilterPattern.literal('[info, date, sn, p="----->Downloading", bytes, key]')
    })
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

    const cfnAlarmTopic = alarmTopic.node.defaultChild as sns.CfnTopic;
    this.addCfnNagSuppressRules(cfnAlarmTopic, [
      {
        id: 'W47',
        reason: 'No need to use encryption'
      }
    ]);

    new cdk.CfnOutput(this, 'Dashboard', {
      value: 'CloudWatch Dashboard name is S3Migration'
    })

  }

  /**
   * Adds cfn-nag suppression rules to the AWS CloudFormation resource metadata.
   * @param {cdk.CfnResource} resource Resource to add cfn-nag suppression rules
   * @param {CfnNagSuppressRule[]} rules Rules to suppress
   */
  addCfnNagSuppressRules(resource: cdk.CfnResource, rules: CfnNagSuppressRule[]) {
    resource.addMetadata('cfn_nag', {
      rules_to_suppress: rules
    });
  }
}
