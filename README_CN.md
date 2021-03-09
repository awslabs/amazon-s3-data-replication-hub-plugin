
[English](./README.md)

# AWS Data Transfer Hub - S3插件

## Table of contents
* [介绍](#介绍)
* [新功能](#新功能)
* [架构](#架构)
* [部署](#部署)
  * [部署前准备](#部署前准备)
  * [使用AWS Cloudformation方式部署](#使用AWS-Cloudformation方式部署)
  * [用AWS CDK方式进行部署](#用AWS-CDK方式进行部署)
* [FAQ](#faq)
  * [如何监控](#如何监控)
  * [如何调试](#如何调试)
  * [我应该选择哪个版本](#我应该选择哪个版本)
* [已知问题](#已知问题)

## 介绍

[Data Transfer Hub](https://github.com/awslabs/aws-data-replication-hub)，前称是Data Replication Hub，是一个用于从不同的源复制数据到AWS的解决方案。本项目是该方案的其中一款插件（S3插件）。各插件是可以独立部署和运行的。

_本项目（AWS Date Replication Hub - S3 Plugin）是基于[huangzbaws@](https://github.com/huangzbaws) 的 [amazon-s3-resumable-upload](https://github.com/aws-samples/amazon-s3-resumable-upload) 基础上开发的。_

以下是本插件提供的功能列表：

- 用于Amazon S3中国北京和宁夏区和其他区域的相互复制
- 用于从阿里云OSS复制到Amazon S3
- 用于从腾讯云COS复制到Amazon S3
- 用于从七牛云Kodo复制到Amazon S3
- 用于从Google Cloud Storage复制到Amazon S3(海外)
- 支持元数据信息的复制
- 支持单次全量复制
- 支持增量复制
- 支持增量复制
- 支持基于S3 事件触发复制

## 新功能

在此新的V2版本（v2.x.x）中，我们将对该解决方案进行了一些**重大更改**，其中包括：

- 用Golang重写数据传输的核心逻辑，以提高并发性能。还提供了命令行工具。有关更多详细信息，请参见[drhcli](https://github.com/daixba/drhcli)。从本质上讲，这意味着该插件将使用命令行工具执行相关的任务。

- 使用Amazon EC2和Auto Scaling Group代替Lambda进行数据传输。此解决方案使用`t4g.micro`实例类型以节省成本。在撰写本文时，此实例类型在US West (Oregon)区的价格为`每小时$0.0084`。请查看[EC2定价](https://aws.amazon.com/ec2/pricing/on-demand/)以获取最新价格。

- 默认情况下，Amazon EC2操作系统将启用BBR（Bottleneck Bandwidth and RTT）以提高网络性能。

- 支持跨帐户部署。现在，您可以针对源和目标在另一个帐户中部署此解决方案。

请注意，此新版本将提供额外的运行类型（EC2）以执行数据传输。这并不一定意味着新的运行类型（EC2）在所有情况下都比Lambda更好。例如，您可能对可以启动EC2实例的数量有所限制，并且可以使用lambda并发（默认为1000），可以更快地完成作业。但是建议默认使用新的EC2运行类型，尤其是在使用Lambda的网络性能非常差的情况下。如果要部署以前的版本，请查看[Release v1.x.x](https://github.com/awslabs/amazon-s3-data-replication-hub-plugin/tree/r1)。

> 请注意，当前版本为v2.0.0-beta，在使用此新版本之前，请先查看[已知问题](#已知问题)部分。可能存在一些问题，请随时在Github中提出。

## 架构

![S3 Plugin Architect](s3-plugin-architect.png)

在AWS Fargate中运行的*JobFinder* ECS任务列出了源存储桶和目标存储桶中的所有对象，并确定应复制哪些对象，将在SQS中为每个要复制的对象创建一条消息。 *基于时间的CloudWatch规则*将触发ECS任务每小时运行一次。

该插件还支持S3事件通知，以（实时）触发复制，前提是源存储桶与部署此插件的用户位于相同的帐户（和区域）中。 事件消息也将发送到相同的SQS队列。

在Lambda或EC2中运行的*JobWorker*会使用SQS中的消息，并将对象从源存储桶传输到目标存储桶。

如果某个对象或对象的一部分传输失败，则*JobWorker*将在队列中释放该消息，并且该消息在队列中可见后将再次传输该对象（默认可见性超时设置为15分钟，大文件会自动延长)。

该插件支持传输大文件。它将大文件分成多个小的部分并利用Amazon S3的[multipart upload](https://docs.aws.amazon.com/AmazonS3/latest/dev/mpuoverview.html) 功能进行分段传输。


## 部署

有关此插件的部署的注意事项：:

- 部署本插件会自动在您的AWS账号里创建包括Lambda, DyanomoDB表，ECS任务等
- 部署预计用时3-5分钟
- 一旦部署完成，复制任务就会马上开始

###  部署前准备

- 配置 **凭据**

您需要提供“AccessKeyID”和“SecretAccessKey”（即“AK/SK”）凭据，才能从其他分区S3或其他云存储服务中读取或写入存储桶。 凭据会以安全方式存储于参数存储区。

请在**AWS Systems Manager** 的**参数存储区**创建一个参数，选择 **SecureString** 作为其类型，然后按照以下格式提供相应的**值**。

```
{
  "access_key_id": "<Your Access Key ID>",
  "secret_access_key": "<Your Access Key Secret>"
}
```

> 注意：如果该AK/SK是针对源桶, 则需要具有桶的**读**权限, 如果是针对目标桶, 则需要具有桶的**读与写**权限。


- 配置 **ECS集群** and **VPC**

此插件的部署将在您的AWS账户中启动和运行ECS Fargate任务，因此，如果您还没有配置ECS集群和VPC，则需要在部署插件之前对其进行设置。

> 注意：对于ECS群集，您可以选择**仅限网络**类型。 对于VPC，请确保VPC至少具有两个子网分布在两个可用区域上。


### 使用AWS Cloudformation方式部署

请按照以下步骤通过AWS Cloudformation部署此插件。

1.登录到AWS管理控制台，切换到将CloudFormation Stack部署到的区域。

1.单击以下按钮在该区域中启动CloudFormation堆栈。

  - 部署到AWS中国北京和宁夏区之外的其他区

  [![Launch Stack](launch-stack.svg)](https://console.aws.amazon.com/cloudformation/home#/stacks/create/template?stackName=DTHS3Stack&templateURL=https://aws-gcr-solutions.s3.amazonaws.com/data-transfer-hub-s3/v2.0.0-beta/DataTransferS3Stack-ec2.template)

  - 部署到AWS中国北京和宁夏区

  [![Launch Stack](launch-stack.svg)](https://console.amazonaws.cn/cloudformation/home#/stacks/create/template?stackName=DTHS3Stack&templateURL=https://aws-gcr-solutions.s3.cn-north-1.amazonaws.com.cn/data-transfer-hub-s3/v2.0.0-beta/DataTransferS3Stack-ec2.template)
    
1.单击**下一步**。 相应地为参数指定值。 如果需要，请更改堆栈名称。

1.单击**下一步**。 配置其他堆栈选项，例如标签（可选）。

1.单击**下一步**。 查看并勾选确认，然后单击“创建堆栈”开始部署。

如果要更改解决方案，可以参考[定制](CUSTOM_BUILD.md) 指南.

> 注意：如果不再需要复制任务，则可以从CloudFormation控制台中删除堆栈。

### 用AWS CDK方式进行部署

如果要使用AWS CDK部署此插件，请确保满足以下先决条件：

* [AWS Command Line Interface](https://aws.amazon.com/cli/)
* Node.js 12.x 或以上版本

在项目**source**文件夹下，运行以下命令将TypeScript编译为JavaScript。

```
cd source
npm install -g aws-cdk
npm install && npm run build
```

然后使用“cdk deploy”命令来部署。请相应地指定参数值，例如：

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

> 注意：如果不再需要复制任务，则可以简单地运行“cdk destroy”。 此命令将从您的AWS账户中删除本插件所创建的堆栈。

## FAQ

### 如何监控

**问题**：部署解决方案后，如何监视进度？

**回答**：部署后，将创建一个cloudwatch仪表板供您监视进度，运行/等待作业，网络，已传输/失败的对象等指标将记录在仪表板中。下图是一个示例：

![Cloudwatch Dashboard Example](docs/dashboard.png)

### 如何调试

**问题**：部署完后似乎没有正常运行，该如何调试？

**回答**：部署堆栈时，将要求您输入堆栈名称（默认为DTHS3Stack），大多数资源将使用该堆栈名称作为前缀进行创建。 例如，SQS Queue名称将采用`<堆栈名>-S3TransferQueue-<random suffix>`的格式。

此插件将创建两个主要的CloudWatch日志组。

- &lt;堆栈名&gt;-ECSStackJobFinderTaskDefDefaultContainerLogGroup-&lt;随机后缀&gt;

这是定时ECS任务的日志组。如果未传输任何数据，则应首先检查ECS任务运行日志中是否出了问题。 这是第一步。

- &lt;堆栈名&gt;-EC2WorkerStackS3RepWorkerLogGroup-&lt;随机后缀&gt;

这是所有EC2实例的日志组，可以在此处找到详细的传输日志。

如果您在日志组中找不到任何有帮组的内容，请在Github中提出问题。

### 我应该选择哪个版本

**问题**：由于有两种运行类型，EC2和Lambda，如何选择？

**回答**：一般来说，建议在大多数情况下使用EC2。但是，在可能的情况下使用任何一种方法之前，都应根据您的场景测试这两种方法。成本同样非常重要，您可以根据两种运行类型的测试结果来进行成本估算。 如果Lambda的网络性能非常差，则EC2运行类型将为您节省大量成本。


## 已知问题

在此新的V2版本（v2.x.x）中，目前尚有如下已知问题：

- 尚不支持Google GCS的复制
- 尚不支持对象元数据（如Content Type等）的复制

如果您有这样的要求，请在Github中提出问题，我们将相应地安排我们的工作。