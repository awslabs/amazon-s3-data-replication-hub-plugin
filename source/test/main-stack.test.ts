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


import { App, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import * as main from '../lib/main-stack';

beforeEach(() => {
    jest.resetModules();
    process.env = {};
});

describe("MainStack", () => {
    test("Test main stack with default setting", () => {
        const app = new App();

        // WHEN
        const stack = new main.DataTransferS3Stack(app, "MyTestStack");
        const template = Template.fromStack(stack);

        template.hasResourceProperties("AWS::DynamoDB::Table", {});

        template.resourceCountIs("AWS::SQS::Queue", 2);
    });

});