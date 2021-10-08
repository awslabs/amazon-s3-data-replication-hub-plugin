/*
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/


import * as cdk from '@aws-cdk/core';
import { SynthUtils } from '@aws-cdk/assert';
import * as db from '../lib/dashboard-stack';
import * as sqs from '@aws-cdk/aws-sqs';
import { RunType } from '../lib/main-stack';

test('Test dashboard stack', () => {

    const stack = new cdk.Stack();
    // WHEN
    new db.DashboardStack(stack, 'MyTestDashboardStack', {
        runType: RunType.EC2,
        queue: new sqs.Queue(stack, 'TestQueue'),
        asgName: 'TestASG',
    });
    // THEN
    expect(SynthUtils.toCloudFormation(stack)).toMatchSnapshot();
});
