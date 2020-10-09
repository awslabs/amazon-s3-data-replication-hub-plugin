
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

Things to know about the deployment of this solution:

- The deployment will automatically provision resources like lambda, dynamoDB table, ECS Task Definition in your AWS account, etc.
- The deployment will take approximately 10 minutes.
- Once the deployment is completed, the data replication task will start right away.




###  Before Deployment

You will need to provide `AccessKeyID` and `SecretAccessKey` (namely `AK/SK`) to read or write bucket in S3 from another partition or in other cloud storage service. And a Parameter Store is used to store the credentials in a secure manner.

Please create a **Parameter Store** in **AWS Systems Manager**, you can use default name `drh-credentials` (optional), select **SecureString** as its type, and put the following in the **Value**.

```
{
  "access_key_id": "<Your Access Key ID>",
  "secret_access_key": "<Your Access Key Secret>",
  "region_name": "<Your Region>"
}
```

### Available Parameters

The following are the all allowed parameters for deployment:

| Parameter                 | Default          | Description                                                                                                               |
|---------------------------|------------------|---------------------------------------------------------------------------------------------------------------------------|
| srcBucketName             | <requires input> | Source bucket name.                                                                                                       |
| srcBucketPrefix           | ''               | Source bucket object prefix. The application will only copy keys with the certain prefix.                                 |
| destBucketName            | <requires input> | Destination bucket name.                                                                                                  |
| destBucketPrefix          | ''               | Destination bucket prefix. The application will upload to certain prefix.                                                 |
| jobType                   | GET              | Choose GET if source bucket is not in current account. Otherwise, choose PUT.                                             |
| sourceType                | AWS_S3           | Choose type of source storage, for example AWS_S3, Aliyun_OSS, Qiniu_Kodo, Tencent_COS                                    |
| credentialsParameterStore | drh-credentials  | The Parameter Name used to keep credentials in Parameter Store.                                                           |
| alarmEmail                | <requires input> | Alarm email. Errors will be sent to this email.                                                                           |
| ecsClusterName            | <requires input> | ECS Cluster Name to run ECS task                                                                                          |
| ecsVpcId                  | <requires input> | VPC ID to run ECS task, e.g. vpc-bef13dc7                                                                                 |
| ecsSubnets                | <requires input> | Subnet IDs to run ECS task. Please provide two subnets at least delimited by comma, e.g. subnet-97bfc4cd,subnet-7ad7de32  |


### Deploy via AWS Cloudformation

Please follow below steps to deploy this solution via AWS Cloudformation.

1. Sign in to AWS Management Console, switch to the region to deploy the CloudFormation Stack to.

1. Click the following button to launch the CloudFormation Stack in that region.

    [![Launch Stack](launch-stack.svg)](https://console.aws.amazon.com/cloudformation/home#/stacks/create/template?stackName=DataReplicationS3Stack&templateURL=https://drh-solution.s3-us-west-2.amazonaws.com/Aws-data-replication-component-s3/v1.0.0/Aws-data-replication-component-s3.template)
    
1. Click **Next**. Specify values to parameters accordingly. Change the stack name if needed.

1. Click **Next**. Configure additional stack options such as tags if needed. 

1. Click **Next**. Review and confirm acknowledgement,  then click **Create Stack**.

If you want to make changes to the solution, you can follow [custom build](CUSTOM_BUILD.md) guide.

> Note: You can simply delete the stack from CloudFormation console if the replication task is no longer required.

### Deploy via AWS CDK

If you want to use AWS CDK to deploy this solution, please make sure you have met below prerequisites:

* [AWS Command Line Interface](https://aws.amazon.com/cli/)
* Node.js 12.x or later
* Docker

Under the project **source** folder, run below to compile TypeScript into JavaScript. 

```
cd source
npm install -g aws-cdk
npm install && npm run build
```

Use `cdk deploy` command to deploy the solution. Please specify the parameter values accordingly, for example:

```
cdk deploy --parameters srcBucketName=<source-bucket-name> \
--parameters destBucketName=<dest-bucket-name> \
--parameters alarmEmail=xxxxx@example.com \
--parameters jobType=GET \
--parameters sourceType=AWS_S3 \
--parameters ecsClusterName=test \
--parameters ecsVpcId=vpc-bef13dc7 \
--parameters ecsSubnets=subnet-97bfc4cd,subnet-7ad7de32
```

> Note: You can simply run `cdk destroy` if the replication task is no longer required. This command will remove the solution stack from your AWS account.
