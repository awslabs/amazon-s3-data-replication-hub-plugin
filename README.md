
[中文](./README_CN.md)

# AWS Data Replication Hub - S3 Plugin

_This AWS Date Replication Hub - S3 Plugin is based on 
[amazon-s3-resumable-upload](https://github.com/aws-samples/amazon-s3-resumable-upload) contributed by
[huangzbaws@](https://github.com/huangzbaws)._

AWS Data Replication Hub is a solution for replicating data from different sources into AWS. This project is for 
S3 replication plugin. Each of the replication plugin can run independently. 

The following are the planned features of this plugin.

- [x] Amazon S3 object replication between AWS Standard partition and AWS CN partition
- [x] Replication from Alibaba Cloud OSS to Amazon S3
- [x] Replication from Tencent COS to Amazon S3
- [x] Replication from Qiniu Kodo to Amazon S3
- [ ] Replication from Huawei Cloud OBS
- [x] Support replication with Metadata
- [x] Support One-time replication
- [x] Support Incremental replication

## Architect

![S3 Plugin Architect](s3-plugin-architect.png)

The *JobSender* ECS Task lists all the objects in source and destination buckets and determines what objects should be
replicated, a message for each object to be replicated will be created in SQS. A *time-based CloudWatch rule* will trigger the *JobSender* every hour.
The *JobWorker* Lambda function consumes the message in SQS and transfer the object from source bucket to destination 
bucket.

If an object or a part of an object failed to transfer, the application will try a few times. If it still failed after
a few retries, the message will be put in `SQS Dead-Letter-Queue`. A CloudWatch alarm will be triggered if there is message
in this QLQ, and a subsequent email notification will be sent via SNS.

This application support transfer large size file. It will divide it into small parts and leverage the 
[multipart upload](https://docs.aws.amazon.com/AmazonS3/latest/dev/mpuoverview.html) feature of Amazon S3.


## Deployment

###  Prerequisites

The application uses AccessKeyID and SecretAccessKey to read or write bucket in S3 or other cloud storage service. And a Parameter Store is used to store the credentials in a secure manner.

- for **AWS S3 to S3**

The program use `AccessKeyID` and `SecretAccessKey` (namely `AK/SK`) to read/write S3 Buckets in other AWS 
partition. For example, if the application will be deployed in Standard partition. Then the `AK/SK` should be 
generated from CN partition, and being stored in a Parameter Store in Standard partition.

Please create a **Parameter Store** in **AWS Systems Manager**, named it `drh-credentials`, select **SecureString** 
as its type, and put the following in the **Value**.

```
{
  "aws_access_key_id": "<Your AWS AccessKeyID>",
  "aws_secret_access_key": "<Your AWS AccessKeySecret>",
  "region_name": "us-west-2"
}
```

Please make sure the permission associated with AK/SK should have the privilege to read/write the desired S3 bucket. 

> Note: This works for **Qiniu Kodo** or **Tencent COS** to S3 as well, in which case, the `AK/SK` of  **Qiniu Kodo** or **Tencent COS** should be used.


- for **Aliyun OSS to AWS S3**

If source cloud storage is Aliyun OSS, please create a similar `drh-credentials` parameter with aliyun AK/SK and endpoint url. An example as below:

```
{
  "oss_access_key_id": "<Your Aliyun AccessKeyID>",
  "oss_access_key_secret": "<Your Aliyun AccessKeySecret>",
  "oss_endpoint": "http://oss-cn-hangzhou.aliyuncs.com"
}
```

### Parameters

The following are the all allowed parameters:

| Parameter                 | Default          | Description                                                                                                               |
|---------------------------|------------------|---------------------------------------------------------------------------------------------------------------------------|
| srcBucketName             | <requires input> | Source bucket name.                                                                                                       |
| srcBucketPrefix           | ''               | Source bucket object prefix. The application will only copy keys with the certain prefix.                                 |
| destBucketName            | <requires input> | Destination bucket name.                                                                                                  |
| destBucketPrefix          | ''               | Destination bucket prefix. The application will upload to certain prefix.                                                 |
| jobType                   | GET              | Choose GET if source bucket is not in current account. Otherwise, choose PUT.                                             |
| sourceType                | AWS S3           | Choose type of source storage, for example Qiniu, S3 or AliOSS                                                            |
| credentialsParameterStore | drh-credentials  | The Parameter Store used to keep AWS credentials for other regions.                                                       |
| alarmEmail                | <requires input> | Alarm email. Errors will be sent to this email.                                                                           |
| ecsClusterName            | <requires input> | ECS Cluster Name to run ECS task                                                                                          |
| ecsVpcId                  | <requires input> | VPC ID to run ECS task, e.g. vpc-bef13dc7                                                                                 |
| ecsSubnets                | <requires input> | Subnet IDs to run ECS task. Please provide two subnets at least delimited by comma, e.g. subnet-97bfc4cd,subnet-7ad7de32  |


### Deploy via AWS Cloudformation

Please follow below steps to deploy the plugin via AWS Cloudformation.

1. Sign in to AWS Management Console, switch to the region to deploy the CloudFormation Stack.

1. Click the following button to launch the CloudFormation Stack in the current region.

    [![Launch Stack](launch-stack.svg)](https://console.aws.amazon.com/cloudformation/home#/stacks/create/template?stackName=DataReplicationS3Stack&templateURL=https://drh-solution.s3-us-west-2.amazonaws.com/Aws-data-replication-component-s3/v1.0.0/Aws-data-replication-component-s3.template)
    
1. Click **Next**. Assign a stack name and input values to parameters accordingly.

1. Click **Next** and select **Create Stack**.

> Note: **Time to deploy:** Approximately 15 minutes.


### Deploy via AWS CDK

Under the project root folder, compile TypeScript into JavaScript. Make sure you have **npm** and **AWS CDK CLI** installed.

```
npm install
npm run build
```

Deploy the Application. You need to provide at least `srcBucketName`, `destBucketName` and `alarmEmail`. 

```
cdk deploy --parameters srcBucketName=<source-bucket-name> \
--parameters destBucketName=<dest-bucket-name> \
--parameters alarmEmail=xxxxx@example.com
``` 

After you have deployed the application. the replication process will start immediately. Remember to confirm subscription
in your email in order to receive error notifications.


## Create custom build

The solution can be deployed through the CloudFormation template available on the solution home page.
To make changes to the solution, download or clone this repo, update the source code and then run the deployment/build-s3-dist.sh script to deploy the updated code to an Amazon S3 bucket in your account.

### Prerequisites:
* [AWS Command Line Interface](https://aws.amazon.com/cli/)
* Node.js 12.x or later
* Docker

### 1. Clone the repository

### 2. Run unit tests for customization
Run unit tests to make sure added customization passes the tests:

```bash
chmod +x ./build-s3-dist.sh
./run-unit-tests.sh
```

### 3. Declare environment variables
```bash
export REGION=aws-region-code # the AWS region to launch the solution (e.g. us-east-1)
export DIST_OUTPUT_BUCKET=my-bucket-name # bucket where customized code will reside
export SOLUTION_NAME=my-solution-name # the solution name
export VERSION=my-version # version number for the customized code
export AWS_ACCOUNT_ID=my-account-id # AWS Account ID, (e.g. 123456789012)
```

### 4. Create an Amazon S3 Bucket
The CloudFormation template is configured to pull the Lambda deployment packages from Amazon S3 bucket in the region the template is being launched in. Create a bucket in the desired region with the region name appended to the name of the bucket.
```bash
aws s3 mb s3://$DIST_OUTPUT_BUCKET-$REGION --region $REGION
```

### 5. Create the deployment packages
Build the distributable:
```bash
chmod +x ./build-s3-dist.sh
./build-s3-dist.sh $DIST_OUTPUT_BUCKET $SOLUTION_NAME $VERSION
```

Deploy the distributable to the Amazon S3 bucket in your account:
```bash
aws s3 cp ./regional-s3-assets/ s3://$DIST_OUTPUT_BUCKET-$REGION/$SOLUTION_NAME/$VERSION/ --recursive --acl bucket-owner-full-control
aws s3 cp ./global-s3-assets/ s3://$DIST_OUTPUT_BUCKET-$REGION/$SOLUTION_NAME/$VERSION/ --recursive --acl bucket-owner-full-control
```

### 6. Build custom ECR image

Build and push to ECR repository:
```bash
chmod +x ./build-ecr.sh
./build-ecr.sh $REGION $AWS_ACCOUNT_ID
```