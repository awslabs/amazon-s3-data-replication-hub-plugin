#!/usr/bin/env node

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


import 'source-map-support/register';
import { App, Aspects, Stack } from "aws-cdk-lib";
import { DataTransferS3Stack } from '../lib/main-stack';

import {
    AwsSolutionsChecks,
    NagPackSuppression,
    NagSuppressions,
} from "cdk-nag";

const app = new App();
const stackName = process.env.CUSTOM_STACK_NAME || 'DataTransferS3Stack';

function stackSuppressions(
    stacks: Stack[],
    suppressions: NagPackSuppression[]
) {
    stacks.forEach((s) =>
        NagSuppressions.addStackSuppressions(s, suppressions, true)
    );
}

stackSuppressions([
    new DataTransferS3Stack(app, stackName),
], [
    { id: 'AwsSolutions-IAM5', reason: 'some policies need to get dynamic resources' },
    { id: 'AwsSolutions-IAM4', reason: 'these policies is used by CDK Customer Resource lambda' },
]);

Aspects.of(app).add(new AwsSolutionsChecks());