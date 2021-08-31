
[中文](./DEPLOYMENT_CN.md)

# Deployment Guide

## 1. Prepare VPC (optional)

This solution can be deployed in both public and private subnets. Using public subnets is recommended.

- If you want to use existing VPC, please make sure the VPC has at least 2 subnets, and both subnets must have public internet access (Either public subnets with internet gateway or private subnets with NAT gateway)

- If you want to create new default VPC for this solution, please go to Step 2 and make sure you have *Create a new VPC for this cluster* selected when you create the cluster.


## 2. Set up ECS Cluster

A ECS Cluster is required for this solution to run Fargate task.

Go to AWS Management Console > Elastic Container Service (ECS). From ECS Cluster home page, click **Create Cluster**

Step 1: Select Cluster Template, make sure you choose **Network Only** type. 

Step 2: Configure cluster, just specify a cluster name and click Create. If you want to also create a new VPC (public subnets only), please also check the **Create a new VPC for this cluster** option.

![Create Cluster](cluster_en.png)



## 3. Configure credentials

You will need to provide `AccessKeyID` and `SecretAccessKey` (namely `AK/SK`) to read or write bucket in S3 from or to another AWS account or other cloud storage service, and the credential will be stored in AWS Secrets Manager.  You DON'T need to create credential for bucket in the current account you are deploying the solution to.

Go to AWS Management Console > Secrets Manager. From Secrets Manager home page, click **Store a new secret**. For secret type, please use **Other type of secrets**. For key/value paris, please copy and paste below JSON text into the Plaintext section, and change value to your AK/SK accordingly.

```
{
  "access_key_id": "<Your Access Key ID>",
  "secret_access_key": "<Your Access Key Secret>"
}
```

![Secret](secret_en.png)

Click Next to specify a secret name, and click Create in teh last step.


> Note that if the AK/SK is for source bucket, **READ** access to bucket is required, if it's for destination bucket, **READ** and **WRITE** access to bucket is required. For Amazon S3, you can refer to [Set up Credential](./IAM_POLICY.md)


## 4. Launch AWS Cloudformation Stack

Please follow below steps to deploy this solution via AWS Cloudformation.

1. Sign in to AWS Management Console, switch to the region to deploy the CloudFormation Stack to.

1. Click the following button to launch the CloudFormation Stack in that region.

    - For AWS China Regions

      [![Launch Stack](launch-stack.svg)](https://console.amazonaws.cn/cloudformation/home#/stacks/create/template?stackName=DTHS3Stack&templateURL=https://aws-gcr-solutions.s3.cn-north-1.amazonaws.com.cn/data-transfer-hub-s3/v2.1.0/DataTransferS3Stack-ec2.template)

    - For AWS Global regions

      [![Launch Stack](launch-stack.svg)](https://console.aws.amazon.com/cloudformation/home#/stacks/create/template?stackName=DTHS3Stack&templateURL=https://aws-gcr-solutions.s3.amazonaws.com/data-transfer-hub-s3/v2.1.0/DataTransferS3Stack-ec2.template)
    
1. Click **Next**. Specify values to parameters accordingly. Change the stack name if required. If you want to use the prefix list to complete the transmission of data in multiple specified prefixes, please refer to [Using Prefix List Guide](./USING_PREFIX_LIST_EN.md).

1. Click **Next**. Configure additional stack options such as tags (Optional). 

1. Click **Next**. Review and confirm acknowledgement,  then click **Create Stack** to start the deployment.

The deployment will take approximately 3-5 minutes.