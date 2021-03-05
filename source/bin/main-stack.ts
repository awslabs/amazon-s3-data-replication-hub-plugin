#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from '@aws-cdk/core';
import { DataTransferS3Stack } from '../lib/main-stack';

const app = new cdk.App();
new DataTransferS3Stack(app, 'DataTransferS3Stack');
