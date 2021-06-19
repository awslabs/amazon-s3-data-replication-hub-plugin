# Example IAM Policy for Amazon S3

If you want to set up a credential for Source or Destination S3 Bucket. Below is the example IAM policy with minimum permissions that you can refer to. Change the `<your-bucket-name>` in the policy statement accordingly.

## Source Bucket

```
        {
            "Sid": "dth",
            "Effect": "Allow",
            "Action": [
                "s3:GetObject",
                "s3:ListBucket",
            ],
            "Resource": [
                "arn:aws:s3:::<your-bucket-name>/*",
                "arn:aws:s3:::<your-bucket-name>"
            ]
        },
```


## Desination Bucket

```
        {
            "Sid": "dth",
            "Effect": "Allow",
            "Action": [
                "s3:PutObject",
                "s3:GetObject",
                "s3:ListBucket",
                "s3:PutObjectAcl",
                "s3:AbortMultipartUpload",
                "s3:ListBucketMultipartUploads",
                "s3:ListMultipartUploadParts"
            ],
            "Resource": [
                "arn:aws:s3:::<your-bucket-name>/*",
                "arn:aws:s3:::<your-bucket-name>"
            ]
        },
```

> Note that if you want to enable S3 Delete Event, you will need to add `"s3:DeleteObject"` permission to the policy.