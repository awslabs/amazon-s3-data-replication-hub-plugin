#!/bin/bash
#
# This script is used to upload cfn template and all regional assets to S3 CN partition 
#
region_list='cn-northwest-1 cn-north-1'

echo "------------------------------------------------------------------------------"
echo "[Init] Create all buckets in S3"
echo "------------------------------------------------------------------------------"

for r in $region_list
  do
    if aws s3 ls s3://$DIST_OUTPUT_BUCKET-$r 2>&1 | grep -q 'NoSuchBucket'
    then
      echo "create bucket in region $r"
      aws s3 mb s3://$DIST_OUTPUT_BUCKET-$r --region $r
    else
      echo 'Bucket exists, skip this step'
    fi
done


echo "------------------------------------------------------------------------------"
echo "[Upload] Upload assets to S3"
echo "------------------------------------------------------------------------------"
for r in $region_list
  do
   echo "copy assets to region $r"
   #  aws s3 rm s3://$DIST_OUTPUT_BUCKET-$r --recursive
   aws s3 sync ./global-s3-assets/ s3://$DIST_OUTPUT_BUCKET-$r/$SOLUTION_NAME/$VERSION/ --acl public-read
   aws s3 sync ./regional-s3-assets/ s3://$DIST_OUTPUT_BUCKET-$r/$SOLUTION_NAME/$VERSION/ --delete --acl public-read
done
