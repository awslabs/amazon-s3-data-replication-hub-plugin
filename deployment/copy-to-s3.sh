#!/bin/bash
#
# This script is used to upload cfn template and all regional assets to S3 Global partition 
#
# Extend this list as required
region_list='us-west-2 us-east-1 us-east-2 us-west-1 eu-west-3 eu-west-1 eu-west-2 ap-southeast-1 ap-northeast-1 eu-central-1'

echo "------------------------------------------------------------------------------"
echo "[Init] Create all buckets in S3"
echo "------------------------------------------------------------------------------"

if aws s3 ls s3://$DIST_OUTPUT_BUCKET 2>&1 | grep -q 'NoSuchBucket'
then
echo "create global assets folder in us-west-2"
aws s3 mb s3://$DIST_OUTPUT_BUCKET --region us-west-2
for r in $region_list
  do
   echo "create bucket in region $r"
   aws s3 mb s3://$DIST_OUTPUT_BUCKET-$r --region $r
done
else
echo 'Bucket exists, skip this step'
fi

echo "------------------------------------------------------------------------------"
echo "[Upload] Upload assets to S3"
echo "------------------------------------------------------------------------------"
echo "copy global assets to region us-west-2"
# aws s3 rm s3://$DIST_OUTPUT_BUCKET --recursive
aws s3 sync ./global-s3-assets/ s3://$DIST_OUTPUT_BUCKET/$SOLUTION_NAME/$VERSION/ --acl bucket-owner-full-control --delete

for r in $region_list
  do
   echo "copy regional assets to region $r"
   # aws s3 rm s3://$DIST_OUTPUT_BUCKET-$r --recursive
   aws s3 sync ./regional-s3-assets/ s3://$DIST_OUTPUT_BUCKET-$r/$SOLUTION_NAME/$VERSION/ --acl bucket-owner-full-control --delete
done