#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from '@aws-cdk/core';
import { AwsDataReplicationComponentS3Stack } from '../lib/main-stack';

const app = new cdk.App();
new AwsDataReplicationComponentS3Stack(app, 'AwsDataReplicationComponentS3Stack');
