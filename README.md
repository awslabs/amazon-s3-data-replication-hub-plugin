
[中文](./README_CN.md)

# Repository Has Been Migrated

This repository has been merged into [Data Transfer Hub](https://github.com/awslabs/data-transfer-hub/blob/main/docs/S3_PLUGIN.md). Subsequent maintenance and updates for this repository will be conducted within repository [Data Transfer Hub](https://github.com/awslabs/data-transfer-hub).

The document of this repository has been migrated to: 
- MD: https://github.com/awslabs/data-transfer-hub/blob/main/docs/S3_PLUGIN.md
- Mkdoc: https://awslabs.github.io/data-transfer-hub/en/user-guide/tutorial-s3/

The code of this repository has been migrated to:
- Infra CDK: https://github.com/awslabs/data-transfer-hub/tree/main/source/constructs/lib/s3-plugin
- Lambda: https://github.com/awslabs/data-transfer-hub/tree/main/source/constructs/lambda/plugin/s3

This migration will not impact any existing functionalities of the S3 plugin, and the S3 plugin can still be deployed independently.

# Data Transfer Hub - S3 Plugin

## Table of contents
* [Introduction](#introduction)
* [Breaking Change](#breaking-change)
* [Architect](#architect)
* [Deployment](#deployment)
* [FAQ](#faq)
  * [How to monitor](#how-to-monitor)
  * [How to debug](#how-to-debug)
  * [No CloudWatch logs](#no-cloudwatch-logs)
  * [How to customize](#how-to-customize)
* [Known Issues](#known-issues)


## Introduction

[Data Transfer Hub](https://github.com/awslabs/aws-data-replication-hub), a.k.a Data Replication Hub, is a solution for transferring data from different sources into AWS. This project is for S3 Transfer plugin. You can deploy and run this plugin independently without the UI. 

_This Date Transfer Hub - S3 Plugin is based on [amazon-s3-resumable-upload](https://github.com/aws-samples/amazon-s3-resumable-upload) contributed by [huangzbaws@](https://github.com/huangzbaws)._

The following are the features supported by this plugin.

- Transfer Amazon S3 objects between AWS China regions and Global regions
- Transfer objects from Aliyun OSS / Tencent COS / Qiniu Kodo
- Large file support
- Support S3 Event trigger
- Support Transfer with object metadata
- Support incremental data transfer
- Support transfer from S3 compatible storage
- Auto retry and error handling


## Breaking Change

Start from release v2.0.2, we have changed to use Secrets Manager to maintain the Credentials rather than using System Manager Parameter Store.  

If you have deployed a version before v2.0.2 (You can go to CloudFormation, check the Stack Info, the description will have the version info) and you want to upgrade, you must **DELETE** the existing stack and then follow the steps in the [Deployment Guide](./docs/DEPLOYMENT_EN.md) to redeploy the new version.

> Please note that once you delete the old version, any existing resource provisioned by the solution such as DynamoDB table and SQS queue and CloudWatch Dashboard will be removed as well, but existing objects in destination bucket won't be transferred again.

## Architecture

![S3 Plugin Architecture](s3-plugin-architect.png)

The Amazon S3 plugin runs the following workflows:

1.	A time-based Event Bridge rule triggers a AWS Lambda function on an hourly basis. 
2.  AWS Lambda uses the launch template to launch a data comparison job (JobFinder) in an [Amazon Elastic Compute Cloud (Amazon EC2)](https://aws.amazon.com/ec2/).
3. The job lists all the objects in the source and destination
buckets, makes comparisons among objects and determines which objects should be transferred.
4.	Amazon EC2 sends a message for each object that will be transferred to [Amazon Simple Queue Service (Amazon SQS)](https://aws.amazon.com/sqs/). Amazon S3 event messages can also be supported for more real-time data transfer; whenever there is object uploaded to source bucket, the event message is sent to the same Amazon SQS queue.
5.	A JobWorker running in Amazon EC2 consumes the messages in SQS and transfers the object from the source bucket to the destination bucket. You can use an Auto Scaling Group to control the number of EC2 instances to transfer the data based on business need.
6.	A record with transfer status for each object is stored in Amazon DynamoDB. 
7.	The Amazon EC2 instance will get (download) the object from the source bucket based on the Amazon SQS message. 
8.	The Amazon EC2 instance will put (upload) the object to the destination bucket based on the Amazon SQS message. 

This plugin supports transfer large size file. It will divide it into small parts and leverage the [multipart upload](https://docs.aws.amazon.com/AmazonS3/latest/dev/mpuoverview.html) feature of Amazon S3.

> Note: This solution uses `t4g.micro` EC2 instance type to save cost. The pricing of this instance type is `$0.0084 per Hour` in US West (Oregon) region at the point of writing. Check out [EC2 Pricing](https://aws.amazon.com/ec2/pricing/on-demand/) to get the latest price. And the EC2 operating systems will by default have BBR (Bottleneck Bandwidth and RTT) enabled to improve network performance.


## Deployment

Things to know about the deployment of this plugin:

- The deployment will automatically provision resources like lambda, dynamoDB table, ECS Task Definition, etc. in your AWS account.
- The deployment will take approximately 3-5 minutes.
- Once the deployment is completed, the data transfer task will start right away.

Please follow the steps in the [Deployment Guide](./docs/DEPLOYMENT_EN.md) to start the deployment.

> Note: You can simply delete the stack from CloudFormation console if the data transfer job is no longer required.


## FAQ

### How to monitor

**Q**: After I deployed the solution, how can I monitor the progress?

**A**: After deployment, there will be a cloudwatch dashboard created for you to mornitor the progress, metrics such as running/waiting jobs, network, transferred/failed objects will be logged in the dashboard. Below screenshot is an example:

![Cloudwatch Dashboard Example](docs/dashboard.png)

### How to debug

**Q**: There seems to be something wrong, how to debug?

**A**: When you deploy the stack, you will be asked to input the stack name (default is DTHS3Stack), most of the resources will be created with name prefix as the stack name.  For example, Queue name will be in a format of `<StackName>-S3TransferQueue-<random suffix>`.

There will be two main log groups created by this plugin.

- &lt;StackName&gt;-ECSStackFinderLogGroup&lt;random suffix&gt;

This is the log group for scheduled ECS Task. If there is no data transferred, you should check if something is wrong in the ECS task log. This is the first step.

- &lt;StackName&gt;-EC2WorkerStackS3RepWorkerLogGroup&lt;random suffix&gt;

This is the log group for all EC2 instances, detailed transfer log can be found here.

If you can't find anything helpful in the log group, please raise an issue in Github.

### No CloudWatch logs

**Q**: After I deployed, I can't find any log streams in the two CloudWatch Log Groups

**A**: This must because the subnets you choose when you deployed this solution doesn't have public network access, therefore, the Fargate task failed to pull the images, and the EC2 can't download the CloudWatch Agent to send logs to CloudWatch.  So please check you VPC set up (See [Deployment Guide](./docs/DEPLOYMENT_EN.md) Step 1). Once you fix the issue, you need to manually terminate the running EC2 instances by this solution if any. After that, the auto scaling group will automatically start new ones.


### How to customize

**Q**: I want to make some custom changes, how do I do?

If you want to make custom changes to this plugin, you can follow [custom build](./docs/CUSTOM_BUILD.md) guide.


## Known Issues

In this new V2 release (v2.x.x), we are expecting below known issues:

- Google GCS is no longer supported (you may contact us)

If you found any other issues, please raise one in Github Issue, we will work on the fix accordingly.
