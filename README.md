# AWS Data Replication Hub - S3 Plugin

_This AWS Date Replication Hub - S3 Plugin is based on 
[amazon-s3-resumable-upload](https://github.com/aws-samples/amazon-s3-resumable-upload) contributed by
[huangzbaws@](https://github.com/huangzbaws)._

AWS Data Replication Hub is a solution for replicating data from different sources into AWS. This project is for 
S3 replication plugin. Each of the replication plugin can run independently. 

The following are the planned features of this plugin.

- [x] Replicating Amazon S3 from AWS CN Partition to AWS Standard Partition.
- [x] Replicating Amazon S3 from AWS Standard Partition to AWS CN Partition.
- [ ] Support Aliyun OSS to Amazon S3, including both CN Partition and Standard Partition.
- [x] Replicating object metadata.
- [x] Versioning support.
- [x] Large size file support.
- [x] Progress tracking and monitoring.
- [x] Support provision in both CN Partition and Standard Partition.
- [x] Deployment via AWS CDK.


## Architect

![S3 Plugin Architect](s3-plugin-architect.png)

The *JobSender* Lambda function lists all the objects in source and destination buckets and determines what should be
replicated. It will update DynamoDB table to keep track of every object status. Besides, a message will be created in SQS.
The *JobWorker* Lambda function is configured to consume the message in SQS and copy data from source bucket to destination 
bucket. A *time-based CloudWatch rule* will trigger the *JobSender* every hour.

The application use `AccessKeyID` and `SecretAccessKey` to read or write S3 bucket in other AWS partition. And a *Parameter Store*
is being used to store the credentials in a secure manner. 

If an object or a part of an object failed to transfer, the application will try a few times. If it still failed after
a few retries, the message will be put in `SQS Dead-Letter-Queue`. A CloudWatch alarm will be triggered if there is message
in this QLQ, and a subsequent email notification will be sent via SNS.

This application support transfer large size file. It will divide it into small parts and leverage the 
[multipart upload](https://docs.aws.amazon.com/AmazonS3/latest/dev/mpuoverview.html) feature of Amazon S3.


## Deployment

### Prepare AWS Credentials

The program use `AccessKeyID` and `SecretAccessKey` (namely `AK/SK`) to read/write S3 Buckets in other AWS 
partition. For example, if the application will be deployed in Standard partition. Then the `AK/SK` should be 
generated from CN partition, and being stored in a Parameter Store in Standard partition.

Please create a **Parameter Store** in **AWS Systems Manager**, named it `drh-credentials`, select **SecureString** 
as its type, and put the following in the **Value**.

```
{
  "aws_access_key_id": "xxxxxxx",
  "aws_secret_access_key": "xxxxxxxxx",
  "region": "us-west-2"
}
```

Please make sure the permission associated with AK/SK should have the privilege to read/write the desired S3 bucket. 

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

### Parameters

The following are the all allowed parameters:

| Parameter                 | Default          | Description                                                                               |
|---------------------------|------------------|-------------------------------------------------------------------------------------------|
| srcBucketName             | <requires input> | Source bucket name.                                                                       |
| srcBucketPrefix           | ''               | Source bucket object prefix. The application will only copy keys with the certain prefix. |
| destBucketName            | <requires input> | Destination bucket name.                                                                  |
| destBucketPrefix          | ''               | Destination bucket prefix. The application will upload to certain prefix.                 |
| jobType                   | PUT              | Choose GET if source bucket is not in current account. Otherwise, choose PUT.             |
| credentialsParameterStore | drh-credentials  | The Parameter Store used to keep AWS credentials for other regions.                       |
| alarmEmail                | <requires input> | Alarm email. Errors will be sent to this email.                                           |



