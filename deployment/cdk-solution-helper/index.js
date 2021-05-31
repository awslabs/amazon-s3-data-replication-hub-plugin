/**
 *  Copyright 2019 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *
 *  Licensed under the Apache License, Version 2.0 (the "License"). You may not use this file except in compliance
 *  with the License. A copy of the License is located at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 *  or in the 'license' file accompanying this file. This file is distributed on an 'AS IS' BASIS, WITHOUT WARRANTIES
 *  OR CONDITIONS OF ANY KIND, express or implied. See the License for the specific language governing permissions
 *  and limitations under the License.
 */

// Imports
const fs = require('fs');

// Paths
const global_s3_assets = '../global-s3-assets';

// For each template in global_s3_assets ...
fs.readdirSync(global_s3_assets).forEach(file => {

  // Import and parse template file
  const raw_template = fs.readFileSync(`${global_s3_assets}/${file}`);
  let template = JSON.parse(raw_template);

  // Clean-up Lambda function code dependencies
  const resources = (template.Resources) ? template.Resources : {};
  const lambdaFunctions = Object.keys(resources).filter(function (key) {
    return resources[key].Type === "AWS::Lambda::Function";
  });
  lambdaFunctions.forEach(function (f) {
    const fn = template.Resources[f];
    if (fn.Properties.Code.hasOwnProperty('S3Bucket')) {
      // Set the S3 key reference
      let artifactHash = Object.assign(fn.Properties.Code.S3Bucket.Ref);
      // artifactHash = artifactHash.replace('AssetParameters', '');
      let start = artifactHash.indexOf('AssetParameters') + 15
      artifactHash = artifactHash.substring(start, artifactHash.indexOf('S3Bucket'));
      const assetPath = `asset${artifactHash}`;
      fn.Properties.Code.S3Key = `%%SOLUTION_NAME%%/%%VERSION%%/${assetPath}.zip`;
      // Set the S3 bucket reference
      fn.Properties.Code.S3Bucket = {
        'Fn::Sub': '%%BUCKET_NAME%%-${AWS::Region}'
      };
      // Set the handler
      // const handler = fn.Properties.Handler;
      // fn.Properties.Handler = `${assetPath}/${handler}`;
      let metadata = Object.assign(fn.Metadata);
      fn.Metadata = {
        ...metadata,
        'cfn_nag': {
          'rules_to_suppress': [
            {
              id: 'W58',
              reason: 'False alarm: The Lambda function does have the permission to write CloudWatch Logs.'
            }, {
              id: 'W92',
              reason: 'No concurrencies required for this function'
            }, {
              id: 'W89',
              reason: 'This function does not need to be deployed in a VPC'
            }
          ]
        }
      };
    }
  });

  // Clean-up Lambda layer code dependencies
  const lambdaLayers = Object.keys(resources).filter(function (key) {
    return resources[key].Type === "AWS::Lambda::LayerVersion";
  });
  lambdaLayers.forEach(function (f) {
    const fn = template.Resources[f];
    if (fn.Properties.Content.hasOwnProperty('S3Bucket')) {
      // Set the S3 key reference
      let artifactHash = Object.assign(fn.Properties.Content.S3Bucket.Ref);
      // artifactHash = artifactHash.replace('AssetParameters', '');
      let start = artifactHash.indexOf('AssetParameters') + 15
      artifactHash = artifactHash.substring(start, artifactHash.indexOf('S3Bucket'));
      const assetPath = `asset${artifactHash}`;
      fn.Properties.Content.S3Key = `%%SOLUTION_NAME%%/%%VERSION%%/${assetPath}.zip`;
      // Set the S3 bucket reference
      fn.Properties.Content.S3Bucket = {
        'Fn::Sub': '%%BUCKET_NAME%%-${AWS::Region}'
      };
      // // Set the handler
      // const handler = fn.Properties.Handler;
      // fn.Properties.Handler = `${assetPath}/${handler}`;
    }
  });

  // Clean-up nested template stack dependencies
  const nestedStacks = Object.keys(resources).filter(function (key) {
    return resources[key].Type === 'AWS::CloudFormation::Stack'
  });
  nestedStacks.forEach(function (f) {
    const fn = template.Resources[f];
    fn.Properties.TemplateURL = {
      'Fn::Join': [
        '',
        [
          fn.Metadata.domain,
          '/',
          `%%BUCKET_NAME%%/%%SOLUTION_NAME%%/%%VERSION%%/${fn.Metadata.nestedTemplateName}`
        ]
      ]
    };

    const params = fn.Properties.Parameters ? fn.Properties.Parameters : {};
    const nestedStackParameters = Object.keys(params).filter(function (key) {
      if (key.search(/[\w]*AssetParameters/g) > -1) {
        return true;
      }
      return false;
    });
    nestedStackParameters.forEach(function (stkParam) {
      fn.Properties.Parameters[stkParam] = undefined;
    });
  });


  // Clean-up parameters section
  const parameters = (template.Parameters) ? template.Parameters : {};
  const assetParameters = Object.keys(parameters).filter(function (key) {
    return key.includes('AssetParameters');
  });
  assetParameters.forEach(function (a) {
    template.Parameters[a] = undefined;
  });

  // Output modified template file
  const output_template = JSON.stringify(template, null, 2);
  fs.writeFileSync(`${global_s3_assets}/${file}`, output_template);
});