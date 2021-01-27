// import { expect as expectCDK, matchTemplate, MatchStyle } from '@aws-cdk/assert';
import * as cdk from '@aws-cdk/core';
import '@aws-cdk/assert/jest';
import * as AwsDataReplicationComponentS3 from '../lib/main-stack';

test('Empty Stack', () => {
    const app = new cdk.App();
    // WHEN
    const stack = new AwsDataReplicationComponentS3.AwsDataReplicationComponentS3Stack(app, 'MyTestStack');
    // THEN
    // expectCDK(stack).to(matchTemplate({
    //   "Resources": {}
    // }, MatchStyle.EXACT))
    expect(stack).toHaveResource('AWS::DynamoDB::Table', {
    });
});
