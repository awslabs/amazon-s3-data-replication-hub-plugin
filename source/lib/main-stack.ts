import { CfnParameter, CfnResource, Stack, StackProps, Construct, CfnCondition, Fn, Aws } from '@aws-cdk/core';
import * as ssm from '@aws-cdk/aws-ssm';
import * as s3 from '@aws-cdk/aws-s3';
import * as ec2 from '@aws-cdk/aws-ec2';

import { CommonStack, CommonProps } from "./common-resources";
import { EcsStack, EcsTaskProps } from "./ecs-finder-stack";
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
export class DataReplicationComponentS3Stack extends Stack {
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

    const sourceType = new CfnParameter(this, 'sourceType', {
      description: 'Choose type of source storage, including Amazon S3, Aliyun OSS, Qiniu Kodo, Tencent COS or Google GCS',
      type: 'String',
      default: 'Amazon_S3',
      allowedValues: ['Amazon_S3', 'Aliyun_OSS', 'Qiniu_Kodo', 'Tencent_COS', 'Google_GCS']
    })
    this.addToParamLabels('Source Type', sourceType.logicalId)

    const srcBucketName = new CfnParameter(this, 'srcBucketName', {
      description: 'Source Bucket Name',
      type: 'String'
    })
    this.addToParamLabels('Source Bucket Name', srcBucketName.logicalId)

    const srcBucketPrefix = new CfnParameter(this, 'srcBucketPrefix', {
      description: 'Source Bucket Object Prefix',
      default: '',
      type: 'String'
    })
    this.addToParamLabels('Source Bucket Prefix', srcBucketPrefix.logicalId)

    const srcRegionName = new CfnParameter(this, 'srcRegionName', {
      description: 'Source Bucket Region Name',
      default: '',
      type: 'String'
    })
    this.addToParamLabels('Source Region Name', srcRegionName.logicalId)

    const srcInCurrentAccount = new CfnParameter(this, 'srcInCurrentAccount', {
      description: 'Source Bucket in current account?',
      default: 'false',
      type: 'String',
      allowedValues: ['true', 'false']
    })
    this.addToParamLabels('Source In Current Account', srcInCurrentAccount.logicalId)

    const srcCredentials = new CfnParameter(this, 'srcCredentials', {
      description: 'The Parameter Store used to keep AK/SK credentials for Source Bucket.',
      default: '',
      type: 'String'
    })
    this.addToParamLabels('Source Credentials Parameter', srcCredentials.logicalId)


    const destBucketName = new CfnParameter(this, 'destBucketName', {
      description: 'Destination Bucket Name',
      type: 'String'
    })
    this.addToParamLabels('Destination Bucket Name', destBucketName.logicalId)


    const destBucketPrefix = new CfnParameter(this, 'destBucketPrefix', {
      description: 'Destination Bucket Object Prefix',
      default: '',
      type: 'String'
    })
    this.addToParamLabels('Destination Bucket Prefix', destBucketPrefix.logicalId)


    const destRegionName = new CfnParameter(this, 'destRegionName', {
      description: 'Destination Bucket Region Name',
      default: '',
      type: 'String'
    })
    this.addToParamLabels('Destination Region Name', destRegionName.logicalId)

    const destInCurrentAccount = new CfnParameter(this, 'destInCurrentAccount', {
      description: 'Destination Bucket in current account?',
      default: 'true',
      type: 'String',
      allowedValues: ['true', 'false']
    })
    this.addToParamLabels('Destination In Current Account', destInCurrentAccount.logicalId)

    const destCredentials = new CfnParameter(this, 'destCredentials', {
      description: 'The Parameter Store used to keep AK/SK credentials for Destination Bucket.',
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

    // 'PUT': Destination Bucket is not in current account.
    // 'GET': Source bucket is not in current account.
    // const jobType = new CfnParameter(this, 'jobType', {
    //   description: 'Choose PUT if source bucket is in current account. Otherwise, choose GET',
    //   type: 'String',
    //   default: 'GET',
    //   allowedValues: ['PUT', 'GET']
    // })
    // this.addToParamLabels('Job Type', jobType.logicalId)

    // const regionName = new CfnParameter(this, 'regionName', {
    //   description: 'Region Name. If Job Type is GET, use source region name, otherwise use destination region name.',
    //   default: '',
    //   type: 'String'
    // })
    // this.addToParamLabels('Region Name', regionName.logicalId)

    // The region credential (not the same account as Lambda) setting in SSM Parameter Store
    // const credentialsParameterStore = new CfnParameter(this, 'credentialsParameterStore', {
    //   description: 'The Parameter Store used to keep AK/SK credentials for another account. Leave it blank if you are accessing open buckets with no-sign-request',
    //   default: '',
    //   type: 'String'
    // })
    // this.addToParamLabels('Credentials Parameter Name', credentialsParameterStore.logicalId)



    const alarmEmail = new CfnParameter(this, 'alarmEmail', {
      allowedPattern: '\\w[-\\w.+]*@([A-Za-z0-9][-A-Za-z0-9]+\\.)+[A-Za-z]{2,14}',
      type: 'String',
      description: 'Errors will be sent to this email.'
    })
    this.addToParamLabels('Alarm Email', alarmEmail.logicalId)

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
    this.addToParamLabels('Enable S3 Event', enableS3Event.logicalId)


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
      allowedValues: ['5', '10', '20']
    })

    const maxThreads = new CfnParameter(this, 'maxThreads', {
      description: 'Max Theads to run multipart upload in lambda, default to 10',
      default: '10',
      type: 'String',
      allowedValues: ['5', '10', '20', '50'],
    })


    this.addToParamGroups('General Information', sourceType.logicalId)
    this.addToParamGroups('Source Information', srcBucketName.logicalId, srcBucketPrefix.logicalId, srcCredentials.logicalId, srcInCurrentAccount.logicalId, enableS3Event.logicalId)
    this.addToParamGroups('Destination Information', destBucketName.logicalId, destBucketPrefix.logicalId, destCredentials.logicalId, destInCurrentAccount.logicalId, destStorageClass.logicalId)
    // this.addToParamGroups('Extra Information', jobType.logicalId, regionName.logicalId, credentialsParameterStore.logicalId, alarmEmail.logicalId)
    this.addToParamGroups('ECS Cluster Information', ecsClusterName.logicalId, ecsVpcId.logicalId, ecsSubnets.logicalId)
    // this.addToParamGroups('Advanced Options', multipartThreshold.logicalId, chunkSize.logicalId, maxThreads.logicalId)

    let lambdaMemory: CfnParameter | undefined
    let keyName: CfnParameter | undefined
    let maxCapacity: CfnParameter | undefined
    let minCapacity: CfnParameter | undefined
    let desiredCapacity: CfnParameter | undefined

    if (runType === RunType.LAMBDA) {
      lambdaMemory = new CfnParameter(this, 'lambdaMemory', {
        description: 'Lambda Memory, default to 256 MB',
        default: '256',
        type: 'Number',
        allowedValues: ['128', '256', '512', '1024']
      })
      this.addToParamLabels('Lambda Memory', lambdaMemory.logicalId)
      this.addToParamGroups('Advanced Options', multipartThreshold.logicalId, chunkSize.logicalId, maxThreads.logicalId, lambdaMemory.logicalId)

    } else {

      // keyName = new CfnParameter(this, 'keyName', {
      //   description: 'EC2 Key Name',
      //   // default: '',
      //   type: 'AWS::EC2::KeyPair::KeyName',
      //   // type: 'String',
      // })
      // this.addToParamLabels('Key Name', keyName.logicalId)

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

      this.addToParamGroups('Advanced Options', multipartThreshold.logicalId, chunkSize.logicalId, maxThreads.logicalId,
        maxCapacity.logicalId, minCapacity.logicalId, desiredCapacity.logicalId)

    }

    this.templateOptions.description = `(SO8002) - Data Replication Hub - S3 Plugin - Template version ${VERSION}`;

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

    // const bucketName = Fn.conditionIf(isSrc.logicalId, destBucketName.valueAsString, srcBucketName.valueAsString).toString();
    const srcBucket = s3.Bucket.fromBucketName(this, `SrcBucket`, srcBucketName.valueAsString);
    const destBucket = s3.Bucket.fromBucketName(this, `DestBucket`, destBucketName.valueAsString);

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
      SOURCE_TYPE: sourceType.valueAsString,

      SRC_BUCKET_NAME: srcBucketName.valueAsString,
      SRC_BUCKET_PREFIX: srcBucketPrefix.valueAsString,
      SRC_REGION: srcRegionName.valueAsString,
      SRC_CREDENTIALS: srcCredentials.valueAsString,
      SRC_IN_CURRENT_ACCOUNT: srcInCurrentAccount.valueAsString,

      DEST_BUCKET_NAME: destBucketName.valueAsString,
      DEST_BUCKET_PREFIX: destBucketPrefix.valueAsString,
      DEST_REGION: destRegionName.valueAsString,
      DEST_CREDENTIALS: destCredentials.valueAsString,
      DEST_IN_CURRENT_ACCOUNT: destInCurrentAccount.valueAsString,

    }

    const ecsProps: EcsTaskProps = {
      env: finderEnv,
      vpc: vpc,
      ecsSubnetIds: ecsSubnets.valueAsList,
      ecsClusterName: ecsClusterName.valueAsString,
    }
    const ecsStack = new EcsStack(this, 'ECSStack', ecsProps);

    srcCred.grantRead(ecsStack.taskDefinition.taskRole)
    destCred.grantRead(ecsStack.taskDefinition.taskRole)
    srcBucket.grantRead(ecsStack.taskDefinition.taskRole);
    destBucket.grantRead(ecsStack.taskDefinition.taskRole);

    commonStack.jobTable.grantReadData(ecsStack.taskDefinition.taskRole);
    commonStack.sqsQueue.grantSendMessages(ecsStack.taskDefinition.taskRole);

    const workerEnv = {
      JOB_TABLE_NAME: commonStack.jobTable.tableName,
      JOB_QUEUE_NAME: commonStack.sqsQueue.queueName,
      SOURCE_TYPE: sourceType.valueAsString,

      SRC_BUCKET_NAME: srcBucketName.valueAsString,
      SRC_BUCKET_PREFIX: srcBucketPrefix.valueAsString,
      SRC_REGION: srcRegionName.valueAsString,
      SRC_CREDENTIALS: srcCredentials.valueAsString,
      SRC_IN_CURRENT_ACCOUNT: srcInCurrentAccount.valueAsString,

      DEST_BUCKET_NAME: destBucketName.valueAsString,
      DEST_BUCKET_PREFIX: destBucketPrefix.valueAsString,
      DEST_REGION: destRegionName.valueAsString,
      DEST_CREDENTIALS: destCredentials.valueAsString,
      DEST_IN_CURRENT_ACCOUNT: destInCurrentAccount.valueAsString,

    }

    let asgName = undefined
    let handler = undefined
    if (runType === RunType.EC2) {
      const ec2Props: Ec2WorkerProps = {
        env: workerEnv,
        vpc: vpc,
        queue: commonStack.sqsQueue,
        keyName: keyName?.valueAsString,
        maxCapacity: maxCapacity?.valueAsNumber,
        minCapacity: minCapacity?.valueAsNumber,
        desiredCapacity: desiredCapacity?.valueAsNumber,
      }

      const ec2Stack = new Ec2WorkerStack(this, 'EC2WorkerStack', ec2Props)

      srcCred.grantRead(ec2Stack.workerAsg.role)
      destCred.grantRead(ec2Stack.workerAsg.role)
      srcBucket.grantReadWrite(ec2Stack.workerAsg.role);
      destBucket.grantReadWrite(ecsStack.taskDefinition.taskRole);
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

  }
}
