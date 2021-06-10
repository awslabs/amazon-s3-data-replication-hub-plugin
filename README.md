
[中文](./README_CN.md)

# Data Transfer Hub - S3 Plugin

## Table of contents
* [Introduction](#introduction)
* [New Features](#new-features)
* [Architect](#architect)
* [Deployment](#deployment)
  * [Before Deployment](#before-deployment)
  * [Deploy via AWS Cloudformation](#deploy-via-aws-cloudformation)
  * [Deploy via AWS CDK](#deploy-via-aws-cdk)
* [FAQ](#faq)
  * [How to monitor](#how-to-monitor)
  * [How to debug](#how-to-debug)
  * [How to choose run type](#how-to-choose-run-type)
* [Known Issues](#known-issues)


## Introduction


[Data Transfer Hub](https://github.com/awslabs/aws-data-replication-hub), a.k.a Data Replication Hub, is a solution for replicating data from different sources into AWS. This project is for S3 replication plugin. Each of the replication plugin can run independently. 

_This Date Transfer Hub - S3 Plugin is based on [amazon-s3-resumable-upload](https://github.com/aws-samples/amazon-s3-resumable-upload) contributed by [huangzbaws@](https://github.com/huangzbaws)._

The following are the features supported by this plugin.

- Amazon S3 object replication between AWS Beijing and Ningxia China regions and any other regions
- Replication from Aliyun OSS to Amazon S3
- Replication from Tencent COS to Amazon S3
- Replication from Qiniu Kodo to Amazon S3
- Replication from Google Cloud Storage to Amazon S3 (All Regions other than China Regions)
- Support replication with Metadata
- Support One-time replication
- Support Incremental replication
- Support S3 Events to trigger replication


## New Features

In this new V2 release (v2.x.x), we are introducing a few **breaking changes** to this solution, including:

- Use Amazon EC2 and Auto Scaling Group to do the data transfer instead of Lambda. `t4g.micro` instance type is used for this solution to save cost. The pricing of this instance type is `$0.0084 per Hour` in US West (Oregon) region at the point of writing. Check out [EC2 Pricing](https://aws.amazon.com/ec2/pricing/on-demand/) to get the latest price. 

- Amazon EC2 operating systems will by default have BBR (Bottleneck Bandwidth and RTT) enabled to improve network performance.

- Support cross account deployment. Now you can deploy this solution in account A, and then replicate data from bucket in account B to another bucket in Account C.

Note that, this new release is to provide an extra run type (EC2) to perform the data transfer. This doesn't necessarily mean the new run type (EC2) is better than the Lambda one in all circumstances. For example, you might have limitation of the number of EC2 instances can be started, and with the benefit of lambda concurrency (Default to 1000), you can complete the job more faster. But new EC2 run type will be suggested to use by default, especially when the network performance is very bad when using Lambda. If you want to deploy previous release, check out [Release v1.x.x](https://github.com/awslabs/amazon-s3-data-replication-hub-plugin/tree/r1).


## Architect

![S3 Plugin Architect](s3-plugin-architect.png)

A *JobFinder* ECS Task running in AWS Fargate lists all the objects in source and destination buckets and determines what objects should be replicated, a message for each object to be replicated will be created in SQS. A *time-based CloudWatch rule* will trigger the ECS task to run every hour. 

This plugin also supports S3 Event notification to trigger the replication (near real-time), only if the source bucket is in the same account (and region) as the one you deploy this plugin to. The event message will also be sent the same SQS queue.

The *JobWorker* either running in Lambda or EC2 consumes the message in SQS and transfer the object from source bucket to destination bucket.

If an object or a part of an object failed to transfer, the *JobWorker* will release the message in the Queue, and the object will be transferred again after the message is visible in the queue (Default visibility timeout is set to 15 minutes, extended for large objects). After a few retries, if the transfer still failed, the message will be sent to the Dead Letter Queue and an alarm will be triggered.

This plugin supports transfer large size file. It will divide it into small parts and leverage the [multipart upload](https://docs.aws.amazon.com/AmazonS3/latest/dev/mpuoverview.html) feature of Amazon S3.


## Deployment

Things to know about the deployment of this plugin:

- The deployment will automatically provision resources like lambda, dynamoDB table, ECS Task Definition, etc. in your AWS account.
- The deployment will take approximately 3-5 minutes.
- Once the deployment is completed, the data replication task will start right away.

###  Before Deployment

- Configure **credentials**

You will need to provide `AccessKeyID` and `SecretAccessKey` (namely `AK/SK`) to read or write bucket in S3 from or to another AWS account or other cloud storage service. And a Parameter Store is used to store the credentials in a secure manner.

Please create a parameter in **Parameter Store** from **AWS Systems Manager**, select **SecureString** as its type, and put a **Value** following below format.

```
{
  "access_key_id": "<Your Access Key ID>",
  "secret_access_key": "<Your Access Key Secret>"
}
```

> Note that if the AK/SK is for source bucket, **READ** access to bucket is required, if it's for destination bucket, **READ** and **WRITE** access to bucket is required.

- Set up **ECS Cluster** and **VPC**

The deployment of this plugin will launch an ECS Task running in Fargate in your AWS Account, hence you will need to set up an ECS Cluster and the VPC before the deployment if you haven't got any. 

> Note: For ECS Cluster, you can choose **Networking only** type. For VPC, please make sure the VPC should have at least two subnets across two available zones.


### Deploy via AWS Cloudformation

Please follow below steps to deploy this plugin via AWS Cloudformation.

1. Sign in to AWS Management Console, switch to the region to deploy the CloudFormation Stack to.

1. Click the following button to launch the CloudFormation Stack in that region.

    - For all Regions other than China Regions

    [![Launch Stack](launch-stack.svg)](https://console.aws.amazon.com/cloudformation/home#/stacks/create/template?stackName=DTHS3Stack&templateURL=https://aws-gcr-solutions.s3.amazonaws.com/data-transfer-hub-s3/latest/DataTransferS3Stack-ec2.template)

    - For Beijing and Ningxia China Regions

    [![Launch Stack](launch-stack.svg)](https://console.amazonaws.cn/cloudformation/home#/stacks/create/template?stackName=DTHS3Stack&templateURL=https://aws-gcr-solutions.s3.cn-north-1.amazonaws.com.cn/data-transfer-hub-s3/latest/DataTransferS3Stack-ec2.template)
    
1. Click **Next**. Specify values to parameters accordingly. Change the stack name if required.

1. Click **Next**. Configure additional stack options such as tags (Optional). 

1. Click **Next**. Review and confirm acknowledgement,  then click **Create Stack** to start the deployment.

If you want to make custom changes to this plugin, you can follow [custom build](CUSTOM_BUILD.md) guide.

> Note: You can simply delete the stack from CloudFormation console if the replication task is no longer required.

### Deploy via AWS CDK

If you want to use AWS CDK to deploy this plugin, please make sure you have met below prerequisites:

* [AWS Command Line Interface](https://aws.amazon.com/cli/)
* Node.js 12.x or later

Under the project **source** folder, run below to compile TypeScript into JavaScript. 

```
cd source
npm install -g aws-cdk
npm install && npm run build
```

Then you can run `cdk deploy` command to deploy the plugin. Please specify the parameter values accordingly, for example:

```
cdk deploy \
--parameters srcType=Amazon_S3 \
--parameters srcBucket=src-bucket \
--parameters srcRegion=us-west-2 \
--parameters srcInCurrentAccount=true \
--parameters srcEvent=CreateAndDelete \
--parameters destBucket=dest-bucket \
--parameters destRegion=cn-northwest-1 \
--parameters destCredentials=cn \
--parameters destInCurrentAccount=false \
--parameters ecsClusterName=testcluster \
--parameters ecsVpcId=vpc-92c418eb \
--parameters ecsSubnets=subnet-07f0e94f,subnet-a996ddf3 \
--parameters alarmEmail=xxx@example.com
```

> Note: You can simply run `cdk destroy` if the replication task is no longer required. This command will remove the stack created by this plugin from your AWS account.
### Parameters Table
|  Parameters   | Description | Example |
|  ----  | ----  | ----  |
| srcType | Choose type of source storage, including Amazon S3, Aliyun OSS, Qiniu Kodo, Tencent COS or Google GCS.  `default: 'Amazon_S3', allowedValues:['Amazon_S3', 'Aliyun_OSS', 'Qiniu_Kodo', 'Tencent_COS', 'Google_GCS']`| Amazon_S3 |
| srcBucket | Source Bucket Name | dth-recive-cn-north-1 |
| srcPrefix | Source Prefix `default: ''`| case1 |
| srcRegion | Source Region Name `default: ''`| cn-north-1 |
| srcEndpoint | Source Endpoint URL, leave blank unless you want to provide a custom Endpoint URL `default: ''`|
| srcInCurrentAccount | Source Bucket in current account? If not, you should provide a credential with read access. `default: 'false, allowedValues: ['true', 'false']`| false |
| srcCredentials | The parameter's name in Parameter Stroe used to keep AK/SK credentials for Source Bucket. Leave blank if source bucket is in current account or source is open data `default: ''`| drh-cn-secret-key |
| srcEvent | Whether to enable S3 Event to trigger the replication. Note that S3Event is only applicable if source is in Current account `default: 'No', allowedValues: ['No', 'Create', 'CreateAndDelete']`| No |
| includeMetadata | Add replication of object metadata, there will be additional API calls `default: 'true', allowedValues: ['true', 'false']`| false |
| destBucket | Destination Bucket Name| dth-us-west-2
| destPrefix |Destination Prefix `default: ''`|  |
| destRegion |Destination Region Name `default: ''`| us-west-2 |
| destInCurrentAccount | Destination Bucket in current account? If not, you should provide a credential with read and write access. `default: 'true', allowedValues: ['true', 'false']` | true |
| destCredentials | The parameter's name in Parameter Stroe used to keep AK/SK credentials for Destination Bucket. Leave blank if desination bucket is in current account. `default: ''`|  |
| destStorageClass | Destination Storage Class, Default to STANDAD. `default: 'STANDARD', allowedValues: ['STANDARD', 'STANDARD_IA', 'ONEZONE_IA', 'INTELLIGENT_TIERING'] `| STANDARD|
| destAcl | Destination Access Control List. `default: 'bucket-owner-full-control', allowedValues: ['private','public-read','public-read-write','authenticated-read','aws-exec-read','bucket-owner-read','bucket-owner-full-control']` | bucket-owner-full-control
| ecsClusterName | ECS Cluster Name to run ECS task `default: ''`| DataTransferHub-TaskCluster-RdOzxd4f8j3A |
| ecsVpcId | VPC ID to run ECS task `default: ''`| vpc-0494480496b8c7782 |
| ecsSubnets | Subnet IDs to run ECS task. Please provide two subnets at least delimited by comma `default: ''`| subnet-07ed6f4fff4017bd6,subnet-07da258a315d33945 |
| maxCapacity | Maximum Capacity for Auto Scaling Group `default: '20'`| 20|
| minCapacity | Minimum Capacity for Auto Scaling Group `default: '1'`| 1 |
| desiredCapacity | Desired Capacity for Auto Scaling Group `default: '1'`| 5
| workerNumber | The number of worker threads to run in one worker node/instance `default: '4'`| 4 |
| finderDepth |The depth of sub folders to compare in parallel. 0 means comparing all objects in sequence `default: '0'`| 0 |
| finderNumber |The number of finder threads to run in parallel `default: '1'`| 1 |
| alarmEmail | | xxxx@example.com |

## FAQ

### How to monitor

**Q**: After I deployed the solution, how can I monitor the progress?

**A**: After deployment, there will be a cloudwatch dashboard created for you to mornitor the progress, metrics such as running/waiting jobs, network, transferred/failed objects will be logged in the dashboard. Below screenshot is an example:

![Cloudwatch Dashboard Example](docs/dashboard.png)

### How to debug

**Q**: There seems to be something wrong, how to debug?

**A**: When you deploy the stack, you will be asked to input the stack name (default is DTHS3Stack), most of the resources will be created with name prefix as the stack name.  For example, Queue name will be in a format of `<StackName>-S3TransferQueue-<random suffix>`.

There will be two main log groups created by this plugin.

- &lt;StackName&gt;-ECSStackJobFinderTaskDefDefaultContainerLogGroup-&lt;random suffix&gt;

This is the log group for scheduled ECS Task. If there is no data transferred, you should check if something is wrong in the ECS task log. This is the first step.

- &lt;StackName&gt;-EC2WorkerStackS3RepWorkerLogGroup-&lt;random suffix&gt;

This is the log group for all EC2 instances, detailed transfer log can be found here.

If you can't find anything helpful in the log group, please raise an issue in Github.

### How to choose run type

**Q**: Since there are two run types, EC2 and Lambda, How to choose?

**A**: Generally speaking, EC2 is suggested to use for most cases. However, you should test both approach based on your scenerio before using any of them whenever possible. Cost should be very important too, you can do cost estimation base on your test result for both run type. If the network performance is very bad in Lambda, EC2 run type will save your cost a lot.


## Known Issues

In this new V2 release (v2.x.x), we are expecting below known issues:

- Google GCS is not yet supported (If you have such requirement, you will need to use release v1.x.x)

If you found any other issues, please raise one in Github Issue, we will work on the fix accordingly.
