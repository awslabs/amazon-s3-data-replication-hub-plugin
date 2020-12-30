
[中文](./README_CN.md)

# AWS Data Replication Hub - S3 Plugin

_This AWS Date Replication Hub - S3 Plugin is based on 
[amazon-s3-resumable-upload](https://github.com/aws-samples/amazon-s3-resumable-upload) contributed by
[huangzbaws@](https://github.com/huangzbaws)._

[AWS Data Replication Hub](https://github.com/awslabs/aws-data-replication-hub) is a solution for replicating data from different sources into AWS. This project is for 
S3 replication plugin. Each of the replication plugin can run independently. 

The following are the planned features of this plugin.

- [x] Amazon S3 object replication between AWS Global partition and AWS CN partition
- [x] Replication from Aliyun OSS to Amazon S3
- [x] Replication from Tencent COS to Amazon S3
- [x] Replication from Qiniu Kodo to Amazon S3
- [ ] Replication from Huawei Cloud OBS to Amazon S3
- [x] Replication from Google Cloud Storage to Amazon S3 (Global)
- [x] Support replication with Metadata
- [x] Support One-time replication
- [x] Support Incremental replication
- [x] Support S3 Events to trigger replication

## Architect

![S3 Plugin Architect](s3-plugin-architect.png)

An ECS Task running in AWS Fargate lists all the objects in source and destination buckets and determines what objects should be
replicated, a message for each object to be replicated will be created in SQS. A *time-based CloudWatch rule* will trigger the ECS task to run every hour.

The *JobWorker* Lambda function consumes the message in SQS and transfer the object from source bucket to destination 
bucket.

If an object or a part of an object failed to transfer, the lambda will try a few times. If it still failed after
a few retries, the message will be put in `SQS Dead-Letter-Queue`. A CloudWatch alarm will be triggered and a subsequent email notification will be sent via SNS. Note that the ECS task in the next run will identify the failed objects or parts and the replication process will start again for them.

This plugin supports transfer large size file. It will divide it into small parts and leverage the 
[multipart upload](https://docs.aws.amazon.com/AmazonS3/latest/dev/mpuoverview.html) feature of Amazon S3.


## Deployment

Things to know about the deployment of this plugin:

- The deployment will automatically provision resources like lambda, dynamoDB table, ECS Task Definition in your AWS account, etc.
- The deployment will take approximately 3-5 minutes.
- Once the deployment is completed, the data replication task will start right away.

###  Before Deployment

- Configure **credentials**

You will need to provide `AccessKeyID` and `SecretAccessKey` (namely `AK/SK`) to read or write bucket in S3 from another partition or in other cloud storage service. And a Parameter Store is used to store the credentials in a secure manner.

Please create a parameter in **Parameter Store** from **AWS Systems Manager**, select **SecureString** as its type, and put a **Value** following below format.

```
{
  "access_key_id": "<Your Access Key ID>",
  "secret_access_key": "<Your Access Key Secret>"
}
```

- Set up **ECS Cluster** and **VPC**

The deployment of this plugin will launch an ECS Task running in Fargate in your AWS Account, hence you will need to set up an ECS Cluster and the VPC before the deployment if you haven't got any. 

> Note: For ECS Cluster, you can choose **Networking only** type. For VPC, please make sure the VPC should have at least two subnets across two available zones.


### Available Parameters

The following are the all allowed parameters for deployment:

| Parameter                 | Default          | Description                                                                                                               |
|---------------------------|------------------|---------------------------------------------------------------------------------------------------------------------------|
| sourceType                | Amazon_S3        | Choose type of source storage, including Amazon_S3, Aliyun_OSS, Qiniu_Kodo, Tencent_COS, Google_GCS.                      |
| jobType                   | GET              | Choose GET if source bucket is not in current account. Otherwise, choose PUT.                                             |
| srcBucketName             | <requires input> | Source bucket name.                                                                                                       |
| srcBucketPrefix           | ''               | Source bucket object prefix. The plugin will only copy keys with the certain prefix.                                      |
| destBucketName            | <requires input> | Destination bucket name.                                                                                                  |
| destBucketPrefix          | ''               | Destination bucket prefix. The plugin will upload to certain prefix.                                                      |
| destStorageClass          | STANDARD         | Destination Object Storage Class.  Allowed options: 'STANDARD', 'STANDARD_IA', 'ONEZONE_IA', 'INTELLIGENT_TIERING'        |
| ecsClusterName            | <requires input> | ECS Cluster Name to run ECS task                                                                                          |
| ecsVpcId                  | <requires input> | VPC ID to run ECS task, e.g. vpc-bef13dc7                                                                                 |
| ecsSubnets                | <requires input> | Subnet IDs to run ECS task. Please provide two subnets at least delimited by comma, e.g. subnet-97bfc4cd,subnet-7ad7de32  |
| credentialsParameterStore | ''               | The Parameter Name used to keep credentials in Parameter Store. Leave it blank if you are replicating from open buckets.  |
| regionName                | ''               | The Region Name, e.g. eu-west-1.  For Google GCS, this is optional.                                                       |
| alarmEmail                | <requires input> | Alarm email. Errors will be sent to this email.                                                                           |
| enableS3Event             | No               | Whether to enable S3 Event to trigger the replication. Only applicable if source is in Current account, default value is No. <br>Allow values: No, Create_Only, Delete_Only, Create_And_Delete. <br>Note that Delete Marker Event is not support yet.     |
| lambdaMemory              | 256              | Lambda Memory, default to 256 MB.                                                                                         |
| multipartThreshold        | 10               | Threshold Size for multipart upload in MB, default to 10 (MB)                                                             |
| chunkSize                 | 5                | Chunk Size for multipart upload in MB, default to 5 (MB)                                                                  |
| maxThreads                | 10               | Max Theads to run multipart upload in lambda, default to 10                                                               |

### Deploy via AWS Cloudformation

Please follow below steps to deploy this plugin via AWS Cloudformation.

1. Sign in to AWS Management Console, switch to the region to deploy the CloudFormation Stack to.

1. Click the following button to launch the CloudFormation Stack in that region.

    - For Standard Partition

    [![Launch Stack](launch-stack.svg)](https://console.aws.amazon.com/cloudformation/home#/stacks/create/template?stackName=DataReplicationS3Stack&templateURL=https://aws-gcr-solutions.s3.amazonaws.com/Aws-data-replication-component-s3/latest/Aws-data-replication-component-s3.template)

    - For China Partition

    [![Launch Stack](launch-stack.svg)](https://console.amazonaws.cn/cloudformation/home#/stacks/create/template?stackName=DataReplicationS3Stack&templateURL=https://aws-gcr-solutions.s3.cn-north-1.amazonaws.com.cn/Aws-data-replication-component-s3/latest/Aws-data-replication-component-s3.template)
    
1. Click **Next**. Specify values to parameters accordingly. Change the stack name if required.

1. Click **Next**. Configure additional stack options such as tags (Optional). 

1. Click **Next**. Review and confirm acknowledgement,  then click **Create Stack** to start the deployment.

If you want to make custom changes to this plugin, you can follow [custom build](CUSTOM_BUILD.md) guide.

> Note: You can simply delete the stack from CloudFormation console if the replication task is no longer required.

### Deploy via AWS CDK

If you want to use AWS CDK to deploy this plugin, please make sure you have met below prerequisites:

* [AWS Command Line Interface](https://aws.amazon.com/cli/)
* Node.js 12.x or later
* Docker

Under the project **source** folder, run below to compile TypeScript into JavaScript. 

```
cd source
npm install -g aws-cdk
npm install && npm run build
```

Then you can run `cdk deploy` command to deploy the plugin. Please specify the parameter values accordingly, for example:

```
cdk deploy --parameters srcBucketName=<source-bucket-name> \
--parameters destBucketName=<dest-bucket-name> \
--parameters alarmEmail=xxxxx@example.com \
--parameters jobType=GET \
--parameters sourceType=Amazon_S3 \
--parameters credentialsParameterStore=drh-credentials \
--parameters regionName=cn-north-1 \
--parameters ecsClusterName=test \
--parameters ecsVpcId=vpc-bef13dc7 \
--parameters ecsSubnets=subnet-97bfc4cd,subnet-7ad7de32
```

> Note: You can simply run `cdk destroy` if the replication task is no longer required. This command will remove the stack created by this plugin from your AWS account.
