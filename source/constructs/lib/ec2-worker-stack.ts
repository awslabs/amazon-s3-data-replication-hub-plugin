import { Construct, Fn, Duration, Stack, Aws, CfnParameter, NestedStack, NestedStackProps } from '@aws-cdk/core';
import * as iam from '@aws-cdk/aws-iam';
import * as ec2 from '@aws-cdk/aws-ec2';
import * as s3a from '@aws-cdk/aws-s3-assets';
import * as path from 'path';
import * as asg from '@aws-cdk/aws-autoscaling';

export interface Env {
    [key: string]: any;
}

export interface Ec2WorkerProps extends NestedStackProps {
    readonly env: Env,
    readonly vpc: ec2.IVpc,
    readonly keyName?: string,
    readonly maxCapacity?: number,
    readonly minCapacity?: number,
    readonly desiredCapacity?: number,
}

export class Ec2WorkerStack extends NestedStack {

    readonly workerAsg: asg.AutoScalingGroup

    constructor(scope: Construct, id: string, props: Ec2WorkerProps) {
        super(scope, id);

        const amznLinux = ec2.MachineImage.latestAmazonLinux({
            generation: ec2.AmazonLinuxGeneration.AMAZON_LINUX_2,
            edition: ec2.AmazonLinuxEdition.STANDARD,
            storage: ec2.AmazonLinuxStorage.GENERAL_PURPOSE,
            cpuType: ec2.AmazonLinuxCpuType.X86_64,
        });

        // For dev only
        const ec2SG = new ec2.SecurityGroup(this, 'S3MigratorSG', {
            vpc: props.vpc,
            description: 'Allow ssh access to ec2 instances',
            allowAllOutbound: true   // Can be set to false
        });
        ec2SG.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(22), 'allow ssh access from the world');

        this.workerAsg = new asg.AutoScalingGroup(this, 'S3RepWorkerASG', {
            vpc: props.vpc,
            instanceType: ec2.InstanceType.of(ec2.InstanceClass.C5, ec2.InstanceSize.LARGE),
            machineImage: amznLinux,
            maxCapacity: props.maxCapacity ? props.maxCapacity : 10,
            minCapacity: props.minCapacity ? props.minCapacity : 1,
            desiredCapacity: props.desiredCapacity ? props.desiredCapacity : 1,
            // spotPrice: "0.01",
            // healthCheck: autoscaling.HealthCheck.ec2(),
            securityGroup: ec2SG,
            keyName: props.keyName ? props.keyName : 'ad-key',
        });

        const asset = new s3a.Asset(this, 'Asset', {
            path: path.join(__dirname, '../../custom-resources'),
            exclude: ['build', 'dist', '*.egg-info', 'tests', 'ecr', 'lambda']
        });

        // asg.userData.addS3DownloadCommand({
        //     bucket: asset.bucket,
        //     bucketKey: asset.s3ObjectKey,
        // });

        this.workerAsg.userData.addCommands(
            'yum update -y',
            'yum install -y amazon-cloudwatch-agent',
            'yum install -y python3',
            'echo "net.core.default_qdisc = fq" >> /etc/sysctl.conf',
            'echo "net.ipv4.tcp_congestion_control = bbr" >> /etc/sysctl.conf',
            'sysctl -p',

            'cd /home/ec2-user/',
            `echo "export JOB_TABLE_NAME=${props.env.JOB_TABLE_NAME}" >> env.sh`,
            // `echo "export EVENT_TABLE_NAME=${props.env.EVENT_TABLE_NAME}" >> env.sh`,
            `echo "export SQS_QUEUE_NAME=${props.env.SQS_QUEUE_NAME}" >> env.sh`,
            `echo "export SRC_BUCKET_NAME=${props.env.SRC_BUCKET_NAME}" >> env.sh`,
            `echo "export SRC_BUCKET_PREFIX=${props.env.SRC_BUCKET_PREFIX}" >> env.sh`,
            `echo "export DEST_BUCKET_NAME=${props.env.DEST_BUCKET_NAME}" >> env.sh`,
            `echo "export DEST_BUCKET_PREFIX=${props.env.DEST_BUCKET_PREFIX}" >> env.sh`,
            `echo "export STORAGE_CLASS=${props.env.STORAGE_CLASS}" >> env.sh`,
            `echo "export SSM_PARAMETER_CREDENTIALS=${props.env.SSM_PARAMETER_CREDENTIALS}" >> env.sh`,
            `echo "export REGION_NAME=${props.env.REGION_NAME}" >> env.sh`,
            `echo "export JOB_TYPE=${props.env.JOB_TYPE}" >> env.sh`,
            `echo "export SOURCE_TYPE=${props.env.SOURCE_TYPE}" >> env.sh`,
            `echo "export MULTIPART_THRESHOLD=${props.env.MULTIPART_THRESHOLD}" >> env.sh`,
            `echo "export CHUNK_SIZE=${props.env.CHUNK_SIZE}" >> env.sh`,
            `echo "export MAX_THREADS=${props.env.MAX_THREADS}" >> env.sh`,
            `echo "export LOG_LEVEL=${props.env.LOG_LEVEL}" >> env.sh`,
            `echo "export AWS_DEFAULT_REGION=${Aws.REGION}" >> env.sh`,
            'echo `sysctl net.ipv4.tcp_congestion_control` > worker.log',
            `aws s3 cp s3://${asset.bucket.bucketName}/${asset.s3ObjectKey} src.zip`,
            'unzip src.zip && rm src.zip',
            'python3 -m pip install boto3',
            'python3 -m pip install -e common',
            'echo "source /home/ec2-user/env.sh" >> start-worker.sh',
            'echo "nohup python3 /home/ec2-user/script/job_worker.py >> /home/ec2-user/worker.log 2>&1 &" >> start-worker.sh',
            'chmod +x start-worker.sh',
            './start-worker.sh',
        )

        asset.grantRead(this.workerAsg)

        this.workerAsg.scaleOnCpuUtilization('cpuScale', {
            targetUtilizationPercent: 10,
            cooldown: Duration.minutes(5),
            estimatedInstanceWarmup: Duration.minutes(1),
        });

    }

}