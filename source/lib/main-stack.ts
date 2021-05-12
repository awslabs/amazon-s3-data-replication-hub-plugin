import { CfnParameter, CfnResource, Stack, StackProps, Construct, CfnCondition, Fn, Aws, CfnMapping } from '@aws-cdk/core';
import * as ssm from '@aws-cdk/aws-ssm';
import * as s3 from '@aws-cdk/aws-s3';
import * as ec2 from '@aws-cdk/aws-ec2';

import { CommonStack, CommonProps } from "./common-resources";
import { EcsStack, EcsTaskProps } from "./ecs-finder-stack";
import { Ec2WorkerStack, Ec2WorkerProps } from "./ec2-worker-stack";
import { DashboardStack, DBProps } from "./dashboard-stack";
import { EventStack, EventProps } from "./event-stack";

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

    const srcType = new CfnParameter(this, 'srcType', {
      description: 'Choose type of source storage, including Amazon S3, Aliyun OSS, Qiniu Kodo, Tencent COS or Google GCS',
      type: 'String',
      default: 'Amazon_S3',
      allowedValues: ['Amazon_S3', 'Aliyun_OSS', 'Qiniu_Kodo', 'Tencent_COS', 'Google_GCS']
    })
    this.addToParamLabels('Source Type', srcType.logicalId)

    const srcBucket = new CfnParameter(this, 'srcBucket', {
      description: 'Source Bucket Name',
      type: 'String'
    })
    this.addToParamLabels('Source Bucket', srcBucket.logicalId)

    const srcPrefix = new CfnParameter(this, 'srcPrefix', {
      description: 'Source Prefix',
      default: '',
      type: 'String'
    })
    this.addToParamLabels('Source Prefix', srcPrefix.logicalId)

    const srcRegion = new CfnParameter(this, 'srcRegion', {
      description: 'Source Region Name',
      default: '',
      type: 'String'
    })
    this.addToParamLabels('Source Region', srcRegion.logicalId)

    const srcEndpoint = new CfnParameter(this, 'srcEndpoint', {
      description: 'Source Endpoint URL, leave blank unless you want to provide a custom Endpoint URL',
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
      description: 'The Parameter Store used to keep AK/SK credentials for Source Bucket. Leave blank if source bucket is in current account or source is open data',
      default: '',
      type: 'String'
    })
    this.addToParamLabels('Source Credentials Parameter', srcCredentials.logicalId)


    const destBucket = new CfnParameter(this, 'destBucket', {
      description: 'Destination Bucket Name',
      type: 'String'
    })
    this.addToParamLabels('Destination Bucket', destBucket.logicalId)


    const destPrefix = new CfnParameter(this, 'destPrefix', {
      description: 'Destination Prefix',
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
      description: 'The Parameter Store used to keep AK/SK credentials for Destination Bucket. Leave blank if desination bucket is in current account',
      default: '',
      type: 'String'
    })
    this.addToParamLabels('Destination Credentials Parameter', destCredentials.logicalId)


    // 'STANDARD'|'REDUCED_REDUNDANCY'|'STANDARD_IA'|'ONEZONE_IA'|'INTELLIGENT_TIERING'|'GLACIER'|'DEEP_ARCHIVE'|'OUTPOSTS',
    const destStorageClass = new CfnParameter(this, 'destStorageClass', {
      description: 'Destination Storage Class, Default to STANDAD',
      default: 'STANDARD',
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

    const ecsClusterName = new CfnParameter(this, 'ecsClusterName', {
      description: 'ECS Cluster Name to run ECS task',
      default: '',
      type: 'String'
    })
    this.addToParamLabels('ECS Cluster Name', ecsClusterName.logicalId)

    const ecsVpcId = new CfnParameter(this, 'ecsVpcId', {
      description: 'VPC ID to run ECS task, e.g. vpc-bef13dc7',
      default: '',
      type: 'AWS::EC2::VPC::Id'
    })

    const ecsSubnets = new CfnParameter(this, 'ecsSubnets', {
      description: 'Subnet IDs to run ECS task. Please provide two subnets at least delimited by comma, e.g. subnet-97bfc4cd,subnet-7ad7de32',
      default: '',
      type: 'List<AWS::EC2::Subnet::Id>'
    })

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
      // allowedValues: ['No', 's3:ObjectCreated:*', 's3:ObjectRemoved:*', 's3:ObjectCreated:*,s3:ObjectRemoved:*']
    })
    this.addToParamLabels('Enable S3 Event', srcEvent.logicalId)
    // const srcEvent = new CfnParameter(this, 'srcEvent', {
    //   description: 'Whether to enable S3 Event to trigger the replication. Note that S3Event is only applicable if source is in Current account',
    //   default: '',
    //   type: 'CommaDelimitedList',
    //   allowedValues: ['', 'Create', 'Delete', 'Create,Delete', 'Delete,Create']
    // })
    // this.addToParamLabels('Source Bucket Notification', srcEvent.logicalId)


    // const multipartThreshold = new CfnParameter(this, 'multipartThreshold', {
    //   description: 'Threshold Size for multipart upload in MB, default to 10 (MB)',
    //   default: '10',
    //   type: 'String',
    //   allowedValues: ['10', '15', '20', '50', '100'],
    // })

    // const chunkSize = new CfnParameter(this, 'chunkSize', {
    //   description: 'Chunk Size for multipart upload in MB, default to 5 (MB)',
    //   default: '5',
    //   type: 'String',
    //   allowedValues: ['5', '10', '20']
    // })

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


    this.addToParamGroups('Source Information', srcType.logicalId, srcBucket.logicalId, srcPrefix.logicalId, srcRegion.logicalId, srcEndpoint.logicalId, srcInCurrentAccount.logicalId, srcCredentials.logicalId, srcEvent.logicalId)
    this.addToParamGroups('Destination Information', destBucket.logicalId, destPrefix.logicalId, destRegion.logicalId, destInCurrentAccount.logicalId, destCredentials.logicalId, destStorageClass.logicalId, destAcl.logicalId)
    this.addToParamGroups('Notification Information', alarmEmail.logicalId)
    this.addToParamGroups('ECS Cluster Information', ecsClusterName.logicalId, ecsVpcId.logicalId, ecsSubnets.logicalId)

    // let lambdaMemory: CfnParameter | undefined
    let maxCapacity: CfnParameter | undefined
    let minCapacity: CfnParameter | undefined
    let desiredCapacity: CfnParameter | undefined

    if (runType === RunType.LAMBDA) {
      // lambdaMemory = new CfnParameter(this, 'lambdaMemory', {
      //   description: 'Lambda Memory, default to 256 MB',
      //   default: '256',
      //   type: 'Number',
      //   allowedValues: ['128', '256', '512', '1024']
      // })
      // this.addToParamLabels('Lambda Memory', lambdaMemory.logicalId)
      // this.addToParamGroups('Advanced Options', lambdaMemory.logicalId)

    } else {

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

    // Get SSM parameter of credentials
    const srcCred = ssm.StringParameter.fromStringParameterAttributes(this, 'SrcCredentialsParam', {
      parameterName: srcCredentials.valueAsString,
      simpleName: true,
      type: ssm.ParameterType.SECURE_STRING,
      version: 1
    });

    const destCred = ssm.StringParameter.fromStringParameterAttributes(this, 'DestCredentialsParam', {
      parameterName: destCredentials.valueAsString,
      simpleName: true,
      type: ssm.ParameterType.SECURE_STRING,
      version: 1
    });


    // const isSrc = new CfnCondition(this, 'isSrc', {
    //   expression: Fn.conditionEquals('YES', srcInCurrentAccount),
    // });

    // const bucketName = Fn.conditionIf(isSrc.logicalId, destBucket.valueAsString, srcBucket.valueAsString).toString();
    const srcIBucket = s3.Bucket.fromBucketName(this, `SrcBucket`, srcBucket.valueAsString);
    const destIBucket = s3.Bucket.fromBucketName(this, `DestBucket`, destBucket.valueAsString);

    // Get VPC
    const vpc = ec2.Vpc.fromVpcAttributes(this, 'ECSVpc', {
      vpcId: ecsVpcId.valueAsString,
      availabilityZones: Fn.getAzs(),
      publicSubnetIds: ecsSubnets.valueAsList
    })

    // Start Common Stack
    const commonProps: CommonProps = {
      alarmEmail: alarmEmail.valueAsString,
    }

    const commonStack = new CommonStack(this, 'Common', commonProps)

    // Start Finder - ECS Stack
    const finderEnv = {
      AWS_DEFAULT_REGION: Aws.REGION,
      JOB_TABLE_NAME: commonStack.jobTable.tableName,
      JOB_QUEUE_NAME: commonStack.sqsQueue.queueName,
      SOURCE_TYPE: srcType.valueAsString,
      SRC_BUCKET: srcBucket.valueAsString,
      SRC_PREFIX: srcPrefix.valueAsString,
      SRC_REGION: srcRegion.valueAsString,
      SRC_ENDPOINT: srcEndpoint.valueAsString,
      SRC_CREDENTIALS: srcCredentials.valueAsString,
      SRC_IN_CURRENT_ACCOUNT: srcInCurrentAccount.valueAsString,

      DEST_BUCKET: destBucket.valueAsString,
      DEST_PREFIX: destPrefix.valueAsString,
      DEST_REGION: destRegion.valueAsString,
      DEST_CREDENTIALS: destCredentials.valueAsString,
      DEST_IN_CURRENT_ACCOUNT: destInCurrentAccount.valueAsString,

      FINDER_DEPTH: finderDepth.valueAsString,
      FINDER_NUMBER: finderNumber.valueAsString,

    }

    const ecsProps: EcsTaskProps = {
      env: finderEnv,
      vpc: vpc,
      ecsSubnetIds: ecsSubnets.valueAsList,
      ecsClusterName: ecsClusterName.valueAsString,
      version: VERSION
    }
    const ecsStack = new EcsStack(this, 'ECSStack', ecsProps);

    srcCred.grantRead(ecsStack.taskDefinition.taskRole)
    destCred.grantRead(ecsStack.taskDefinition.taskRole)
    // For finder, read of source and destination
    srcIBucket.grantRead(ecsStack.taskDefinition.taskRole);
    destIBucket.grantRead(ecsStack.taskDefinition.taskRole);

    commonStack.jobTable.grantReadData(ecsStack.taskDefinition.taskRole);
    commonStack.sqsQueue.grantSendMessages(ecsStack.taskDefinition.taskRole);

    const workerEnv = {
      JOB_TABLE_NAME: commonStack.jobTable.tableName,
      JOB_QUEUE_NAME: commonStack.sqsQueue.queueName,
      SOURCE_TYPE: srcType.valueAsString,

      SRC_BUCKET: srcBucket.valueAsString,
      SRC_PREFIX: srcPrefix.valueAsString,
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
      }

      const ec2Stack = new Ec2WorkerStack(this, 'EC2WorkerStack', ec2Props)

      srcCred.grantRead(ec2Stack.workerAsg.role)
      destCred.grantRead(ec2Stack.workerAsg.role)

      // For worker, read of source and read+write of destination
      srcIBucket.grantRead(ec2Stack.workerAsg.role);
      destIBucket.grantReadWrite(ec2Stack.workerAsg.role);
      commonStack.jobTable.grantReadWriteData(ec2Stack.workerAsg.role);
      commonStack.sqsQueue.grantConsumeMessages(ec2Stack.workerAsg.role);

      asgName = ec2Stack.workerAsg.autoScalingGroupName
    }
    else {
      // start Lambda stack
      // TODO: Create lambda stack
    }

    // Setup Cloudwatch Dashboard
    const dbProps: DBProps = {
      runType: runType,
      queue: commonStack.sqsQueue,
      asgName: asgName,
      handler: handler,
    }
    new DashboardStack(this, 'DashboardStack', dbProps);



    // Set up event stack
    const eventProps: EventProps = {
      events: srcEvent.valueAsString,
      bucket: srcIBucket,
      prefix: srcPrefix.valueAsString,
      queue: commonStack.sqsQueue,
    }
    const eventStack = new EventStack(this, 'EventStack', eventProps)
    eventStack.nestedStackResource?.addMetadata('nestedTemplateName', eventStack.templateFile.slice(0, -5));
    eventStack.nestedStackResource?.overrideLogicalId('EventStack')

    const isCN = new CfnCondition(this, 'IsChinaRegion', {
      expression: Fn.conditionEquals(Aws.PARTITION, 'aws-cn')
    });

    const s3Domain = Fn.conditionIf(isCN.logicalId, 'https://s3.cn-north-1.amazonaws.com.cn', 'https://s3.amazonaws.com').toString();
    eventStack.nestedStackResource?.addMetadata('domain', s3Domain);

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

    if (eventStack.nestedStackResource) {
      eventStack.nestedStackResource.cfnOptions.condition = useS3Event
    }

  }
}
