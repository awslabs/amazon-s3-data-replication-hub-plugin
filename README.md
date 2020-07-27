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


## Useful commands

 * `npm run build`   compile typescript to js
 * `npm run watch`   watch for changes and compile
 * `npm run test`    perform the jest unit tests
 * `cdk deploy`      deploy this stack to your default AWS account/region
 * `cdk diff`        compare deployed stack with current state
 * `cdk synth`       emits the synthesized CloudFormation template
