#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from '@aws-cdk/core';
import { DataReplicationComponentS3Stack } from '../lib/main-stack';

const app = new cdk.App();
new DataReplicationComponentS3Stack(app, 'DataReplicationComponentS3Stack');
