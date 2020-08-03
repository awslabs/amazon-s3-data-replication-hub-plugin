# AWS Data Replication Hub - S3 Component

AWS Data Replication Hub is a solution for replicating data from different sources into AWS.

This project is for S3 replication component. Each of the replication component can run idependently. 

The `cdk.json` file tells the CDK Toolkit how to execute your app.

## Build Source Code Package

The Lambda Code is under the `src` folder. This project is set up like a standard Python 
project.  The initialization process also creates a virtualenv within this project, 
stored under the .env directory.  To create the virtualenv it assumes that there 
is a `python3` (or `python` for Windows) executable in your path with access to 
the `venv` package. If for any reason the automatic creation of the virtualenv 
fails, you can create the virtualenv manually.

```
cd src
```

To manually create a virtualenv on MacOS and Linux:
```
$ python3 -m venv .env
```

After the init process completes and the virtualenv is created, you can use the following
step to activate your virtualenv.

```
$ source .env/bin/activate
```

If you are a Windows platform, you would activate the virtualenv like this:

```
% .env\Scripts\activate.bat
```

Once the virtualenv is activated, you can install the required dependencies.

```
$ pip install -r requirements.txt
```

## Deploy The Application

Compile TypeScript into JavaScript.  

```
npm run build
```

Deploy the Application. You need to provide at least `srcBucketName`, `destBucketName` and `alarmEmail`. 

```
cdk deploy --parameters srcBucketName=<source-bucket-name> \
--parameters destBucketName=<dest-bucket-name> \
--parameters alarmEmail=xxxxx@example.com
``` 

The following are the all allowed parameters:

* **srcBucketName:** Source bucket name. 
* **srcBucketPrefix:** Source bucket object prefix. The application will only copy keys with the certain prefix.
* **destBucketName:** Destination bucket name.
* **destBucketPrefix:** Destination bucket prefix. The application will upload to certian prefix.
* **jobType:** Choose `GET` if source bucket is not in current account. Otherwise, choose `PUT`. Default `PUT`.
* **credentialsParameterStore**: The Parameter Store used to keep AWS credentials for other regions. Default `drh-credentials`.
* **alarmEmail**: Alarm email. Errors will be sent to this email.

After you have deployed the application. the replication process will start immediately. Remember to confirm subscription
in your email in order to receive error notifications.
