import { CfnParameter, CfnResource, Stack, StackProps, Construct, CfnCondition, Fn, Aws } from '@aws-cdk/core';
import * as ssm from '@aws-cdk/aws-ssm';
import * as s3 from '@aws-cdk/aws-s3';
import * as ec2 from '@aws-cdk/aws-ec2';

import { CommonStack, CommonProps } from "./common-resources";
import { EcsStack, EcsTaskProps } from "./ecs-finder-stack";
import { Ec2WorkerStack, Ec2WorkerProps } from "./ec2-worker-stack";
import { LambdaWorkerStack, LambdaWorkerProps } from "./lambda-worker-stack";


const { VERSION } = process.env;

/**
 * cfn-nag suppression rule interface
 */
interface CfnNagSuppressRule {
  readonly id: string;
  readonly reason: string;
}

export function addCfnNagSuppressRules(resource: CfnResource, rules: CfnNagSuppressRule[]) {
  resource.addMetadata('cfn_nag', {
    rules_to_suppress: rules
  });
}


/***
 * Main Stack
 */
export class AwsDataReplicationComponentS3Stack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const sourceType = new CfnParameter(this, 'sourceType', {
      description: 'Choose type of source storage, including Amazon S3, Aliyun OSS, Qiniu Kodo, Tencent COS or Google GCS',
      type: 'String',
      default: 'Amazon_S3',
      allowedValues: ['Amazon_S3', 'Aliyun_OSS', 'Qiniu_Kodo', 'Tencent_COS', 'Google_GCS']
    })

    const runType = new CfnParameter(this, 'runType', {
      description: 'Choose where to run the replication, either EC2 (BBR Enabled) or Lambda',
      type: 'String',
      default: 'EC2',
      allowedValues: ['EC2', 'Lambda']
    })

    const srcBucketName = new CfnParameter(this, 'srcBucketName', {
      description: 'Source Bucket Name',
      type: 'String'
    })

    const srcBucketPrefix = new CfnParameter(this, 'srcBucketPrefix', {
      description: 'Source Bucket Object Prefix',
      default: '',
      type: 'String'
    })

    const destBucketName = new CfnParameter(this, 'destBucketName', {
      description: 'Destination Bucket Name',
      type: 'String'
    })

    const destBucketPrefix = new CfnParameter(this, 'destBucketPrefix', {
      description: 'Destination Bucket Object Prefix',
      default: '',
      type: 'String'
    })

    // 'STANDARD'|'REDUCED_REDUNDANCY'|'STANDARD_IA'|'ONEZONE_IA'|'INTELLIGENT_TIERING'|'GLACIER'|'DEEP_ARCHIVE'|'OUTPOSTS',
    const destStorageClass = new CfnParameter(this, 'destStorageClass', {
      description: 'Destination Storage Class, Default to STANDAD',
      default: 'STANDARD',
      type: 'String',
      allowedValues: ['STANDARD', 'STANDARD_IA', 'ONEZONE_IA', 'INTELLIGENT_TIERING']
    })

    const ecsClusterName = new CfnParameter(this, 'ecsClusterName', {
      description: 'ECS Cluster Name to run ECS task',
      default: '',
      type: 'String'
    })

    const ecsVpcId = new CfnParameter(this, 'ecsVpcId', {
      description: 'VPC ID to run ECS task, e.g. vpc-bef13dc7',
      default: '',
      type: 'AWS::EC2::VPC::Id'
    })

    // const ecsSubnets = new CfnParameter(this, 'ecsSubnets', {
    //   description: 'Subnet IDs to run ECS task. Please provide two subnets at least delimited by comma, e.g. subnet-97bfc4cd,subnet-7ad7de32',
    //   default: '',
    //   type: 'List<AWS::EC2::Subnet::Id>'
    // })
    const ecsSubnetA = new CfnParameter(this, 'ecsSubnetA', {
      description: 'Subnet IDs to run ECS task.',
      type: 'AWS::EC2::Subnet::Id'
    })

    const ecsSubnetB = new CfnParameter(this, 'ecsSubnetB', {
      description: 'Subnet IDs to run ECS task.',
      type: 'AWS::EC2::Subnet::Id'
    })

    // 'PUT': Destination Bucket is not in current account.
    // 'GET': Source bucket is not in current account.
    const jobType = new CfnParameter(this, 'jobType', {
      description: 'Choose PUT if source bucket is in current account. Otherwise, choose GET',
      type: 'String',
      default: 'GET',
      allowedValues: ['PUT', 'GET']
    })

    const regionName = new CfnParameter(this, 'regionName', {
      description: 'Region Name. If Job Type is GET, use source region name, otherwise use destination region name.',
      default: '',
      type: 'String'
    })

    // The region credential (not the same account as Lambda) setting in SSM Parameter Store
    const credentialsParameterStore = new CfnParameter(this, 'credentialsParameterStore', {
      description: 'The Parameter Store used to keep AK/SK credentials for another account. Leave it blank if you are accessing open buckets with no-sign-request',
      default: '',
      type: 'String'
    })



    const alarmEmail = new CfnParameter(this, 'alarmEmail', {
      allowedPattern: '\\w[-\\w.+]*@([A-Za-z0-9][-A-Za-z0-9]+\\.)+[A-Za-z]{2,14}',
      type: 'String',
      description: 'Errors will be sent to this email.'
    })

    // const includeMetadata = new CfnParameter(this, 'includeMetadata', {
    //   description: 'Including metadata',
    //   default: 'YES',
    //   type: 'String',
    //   allowedValues: ['TRUE', 'FALSE']
    // })

    const enableS3Event = new CfnParameter(this, 'enableS3Event', {
      description: 'Whether to enable S3 Event to trigger the replication. Note that S3Event is only applicable if source is in Current account',
      default: 'No',
      type: 'String',
      allowedValues: ['No', 'Create_Only', 'Delete_Only', 'Create_And_Delete']
    })

    const lambdaMemory = new CfnParameter(this, 'lambdaMemory', {
      description: 'Lambda Memory, default to 256 MB',
      default: '256',
      type: 'Number',
      allowedValues: ['128', '256', '512', '1024']
    })

    const multipartThreshold = new CfnParameter(this, 'multipartThreshold', {
      description: 'Threshold Size for multipart upload in MB, default to 10 (MB)',
      default: '10',
      type: 'String',
      allowedValues: ['10', '15', '20', '50', '100'],
    })

    const chunkSize = new CfnParameter(this, 'chunkSize', {
      description: 'Chunk Size for multipart upload in MB, default to 5 (MB)',
      default: '5',
      type: 'String',
      allowedValues: ['1', '2', '5', '10', '20']
    })

    const maxThreads = new CfnParameter(this, 'maxThreads', {
      description: 'Max Theads to run multipart upload in lambda, default to 10',
      default: '10',
      type: 'String',
      allowedValues: ['5', '10', '20', '50'],
    })

    this.templateOptions.description = `(SO8002) - Data Replication Hub - S3 Plugin - Template version ${VERSION}`;

    this.templateOptions.metadata = {
      'AWS::CloudFormation::Interface': {
        ParameterGroups: [
          {
            Label: { default: 'General Information' },
            Parameters: [sourceType.logicalId, runType.logicalId]
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
            Parameters: [ecsClusterName.logicalId, ecsVpcId.logicalId, ecsSubnetA.logicalId, ecsSubnetB.logicalId]
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
          [runType.logicalId]: {
            default: 'Run Type'
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
            Default: 'ECS Cluster Name'
          },
          [ecsVpcId.logicalId]: {
            Default: 'Cluster VPC ID'
          },
          [ecsSubnetA.logicalId]: {
            Default: 'Subnet ID A'
          },
          [ecsSubnetB.logicalId]: {
            Default: 'Subnet ID B'
          },
          [regionName.logicalId]: {
            Default: 'Region Name'
          },
          [credentialsParameterStore.logicalId]: {
            Default: 'Credentials Parameter Name'
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
    const credentialsParam = ssm.StringParameter.fromStringParameterAttributes(this, 'SSMParameterCredentials', {
      parameterName: credentialsParameterStore.valueAsString,
      simpleName: true,
      type: ssm.ParameterType.SECURE_STRING,
      version: 1
    });

    // Get bucket in current account
    // PUT - Source bucket in current account and destination in other account
    // GET - Dest bucket in current account and source bucket in other account
    const isGet = new CfnCondition(this, 'isGet', {
      expression: Fn.conditionEquals('GET', jobType),
    });

    const bucketName = Fn.conditionIf(isGet.logicalId, destBucketName.valueAsString, srcBucketName.valueAsString).toString();
    const s3InCurrentAccount = s3.Bucket.fromBucketName(this, `BucketName`, bucketName);

    // Get VPC
    const vpc = ec2.Vpc.fromVpcAttributes(this, 'ECSVpc', {
      vpcId: ecsVpcId.valueAsString,
      availabilityZones: Fn.getAzs(),
      publicSubnetIds: [ecsSubnetA.valueAsString, ecsSubnetB.valueAsString]
    })

    // Start Common Stack
    const commonProps: CommonProps = {
      jobType: jobType.valueAsString,
      sourceType: sourceType.valueAsString,
      enableS3Event: enableS3Event.valueAsString,
      S3BucketArn: s3InCurrentAccount.bucketArn,
      alarmEmail: alarmEmail.valueAsString,
    }

    const commonStack = new CommonStack(this, 'Common', commonProps)

    // Start Finder - ECS Stack
    const finderEnv = {
      AWS_DEFAULT_REGION: Aws.REGION,
      JOB_TABLE_NAME: commonStack.jobTable.tableName,
      SQS_QUEUE_NAME: commonStack.sqsQueue.queueName,
      SSM_PARAMETER_CREDENTIALS: credentialsParameterStore.valueAsString,
      REGION_NAME: regionName.valueAsString,
      SRC_BUCKET_NAME: srcBucketName.valueAsString,
      SRC_BUCKET_PREFIX: srcBucketPrefix.valueAsString,
      DEST_BUCKET_NAME: destBucketName.valueAsString,
      DEST_BUCKET_PREFIX: destBucketPrefix.valueAsString,
      JOB_TYPE: jobType.valueAsString,
      SOURCE_TYPE: sourceType.valueAsString,
    }

    const ecsProps: EcsTaskProps = {
      env: finderEnv,
      vpc: vpc,
      ecsSubnetIds: [ecsSubnetA.valueAsString, ecsSubnetB.valueAsString], // TODO: To remove this.
      ecsClusterName: ecsClusterName.valueAsString,
    }
    const ecsStack = new EcsStack(this, 'ECSStack', ecsProps);

    credentialsParam.grantRead(ecsStack.taskDefinition.taskRole)
    commonStack.jobTable.grantReadData(ecsStack.taskDefinition.taskRole);
    commonStack.sqsQueue.grantSendMessages(ecsStack.taskDefinition.taskRole);
    s3InCurrentAccount.grantReadWrite(ecsStack.taskDefinition.taskRole);

    // Start Worker - EC2 or Lambda
    const useEC2 = new CfnCondition(this, 'useEC2', {
      expression: Fn.conditionEquals('EC2', runType),
    });

    const useLambda = new CfnCondition(this, 'useLambda', {
      expression: Fn.conditionEquals('Lambda', runType),
    });

    const workerEnv = {
      JOB_TABLE_NAME: commonStack.jobTable.tableName,
      // EVENT_TABLE_NAME: commonStack.eventTableName,
      SQS_QUEUE_NAME: commonStack.sqsQueue.queueName,
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

    const ec2Props: Ec2WorkerProps = {
      env: workerEnv,
      vpc: vpc,
    }

    const ec2Stack = new Ec2WorkerStack(this, 'EC2WorkerStack', ec2Props)

    ec2Stack.nestedStackResource?.addMetadata('nestedTemplateName', ec2Stack.templateFile.slice(0, -5));
    if (ec2Stack.nestedStackResource) {
      ec2Stack.nestedStackResource.cfnOptions.condition = useEC2
    }

    credentialsParam.grantRead(ec2Stack.workerAsg.role)
    commonStack.jobTable.grantReadData(ec2Stack.workerAsg.role);
    commonStack.sqsQueue.grantConsumeMessages(ec2Stack.workerAsg.role);
    // s3InCurrentAccount.grantReadWrite(ec2Stack.workerAsg.role);

    // start Lambda stack
    const lambdaProps: LambdaWorkerProps = {
      env: workerEnv,
      sqsQueue: commonStack.sqsQueue,
      lambdaMemory: lambdaMemory.valueAsNumber,
    }

    const lambdaStack = new LambdaWorkerStack(this, 'LambdaWorkerStack', lambdaProps)

    lambdaStack.nestedStackResource?.addMetadata('nestedTemplateName', lambdaStack.templateFile.slice(0, -5));
    if (lambdaStack.nestedStackResource) {
      lambdaStack.nestedStackResource.cfnOptions.condition = useLambda
    }
    credentialsParam.grantRead(lambdaStack.handler);
    commonStack.jobTable.grantReadWriteData(lambdaStack.handler);
    // eventTable.grantReadWriteData(handler);
    // s3InCurrentAccount.grantReadWrite(lambdaStack.handler);

  }
}
