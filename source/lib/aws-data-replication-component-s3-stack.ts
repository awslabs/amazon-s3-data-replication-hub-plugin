import * as cdk from '@aws-cdk/core';
import * as ssm from '@aws-cdk/aws-ssm';
import * as ddb from '@aws-cdk/aws-dynamodb';
import * as sqs from '@aws-cdk/aws-sqs';
import * as lambda from '@aws-cdk/aws-lambda';
import * as iam from '@aws-cdk/aws-iam';
import * as path from 'path';
import { SqsEventSource } from "@aws-cdk/aws-lambda-event-sources";
import * as s3 from '@aws-cdk/aws-s3';
import * as cw from '@aws-cdk/aws-cloudwatch';
import * as actions from '@aws-cdk/aws-cloudwatch-actions';
import * as sns from '@aws-cdk/aws-sns';
import * as sub from '@aws-cdk/aws-sns-subscriptions';


import { EcsStack, EcsTaskProps } from "./ecs-jobsender-stack";
import { DashboardStack, DBProps } from "./dashboard-stack";
import { StackEventHandler, EventProps } from "./stack-event-handler";


const { VERSION } = process.env;

/**
 * cfn-nag suppression rule interface
 */
interface CfnNagSuppressRule {
  readonly id: string;
  readonly reason: string;
}

export interface JobDetails {
  readonly srcBucketName: string,
  readonly srcPrefix: string,
  readonly destBucketName: string,
  readonly destPrefix: string,
  readonly jobType: string,
  readonly sourceType: string,
  readonly jobTableName: string,
  readonly queueName: string,
  readonly credParamName: string,
  readonly regionName: string,
}

/***
 * BEFORE DEPLOY CDK, please setup a "drh-credentials" secure parameter in ssm parameter store MANUALLY!
 */

export class AwsDataReplicationComponentS3Stack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const sourceType = new cdk.CfnParameter(this, 'sourceType', {
      description: 'Choose type of source storage, including Amazon S3, Aliyun OSS, Qiniu Kodo, Tencent COS or Google GCS',
      type: 'String',
      default: 'Amazon_S3',
      allowedValues: ['Amazon_S3', 'Aliyun_OSS', 'Qiniu_Kodo', 'Tencent_COS', 'Google_GCS']
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

    // 'PUT': Destination Bucket is not in current account.
    // 'GET': Source bucket is not in current account.
    const jobType = new cdk.CfnParameter(this, 'jobType', {
      description: 'Choose PUT if source bucket is in current account. Otherwise, choose GET',
      type: 'String',
      default: 'GET',
      allowedValues: ['PUT', 'GET']
    })

    const regionName = new cdk.CfnParameter(this, 'regionName', {
      description: 'Region Name. If Job Type is GET, use source region name, otherwise use destination region name.',
      default: '',
      type: 'String'
    })

    // The region credential (not the same account as Lambda) setting in SSM Parameter Store
    const credentialsParameterStore = new cdk.CfnParameter(this, 'credentialsParameterStore', {
      description: 'The Parameter Store used to keep AK/SK credentials for another account. Leave it blank if you are accessing open buckets with no-sign-request',
      default: '',
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

    const enableS3Event = new cdk.CfnParameter(this, 'enableS3Event', {
      description: 'Whether to enable S3 Event to trigger the replication. Note that S3Event is only applicable if source is in Current account',
      default: 'No',
      type: 'String',
      allowedValues: ['No', 'Create_Only', 'Delete_Only', 'Create_And_Delete']
    })

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

    this.templateOptions.description = `(SO80002) - Data Replication Hub - S3 Plugin - Template version ${VERSION}`;

    this.templateOptions.metadata = {
      'AWS::CloudFormation::Interface': {
        ParameterGroups: [
          {
            Label: { default: 'Source Type' },
            Parameters: [sourceType.logicalId]
          },
          {
            Label: { default: 'Source Information' },
            Parameters: [srcBucketName.logicalId, srcBucketPrefix.logicalId, enableS3Event.logicalId]
          },
          {
            Label: { default: 'Destination Information' },
            Parameters: [destBucketName.logicalId, destBucketPrefix.logicalId, destStorageClass.logicalId]
          },
          {
            Label: { default: 'Extra Information' },
            Parameters: [jobType.logicalId, regionName.logicalId, credentialsParameterStore.logicalId, alarmEmail.logicalId]
          },
          {
            Label: { default: 'ECS Cluster Information' },
            Parameters: [ecsClusterName.logicalId, ecsVpcId.logicalId, ecsSubnets.logicalId]
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
          [regionName.logicalId]: {
            Default: 'Region Name for another account or cloud storage'
          },
          [credentialsParameterStore.logicalId]: {
            Default: 'Credentials Parameter for another account or cloud storage'
          },
          [alarmEmail.logicalId]: {
            default: 'Alarm Email'
          },
          [enableS3Event.logicalId]: {
            default: 'Enable S3 Event'
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

    // Get SSM parameter of credentials
    const ssmCredentialsParam = ssm.StringParameter.fromStringParameterAttributes(this, 'SSMParameterCredentials', {
      parameterName: credentialsParameterStore.valueAsString,
      simpleName: true,
      type: ssm.ParameterType.SECURE_STRING,
      version: 1
    });

    // Setup DynamoDB
    const jobTable = new ddb.Table(this, 'S3MigrationTable', {
      partitionKey: { name: 'objectKey', type: ddb.AttributeType.STRING },
      billingMode: ddb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY
    })

    jobTable.addGlobalSecondaryIndex({
      partitionKey: { name: 'desBucket', type: ddb.AttributeType.STRING },
      indexName: 'desBucket-index',
      projectionType: ddb.ProjectionType.INCLUDE,
      nonKeyAttributes: ['desKey', 'versionId']
    })

    const cfnJobTable = jobTable.node.defaultChild as ddb.CfnTable;
    this.addCfnNagSuppressRules(cfnJobTable, [
      {
        id: 'W74',
        reason: 'No need to use encryption'
      }
    ]);

    const useS3Event = new cdk.CfnCondition(this, 'UseS3Event', {
      expression: cdk.Fn.conditionAnd(
        // job Type is PUT
        cdk.Fn.conditionEquals('PUT', jobType.valueAsString),
        // Source Type is Amazon S3 - Optional
        cdk.Fn.conditionEquals('Amazon_S3', sourceType.valueAsString),
        // Enable S3 Event is Yes
        cdk.Fn.conditionNot(cdk.Fn.conditionEquals('No', enableS3Event.valueAsString)),
      ),
    });



    const eventTable = new ddb.Table(this, 'S3EventTable', {
      partitionKey: { name: 'objectKey', type: ddb.AttributeType.STRING },
      billingMode: ddb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY
    })

    const cfnEventTable = eventTable.node.defaultChild as ddb.CfnTable;
    cfnEventTable.cfnOptions.condition = useS3Event

    const eventTableName = cdk.Fn.conditionIf(useS3Event.logicalId, eventTable.tableName, 'NA').toString();
    const eventTableArn = cdk.Fn.conditionIf(useS3Event.logicalId, eventTable.tableArn, jobTable.tableArn).toString();

    const eventTableRWPolicy = new iam.PolicyStatement({
      actions: ["dynamodb:BatchGetItem",
        "dynamodb:GetRecords",
        "dynamodb:GetShardIterator",
        "dynamodb:Query",
        "dynamodb:GetItem",
        "dynamodb:Scan",
        "dynamodb:BatchWriteItem",
        "dynamodb:PutItem",
        "dynamodb:UpdateItem",
        "dynamodb:DeleteItem"
      ],
      effect: iam.Effect.ALLOW,
      resources: [eventTableArn]
    })

    // Get bucket
    // PUT - Source bucket in current account and destination in other account
    // GET - Dest bucket in current account and source bucket in other account
    const isGet = new cdk.CfnCondition(this, 'isGet', {
      expression: cdk.Fn.conditionEquals('GET', jobType),
    });

    const bucketName = cdk.Fn.conditionIf(isGet.logicalId, destBucketName.valueAsString, srcBucketName.valueAsString).toString();
    const s3InCurrentAccount = s3.Bucket.fromBucketName(this, `BucketName`, bucketName);

    // Setup SQS
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

    sqsQueue.addToResourcePolicy(new iam.PolicyStatement({
      actions: ['SQS:SendMessage'],
      effect: iam.Effect.ALLOW,
      resources: [sqsQueue.queueArn],
      principals: [new iam.ServicePrincipal('s3.amazonaws.com')],
      conditions: {
        StringEquals: {
          "aws:SourceArn": s3InCurrentAccount.bucketArn
        }
      }
    }))

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
        JOB_TABLE_NAME: jobTable.tableName,
        EVENT_TABLE_NAME: eventTableName,
        SRC_BUCKET_NAME: srcBucketName.valueAsString,
        SRC_BUCKET_PREFIX: srcBucketPrefix.valueAsString,
        DEST_BUCKET_NAME: destBucketName.valueAsString,
        DEST_BUCKET_PREFIX: destBucketPrefix.valueAsString,
        STORAGE_CLASS: destStorageClass.valueAsString,
        SSM_PARAMETER_CREDENTIALS: credentialsParameterStore.valueAsString,
        REGION_NAME: regionName.valueAsString,
        JOB_TYPE: jobType.valueAsString,
        SOURCE_TYPE: sourceType.valueAsString,
        MULTIPART_THRESHOLD: multipartThreshold.valueAsString,
        CHUNK_SIZE: chunkSize.valueAsString,
        MAX_THREADS: maxThreads.valueAsString,
        LOG_LEVEL: 'INFO',
      }
    })

    ssmCredentialsParam.grantRead(handler);
    jobTable.grantReadWriteData(handler);
    // eventTable.grantReadWriteData(handler);
    s3InCurrentAccount.grantReadWrite(handler);
    handler.addEventSource(new SqsEventSource(sqsQueue, {
      batchSize: 1
    }));

    handler.addToRolePolicy(eventTableRWPolicy)

    // Setup Alarm for queue - DLQ
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


    // Setup Fargate Task
    const jobDetails: JobDetails = {
      queueName: sqsQueue.queueName,
      jobTableName: jobTable.tableName,
      credParamName: credentialsParameterStore.valueAsString,
      regionName: regionName.valueAsString,
      srcBucketName: srcBucketName.valueAsString,
      srcPrefix: srcBucketPrefix.valueAsString,
      destBucketName: destBucketName.valueAsString,
      destPrefix: destBucketPrefix.valueAsString,
      // storageClass: destStorageClass.valueAsString,
      jobType: jobType.valueAsString,
      sourceType: sourceType.valueAsString,
    }

    const ecsProps: EcsTaskProps = {
      job: jobDetails,
      ecsVpcId: ecsVpcId.valueAsString,
      ecsSubnetIds: ecsSubnets.valueAsList,
      ecsClusterName: ecsClusterName.valueAsString,
    }
    const ecsStack = new EcsStack(this, 'ECSStack', ecsProps);

    ssmCredentialsParam.grantRead(ecsStack.taskDefinition.taskRole)
    jobTable.grantReadData(ecsStack.taskDefinition.taskRole);
    sqsQueue.grantSendMessages(ecsStack.taskDefinition.taskRole);
    s3InCurrentAccount.grantReadWrite(ecsStack.taskDefinition.taskRole);

    // Setup Cloudwatch Dashboard
    const dbProps: DBProps = {
      handler: handler,
      queue: sqsQueue,
      queueDLQ: sqsQueueDLQ,
    }
    new DashboardStack(this, 'DashboardStack', dbProps);

    // Setup Stack Event Handler
    const eventProps: EventProps = {
      bucket: s3InCurrentAccount,
      prefix: srcBucketPrefix.valueAsString,
      queue: sqsQueue,
      enableS3Event: enableS3Event.valueAsString,
      jobType: jobType.valueAsString,
      taskDefinition: ecsStack.taskDefinition,
      ecsVpcId: ecsVpcId.valueAsString,
      ecsSubnetIds: ecsSubnets.valueAsList,
      ecsClusterName: ecsClusterName.valueAsString,
      securityGroupName: ecsStack.securityGroup.securityGroupName,
    }
    new StackEventHandler(this, 'StackEventHandler', eventProps);

    new cdk.CfnOutput(this, 'Dashboard', {
      value: `${cdk.Aws.STACK_NAME}-Dashboard`,
      description: 'CloudWatch Dashboard name'
    })
    new cdk.CfnOutput(this, 'TaskDefinitionName', {
      value: ecsStack.taskDefinition.family,
      description: 'Task Definition Name'
    })
    new cdk.CfnOutput(this, 'QueueName', {
      value: sqsQueue.queueName,
      description: 'Queue Name'
    })

    new cdk.CfnOutput(this, 'DLQQueueName', {
      value: sqsQueueDLQ.queueName,
      description: 'Dead Letter Queue Name'
    })

    new cdk.CfnOutput(this, 'MigrationLambda', {
      value: handler.functionName,
      description: 'Migration Lambda Function Name'
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
