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
import * as finder from '../lib/ecs-finder-stack';
import * as ec2 from '@aws-cdk/aws-ec2';

test('Test ECS finder stack', () => {

    const stack = new cdk.Stack();
    // WHEN
    new finder.EcsStack(stack, 'MyTestFinderStack', {
        env: {
            'SRC_BUCKET': 'test-src',
        },
        vpc: new ec2.Vpc(stack, 'TestVpc'),
        ecsSubnetIds: ['subnet-1', 'subnet-2'],
        ecsClusterName: 'TestCluster',
        cliRelease: 'v1.1.0',
        ecsCronExpression: '0/60 * * * ? *',
    });
    // THEN
    expect(SynthUtils.toCloudFormation(stack)).toMatchSnapshot();
});
