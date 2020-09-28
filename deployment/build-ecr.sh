#!/bin/bash
#
# This script creates the ECR image to support running the job sender in ECS
#

# Check to see if the required parameters have been provided:
if [ -z "$1" ] || [ -z "$2" ]; then
    echo "Please provide the account_id and aws_default_region to build the ecr image."
    echo "For example: ./build-ecr.sh us-west-2 1234567890"
    exit 1
fi

# Get reference for all important folders
template_dir="$PWD"
source_dir="$template_dir/../source"
template_dist_dir="$template_dir/global-s3-assets"

echo "------------------------------------------------------------------------------"
echo "[Init] Get Env"
echo "------------------------------------------------------------------------------"

echo AWS_DEFAULT_REGION $1
echo AWS_ACCOUNT_ID $2

# partition=${1%%-*}
if [[ $1 == cn-* ]];
then
  domain=$2.dkr.ecr.$1.amazonaws.com.cn
else
  domain=$2.dkr.ecr.$1.amazonaws.com
fi

echo $domain

aws ecr get-login-password --region $1 | docker login --username AWS --password-stdin $domain

echo "------------------------------------------------------------------------------"
echo "[Build] Build Docker Image"
echo "------------------------------------------------------------------------------"
echo Building the docker image...
cd $source_dir
IMAGE_REPO_NAME=s3-migration-jobsender
IMAGE_TAG=latest
docker build -t $IMAGE_REPO_NAME:$IMAGE_TAG src/
docker tag $IMAGE_REPO_NAME:$IMAGE_TAG $domain/$IMAGE_REPO_NAME:$IMAGE_TAG 



echo "------------------------------------------------------------------------------"
echo "[Push] Push Docker Image"
echo "------------------------------------------------------------------------------"
echo Push the docker image...
cd $source_dir
aws ecr create-repository --repository-name $IMAGE_REPO_NAME --region $1
docker push $domain/$IMAGE_REPO_NAME:$IMAGE_TAG

echo "Replace the docker image arn in cloud formation template"
cd $template_dist_dir
replace="s/us-west-2:347283850106/$1:$2/g"
sed -i '' -e $replace $template_dist_dir/*.template
replace="s/347283850106.dkr.ecr.us-west-2/$2.dkr.ecr.$1/g"
sed -i '' -e $replace $template_dist_dir/*.template