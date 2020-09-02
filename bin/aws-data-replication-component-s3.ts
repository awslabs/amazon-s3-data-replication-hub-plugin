#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from '@aws-cdk/core';
import { AwsDataReplicationComponentS3Stack } from '../lib/aws-data-replication-component-s3-stack';

const app = new cdk.App();
new AwsDataReplicationComponentS3Stack(app, 'AwsDataReplicationComponentS3Stack', {
  env: {
    region: process.env.CDK_DEFAULT_REGION,
    account: process.env.CDK_DEFAULT_ACCOUNT,
  }
});
