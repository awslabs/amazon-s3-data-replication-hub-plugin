#!/bin/bash
#
# This script is used to upload cfn template and all regional assets to S3 CN partition 
#
region_list='cn-northwest-1 cn-north-1'


echo "------------------------------------------------------------------------------"
echo "[Init] Create all buckets in S3"
echo "------------------------------------------------------------------------------"

if aws s3 ls s3://$DIST_OUTPUT_BUCKET --region cn-northwest-1 2>&1 | grep -q 'NoSuchBucket'
then
echo "create global assets folder in cn-northwest-1"
aws s3 mb s3://$DIST_OUTPUT_BUCKET --region cn-northwest-1
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
echo "copy global assets to region cn-northwest-1"
# aws s3 rm s3://$DIST_OUTPUT_BUCKET --recursive
aws s3 sync ./global-s3-assets/ s3://$DIST_OUTPUT_BUCKET/$SOLUTION_NAME/$VERSION/  --region cn-northwest-1 --acl public-read --delete 

for r in $region_list
  do
   echo "copy regional assets to region $r"
   # aws s3 rm s3://$DIST_OUTPUT_BUCKET-$r --recursive
   aws s3 sync ./regional-s3-assets/ s3://$DIST_OUTPUT_BUCKET-$r/$SOLUTION_NAME/$VERSION/ --region $r  --acl public-read --delete
done