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

echo "------------------------------------------------------------------------------"
echo "[Init] Get Env"
echo "------------------------------------------------------------------------------"

echo AWS_DEFAULT_REGION $1
echo AWS_ACCOUNT_ID $2

echo "------------------------------------------------------------------------------"
echo "[Build] Build Docker Image"
echo "------------------------------------------------------------------------------"
echo Building the docker image...
cd $source_dir
IMAGE_REPO_NAME=s3-migration-jobsender
IMAGE_TAG=latest
docker build -t $IMAGE_REPO_NAME:$IMAGE_TAG src/
docker tag $IMAGE_REPO_NAME:$IMAGE_TAG $1.dkr.ecr.$2.amazonaws.com/$IMAGE_REPO_NAME:$IMAGE_TAG 
