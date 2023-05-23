/*
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/


import {
  Construct,
  IConstruct
} from 'constructs';
import {
  Aws,
  Fn,
  CfnParameter,
  CfnResource,
  CfnCondition,
  Aspects,
  IAspect,
  Stack,
  StackProps,
  aws_secretsmanager as sm,
  aws_s3 as s3,
  aws_s3_notifications as s3n,
  aws_ec2 as ec2,
  aws_iam as iam
} from 'aws-cdk-lib';

import { CommonStack, CommonProps } from "./common-resources";
import { Ec2FinderStack, Ec2FinderProps } from "./ec2-finder-stack";
import { Ec2WorkerStack, Ec2WorkerProps } from "./ec2-worker-stack";
import { DashboardStack, DBProps } from "./dashboard-stack";

const { VERSION } = process.env;

export const enum RunType {
  EC2 = "EC2",
  LAMBDA = "Lambda"
}

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
export class DataTransferS3Stack extends Stack {
  private paramGroups: any[] = [];
  private paramLabels: any = {};

  private addToParamGroups(label: string, ...param: string[]) {
    this.paramGroups.push({
      Label: { default: label },
      Parameters: param

    });
  };

  private addToParamLabels(label: string, param: string) {
    this.paramLabels[param] = {
      default: label
    }
  }


  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const runType: RunType = this.node.tryGetContext('runType') || RunType.EC2

    const cliRelease = '1.2.1'

    const srcType = new CfnParameter(this, 'srcType', {
      description: 'Choose type of source storage, including Amazon S3, Aliyun OSS, Qiniu Kodo, Tencent COS or Google GCS',
      type: 'String',
      default: 'Amazon_S3',
      allowedValues: ['Amazon_S3', 'Aliyun_OSS', 'Qiniu_Kodo', 'Tencent_COS']
    })
    this.addToParamLabels('Source Type', srcType.logicalId)

    const srcBucket = new CfnParameter(this, 'srcBucket', {
      description: 'Source Bucket Name',
      type: 'String'
    })
    this.addToParamLabels('Source Bucket', srcBucket.logicalId)

    const srcPrefix = new CfnParameter(this, 'srcPrefix', {
      description: 'Source Prefix (Optional)',
      default: '',
      type: 'String'
    })
    this.addToParamLabels('Source Prefix', srcPrefix.logicalId)

    const srcPrefixsListFile = new CfnParameter(this, 'srcPrefixsListFile', {
      description: 'Source Prefixs List File S3 path (Optional), support txt type, the maximum number of lines is 10 millions. e.g. my_prefix_list.txt',
      default: '',
      type: 'String'
    })
    this.addToParamLabels('Source Prefixs List File', srcPrefixsListFile.logicalId)

    const srcSkipCompare = new CfnParameter(this, 'srcSkipCompare', {
      description: 'Skip the data comparison in task finding process? If yes, all data in the source will be sent to the destination',
      default: 'false',
      type: 'String',
      allowedValues: ['true', 'false']
    })
    this.addToParamLabels('Skip Data Comparison', srcSkipCompare.logicalId)

    const srcRegion = new CfnParameter(this, 'srcRegion', {
      description: 'Source Region Name',
      default: '',
      type: 'String'
    })
    this.addToParamLabels('Source Region', srcRegion.logicalId)

    const srcEndpoint = new CfnParameter(this, 'srcEndpoint', {
      description: 'Source Endpoint URL (Optional), leave blank unless you want to provide a custom Endpoint URL',
      default: '',
      type: 'String'
    })
    this.addToParamLabels('Source Endpoint URL', srcEndpoint.logicalId)

    const srcInCurrentAccount = new CfnParameter(this, 'srcInCurrentAccount', {
      description: 'Source Bucket in current account? If not, you should provide a credential with read access',
      default: 'false',
      type: 'String',
      allowedValues: ['true', 'false']
    })
    this.addToParamLabels('Source In Current Account', srcInCurrentAccount.logicalId)

    const srcCredentials = new CfnParameter(this, 'srcCredentials', {
      description: 'The secret name in Secrets Manager used to keep AK/SK credentials for Source Bucket. Leave blank if source bucket is in current account or source is open data',
      default: '',
      type: 'String'
    })
    this.addToParamLabels('Source Credentials', srcCredentials.logicalId)


    const destBucket = new CfnParameter(this, 'destBucket', {
      description: 'Destination Bucket Name',
      type: 'String'
    })
    this.addToParamLabels('Destination Bucket', destBucket.logicalId)


    const destPrefix = new CfnParameter(this, 'destPrefix', {
      description: 'Destination Prefix (Optional)',
      default: '',
      type: 'String'
    })
    this.addToParamLabels('Destination Prefix', destPrefix.logicalId)


    const destRegion = new CfnParameter(this, 'destRegion', {
      description: 'Destination Region Name',
      default: '',
      type: 'String'
    })
    this.addToParamLabels('Destination Region', destRegion.logicalId)

    const destInCurrentAccount = new CfnParameter(this, 'destInCurrentAccount', {
      description: 'Destination Bucket in current account? If not, you should provide a credential with read and write access',
      default: 'true',
      type: 'String',
      allowedValues: ['true', 'false']
    })
    this.addToParamLabels('Destination In Current Account', destInCurrentAccount.logicalId)

    const destCredentials = new CfnParameter(this, 'destCredentials', {
      description: 'The secret name in Secrets Manager used to keep AK/SK credentials for Destination Bucket. Leave blank if desination bucket is in current account',
      default: '',
      type: 'String'
    })
    this.addToParamLabels('Destination Credentials', destCredentials.logicalId)

    const proxyHost = new CfnParameter(this, 'proxyHost', {
      description: 'Proxy server to be used by EC2 tasks. Leave blank if not needed.',
      default: '',
      type: 'String'
    })
    this.addToParamLabels('Proxy Host', proxyHost.logicalId)


    // 'STANDARD'|'REDUCED_REDUNDANCY'|'STANDARD_IA'|'ONEZONE_IA'|'INTELLIGENT_TIERING'|'GLACIER'|'DEEP_ARCHIVE'|'OUTPOSTS',
    const destStorageClass = new CfnParameter(this, 'destStorageClass', {
      description: 'Destination Storage Class, Default to INTELLIGENT_TIERING',
      default: 'INTELLIGENT_TIERING',
      type: 'String',
      allowedValues: ['STANDARD', 'STANDARD_IA', 'ONEZONE_IA', 'INTELLIGENT_TIERING']
    })
    this.addToParamLabels('Destination Storage Class', destStorageClass.logicalId)

    const destAcl = new CfnParameter(this, 'destAcl', {
      description: 'Destination Access Control List',
      default: 'bucket-owner-full-control',
      type: 'String',
      allowedValues: ['private',
        'public-read',
        'public-read-write',
        'authenticated-read',
        'aws-exec-read',
        'bucket-owner-read',
        'bucket-owner-full-control']
    })
    this.addToParamLabels('Destination Access Control List', destAcl.logicalId)

    const ec2VpcId = new CfnParameter(this, 'ec2VpcId', {
      description: 'VPC ID to run EC2 task, e.g. vpc-bef13dc7',
      default: '',
      type: 'AWS::EC2::VPC::Id'
    })
    this.addToParamLabels('VPC ID', ec2VpcId.logicalId)

    const ec2Subnets = new CfnParameter(this, 'ec2Subnets', {
      description: 'Subnet IDs to run EC2 task. Please provide two subnets at least delimited by comma, e.g. subnet-97bfc4cd,subnet-7ad7de32',
      default: '',
      type: 'List<AWS::EC2::Subnet::Id>'
    })
    this.addToParamLabels('Subnet IDs', ec2Subnets.logicalId)

    const finderEc2Memory = new CfnParameter(this, 'finderEc2Memory', {
      description: 'The amount of memory (in GB) used by the Finder task.',
      default: '8',
      type: 'String',
      allowedValues: ['8', '16', '32', '64', '128', '256']
    })
    this.addToParamLabels('EC2 Finder Memory', finderEc2Memory.logicalId)

    const ec2CronExpression = new CfnParameter(this, 'ec2CronExpression', {
      description: 'Cron Expression For EC2 Finder Task. Leave blank to execute only once.',
      default: '0/60 * * * ? *',
      type: 'String',
    })
    this.addToParamLabels('EC2 Cron Expression', ec2CronExpression.logicalId)

    const alarmEmail = new CfnParameter(this, 'alarmEmail', {
      allowedPattern: '\\w[-\\w.+]*@([A-Za-z0-9][-A-Za-z0-9]+\\.)+[A-Za-z]{2,14}',
      type: 'String',
      description: 'Errors will be sent to this email.'
    })
    this.addToParamLabels('Alarm Email', alarmEmail.logicalId)

    const includeMetadata = new CfnParameter(this, 'includeMetadata', {
      description: 'Add replication of object metadata, there will be additional API calls',
      default: 'true',
      type: 'String',
      allowedValues: ['true', 'false']
    })

    this.addToParamLabels('Include Metadata', includeMetadata.logicalId)

    const srcEvent = new CfnParameter(this, 'srcEvent', {
      description: 'Whether to enable S3 Event to trigger the replication. Note that S3Event is only applicable if source is in Current account',
      default: 'No',
      type: 'String',
      allowedValues: ['No', 'Create', 'CreateAndDelete']
    })
    this.addToParamLabels('Enable S3 Event', srcEvent.logicalId)

    const finderDepth = new CfnParameter(this, 'finderDepth', {
      description: 'The depth of sub folders to compare in parallel. 0 means comparing all objects in sequence',
      default: '0',
      type: 'String',
    })
    const finderNumber = new CfnParameter(this, 'finderNumber', {
      description: 'The number of finder threads to run in parallel',
      default: '1',
      type: 'String',
    })
    const workerNumber = new CfnParameter(this, 'workerNumber', {
      description: 'The number of worker threads to run in one worker node/instance',
      default: '4',
      type: 'String',
    })


    this.addToParamGroups('Source Information', srcType.logicalId, srcBucket.logicalId, srcPrefix.logicalId, srcPrefixsListFile.logicalId, srcRegion.logicalId, srcEndpoint.logicalId, srcInCurrentAccount.logicalId, srcCredentials.logicalId, srcEvent.logicalId, srcSkipCompare.logicalId)
    this.addToParamGroups('Destination Information', destBucket.logicalId, destPrefix.logicalId, destRegion.logicalId, destInCurrentAccount.logicalId, destCredentials.logicalId, destStorageClass.logicalId, destAcl.logicalId)
    this.addToParamGroups('Notification Information', alarmEmail.logicalId)
    this.addToParamGroups('EC2 Cluster Information', ec2VpcId.logicalId, ec2Subnets.logicalId, finderEc2Memory.logicalId, ec2CronExpression.logicalId)
    this.addToParamGroups('Network Settings', proxyHost.logicalId)

    // let lambdaMemory: CfnParameter | undefined
    let maxCapacity: CfnParameter | undefined
    let minCapacity: CfnParameter | undefined
    let desiredCapacity: CfnParameter | undefined

    if (runType === RunType.EC2) {
      maxCapacity = new CfnParameter(this, 'maxCapacity', {
        description: 'Maximum Capacity for Auto Scaling Group',
        default: '20',
        type: 'Number',
      })
      this.addToParamLabels('Maximum Capacity', maxCapacity.logicalId)

      minCapacity = new CfnParameter(this, 'minCapacity', {
        description: 'Minimum Capacity for Auto Scaling Group',
        default: '1',
        type: 'Number',
      })
      this.addToParamLabels('Minimum Capacity', minCapacity.logicalId)

      desiredCapacity = new CfnParameter(this, 'desiredCapacity', {
        description: 'Desired Capacity for Auto Scaling Group',
        default: '1',
        type: 'Number',
      })
      this.addToParamLabels('Desired Capacity', desiredCapacity.logicalId)

      this.addToParamGroups('Advanced Options', finderDepth.logicalId, finderNumber.logicalId, workerNumber.logicalId, includeMetadata.logicalId,
        maxCapacity.logicalId, minCapacity.logicalId, desiredCapacity.logicalId)

    }

    this.templateOptions.description = `(SO8002) - Data Transfer Hub - S3 Plugin - Template version ${VERSION}`;

    this.templateOptions.metadata = {
      'AWS::CloudFormation::Interface': {
        ParameterGroups: this.paramGroups,
        ParameterLabels: this.paramLabels,
      }
    }

    // Get Secret for credentials from Secrets Manager
    const srcCred = sm.Secret.fromSecretNameV2(this, 'SrcCredentialsParam', srcCredentials.valueAsString);
    const destCred = sm.Secret.fromSecretNameV2(this, 'DestCredentialsParam', destCredentials.valueAsString);

    // const bucketName = Fn.conditionIf(isSrc.logicalId, destBucket.valueAsString, srcBucket.valueAsString).toString();
    const srcIBucket = s3.Bucket.fromBucketName(this, `SrcBucket`, srcBucket.valueAsString);
    const destIBucket = s3.Bucket.fromBucketName(this, `DestBucket`, destBucket.valueAsString);

    // Get VPC
    const vpc = ec2.Vpc.fromVpcAttributes(this, 'EC2Vpc', {
      vpcId: ec2VpcId.valueAsString,
      availabilityZones: Fn.getAzs(),
      publicSubnetIds: ec2Subnets.valueAsList
    })

    // Start Common Stack
    const commonProps: CommonProps = {
      alarmEmail: alarmEmail.valueAsString,
    }

    const commonStack = new CommonStack(this, 'Common', commonProps)

    const defaultPolicy = new iam.Policy(this, 'DefaultPolicy');

    defaultPolicy.addStatements(
      new iam.PolicyStatement({
        actions: [
          "dynamodb:BatchGetItem",
          "dynamodb:GetRecords",
          "dynamodb:GetShardIterator",
          "dynamodb:Query",
          "dynamodb:GetItem",
          "dynamodb:Scan",
          "dynamodb:ConditionCheckItem",
          "dynamodb:BatchWriteItem",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:DeleteItem",
        ],
        resources: [commonStack.jobTable.tableArn],
      }),
      new iam.PolicyStatement({
        actions: [
          "secretsmanager:GetSecretValue",
          "secretsmanager:DescribeSecret",
        ],
        resources: [
          `${srcCred.secretArn}-??????`,
          `${destCred.secretArn}-??????`,
        ],
      })

    )

    // Start Finder - EC2 Stack
    const finderEnv = {
      AWS_DEFAULT_REGION: Aws.REGION,
      JOB_TABLE_NAME: commonStack.jobTable.tableName,
      JOB_QUEUE_NAME: commonStack.sqsQueue.queueName,
      SOURCE_TYPE: srcType.valueAsString,
      SRC_BUCKET: srcBucket.valueAsString,
      SRC_PREFIX: srcPrefix.valueAsString,
      SRC_PREFIX_LIST: srcPrefixsListFile.valueAsString,
      SRC_REGION: srcRegion.valueAsString,
      SRC_ENDPOINT: srcEndpoint.valueAsString,
      SRC_CREDENTIALS: srcCredentials.valueAsString,
      SRC_IN_CURRENT_ACCOUNT: srcInCurrentAccount.valueAsString,
      SKIP_COMPARE: srcSkipCompare.valueAsString,

      DEST_BUCKET: destBucket.valueAsString,
      DEST_PREFIX: destPrefix.valueAsString,
      DEST_REGION: destRegion.valueAsString,
      DEST_CREDENTIALS: destCredentials.valueAsString,
      DEST_IN_CURRENT_ACCOUNT: destInCurrentAccount.valueAsString,

      FINDER_DEPTH: finderDepth.valueAsString,
      FINDER_NUMBER: finderNumber.valueAsString,

      PROXY_HOST: proxyHost.valueAsString,
    }

    const finderProps: Ec2FinderProps = {
      env: finderEnv,
      vpc: vpc,
      ec2SubnetIds: ec2Subnets.valueAsList,
      cliRelease: cliRelease,
      ec2CronExpression: ec2CronExpression.valueAsString,
      ec2Memory: finderEc2Memory.valueAsString,
    }
    const finderStack = new Ec2FinderStack(this, 'FinderStack', finderProps)
    finderStack.finderRole.attachInlinePolicy(defaultPolicy)
    commonStack.sqsQueue.grantSendMessages(finderStack.finderRole);
    srcIBucket.grantRead(finderStack.finderRole)
    destIBucket.grantRead(finderStack.finderRole)

    const workerEnv = {
      JOB_TABLE_NAME: commonStack.jobTable.tableName,
      JOB_QUEUE_NAME: commonStack.sqsQueue.queueName,
      SOURCE_TYPE: srcType.valueAsString,

      SRC_BUCKET: srcBucket.valueAsString,
      SRC_PREFIX: srcPrefix.valueAsString,
      SRC_PREFIX_LIST: srcPrefixsListFile.valueAsString,
      SRC_REGION: srcRegion.valueAsString,
      SRC_ENDPOINT: srcEndpoint.valueAsString,
      SRC_CREDENTIALS: srcCredentials.valueAsString,
      SRC_IN_CURRENT_ACCOUNT: srcInCurrentAccount.valueAsString,

      DEST_BUCKET: destBucket.valueAsString,
      DEST_PREFIX: destPrefix.valueAsString,
      DEST_REGION: destRegion.valueAsString,
      DEST_CREDENTIALS: destCredentials.valueAsString,
      DEST_IN_CURRENT_ACCOUNT: destInCurrentAccount.valueAsString,
      DEST_STORAGE_CLASS: destStorageClass.valueAsString,
      DEST_ACL: destAcl.valueAsString,

      FINDER_DEPTH: finderDepth.valueAsString,
      FINDER_NUMBER: finderNumber.valueAsString,
      WORKER_NUMBER: workerNumber.valueAsString,
      INCLUDE_METADATA: includeMetadata.valueAsString,

      PROXY_HOST: proxyHost.valueAsString,
    }

    let asgName = undefined
    let handler = undefined
    if (runType === RunType.EC2) {
      const ec2Props: Ec2WorkerProps = {
        env: workerEnv,
        vpc: vpc,
        queue: commonStack.sqsQueue,
        maxCapacity: maxCapacity?.valueAsNumber,
        minCapacity: minCapacity?.valueAsNumber,
        desiredCapacity: desiredCapacity?.valueAsNumber,
        cliRelease: cliRelease,
      }

      const ec2Stack = new Ec2WorkerStack(this, 'EC2WorkerStack', ec2Props)

      ec2Stack.workerAsg.role.attachInlinePolicy(defaultPolicy)
      commonStack.sqsQueue.grantConsumeMessages(ec2Stack.workerAsg.role);
      srcIBucket.grantRead(ec2Stack.workerAsg.role)
      destIBucket.grantReadWrite(ec2Stack.workerAsg.role)

      asgName = ec2Stack.workerAsg.autoScalingGroupName
    }

    // Setup Cloudwatch Dashboard
    const dbProps: DBProps = {
      runType: runType,
      queue: commonStack.sqsQueue,
      asgName: asgName,
    }
    new DashboardStack(this, 'DashboardStack', dbProps);

    commonStack.sqsQueue.addToResourcePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        conditions: {
          StringEquals: {
            "aws:SourceArn": srcIBucket.bucketArn,
          },
        },
        principals: [new iam.ServicePrincipal("s3.amazonaws.com")],
        resources: [commonStack.sqsQueue.queueArn],
        actions: [
          "sqs:SendMessage"
        ],
      })
    );
    
    // Here we create the notification resource by default
    // Using cdk condition to enable or disable this notification
    // Using cdk Aspects to modify the event type.
    srcIBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.SqsDestination(commonStack.sqsQueue),
      {
        prefix: srcPrefix.valueAsString,
      }
    );

    const hasDelete = new CfnCondition(this, 'hasDelete', {
      expression: Fn.conditionEquals('CreateAndDelete', srcEvent.valueAsString),
    });
    const events = Fn.conditionIf(hasDelete.logicalId, 's3:ObjectCreated:*,s3:ObjectRemoved:*', 's3:ObjectCreated:*').toString();
    const s3EventConfiguration = [
      {
        "Events": Fn.split(",", events),
        "Filter": {
          "Key": {
            "FilterRules": [
              {
                "Name": "prefix",
                "Value": srcPrefix.valueAsString
              }
            ]
          }
        },
        "QueueArn": commonStack.sqsQueue.queueArn
      }
    ]
    Aspects.of(this).add(
      new InjectS3CreateAndDeleteEventConfig(s3EventConfiguration)
    );

    const useS3Event = new CfnCondition(this, 'UseS3Event', {
      expression: Fn.conditionAnd(
        // source in current account
        Fn.conditionEquals('true', srcInCurrentAccount.valueAsString),
        // Source Type is Amazon S3 - Optional
        Fn.conditionEquals('Amazon_S3', srcType.valueAsString),
        // Enable S3 Event is Yes
        Fn.conditionNot(Fn.conditionEquals('No', srcEvent.valueAsString)),
      ),
    });

    Aspects.of(this).add(
      new InjectS3NotificationCondition(useS3Event)
    );
  }
}

class InjectS3NotificationCondition implements IAspect {
  public constructor(private condition: CfnCondition) { }

  public visit(node: IConstruct): void {
    if (
      node instanceof CfnResource &&
      node.cfnResourceType === "Custom::S3BucketNotifications"
    ) {
      node.cfnOptions.condition = this.condition;
    }
  }
}

class InjectS3CreateAndDeleteEventConfig implements IAspect {
  public constructor(private queueConfigurations: any) { }

  public visit(node: IConstruct): void {
    if (
      node instanceof CfnResource &&
      node.cfnResourceType === "Custom::S3BucketNotifications"
    ) {
      node.addPropertyOverride("NotificationConfiguration.QueueConfigurations", this.queueConfigurations);
    }
  }
}