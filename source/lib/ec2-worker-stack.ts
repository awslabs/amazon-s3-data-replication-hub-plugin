import { Construct, Duration, Tags, Aws, CfnMapping } from '@aws-cdk/core';
import * as iam from '@aws-cdk/aws-iam';

import * as ec2 from '@aws-cdk/aws-ec2';
import * as asg from '@aws-cdk/aws-autoscaling';
import * as sqs from '@aws-cdk/aws-sqs';
import * as cw from '@aws-cdk/aws-cloudwatch';

import { RetentionDays, LogGroup, FilterPattern } from '@aws-cdk/aws-logs';
import { DBNamespace } from './dashboard-stack';

export interface Env {
    [key: string]: any;
}

export interface Ec2WorkerProps {
    readonly env: Env,
    readonly vpc: ec2.IVpc,
    readonly queue: sqs.Queue,
    readonly maxCapacity?: number,
    readonly minCapacity?: number,
    readonly desiredCapacity?: number,
}


/***
 * EC2 Stack
 */
export class Ec2WorkerStack extends Construct {

    readonly workerAsg: asg.AutoScalingGroup

    constructor(scope: Construct, id: string, props: Ec2WorkerProps) {
        super(scope, id);

        const instanceType = new ec2.InstanceType('t4g.micro')

        const amznLinux = ec2.MachineImage.latestAmazonLinux({
            generation: ec2.AmazonLinuxGeneration.AMAZON_LINUX_2,
            edition: ec2.AmazonLinuxEdition.STANDARD,
            storage: ec2.AmazonLinuxStorage.GENERAL_PURPOSE,
            cpuType: ec2.AmazonLinuxCpuType.ARM_64,
        });


        const ec2SG = new ec2.SecurityGroup(this, 'S3RepSG', {
            vpc: props.vpc,
            description: 'Security Group for Data Replication Hub EC2 instances',
            allowAllOutbound: true
        });
        // For dev only
        // ec2SG.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(22), 'Allow ssh access');

        this.workerAsg = new asg.AutoScalingGroup(this, 'S3RepWorkerASG', {
            autoScalingGroupName: `${Aws.STACK_NAME}-Worker-ASG`,
            vpc: props.vpc,
            instanceType: instanceType,
            machineImage: amznLinux,
            maxCapacity: props.maxCapacity ? props.maxCapacity : 20,
            minCapacity: props.minCapacity ? props.minCapacity : 1,
            desiredCapacity: props.desiredCapacity ? props.desiredCapacity : 1,
            // spotPrice: "0.01",
            // healthCheck: autoscaling.HealthCheck.ec2(),
            securityGroup: ec2SG,
            // keyName: 'ad-key',  // dev only
            instanceMonitoring: asg.Monitoring.DETAILED,
            // groupMetrics: [asg.GroupMetrics.all()]
            groupMetrics: [new asg.GroupMetrics(asg.GroupMetric.DESIRED_CAPACITY, asg.GroupMetric.IN_SERVICE_INSTANCES)],
            cooldown: Duration.minutes(2),
        });

        Tags.of(this.workerAsg).add('Name', `${Aws.STACK_NAME}-Replication-Worker`, {})

        const ec2LG = new LogGroup(this, 'S3RepWorkerLogGroup', {
            retention: RetentionDays.TWO_WEEKS,
            // logGroupName: logGroupName,
            // removalPolicy: RemovalPolicy.DESTROY
        });

        const cliRelease = "1.0.1"
        const cliArch = "arm64"

        this.workerAsg.userData.addCommands(
            'yum update -y',
            'cd /home/ec2-user/',
            // `aws s3 cp ${assetUrl} src.zip`,
            // 'unzip src.zip && rm src.zip',
            'curl -LO "https://raw.githubusercontent.com/awslabs/amazon-s3-data-replication-hub-plugin/r2/source/config/cw_agent_config.json"',

            // Enable BBR
            'echo "net.core.default_qdisc = fq" >> /etc/sysctl.conf',
            'echo "net.ipv4.tcp_congestion_control = bbr" >> /etc/sysctl.conf',
            'sysctl -p',
            'echo `sysctl net.ipv4.tcp_congestion_control` > worker.log',

            // Enable Cloudwatch Agent
            'yum install -y amazon-cloudwatch-agent',
            `sed -i  -e "s/##log group##/${ec2LG.logGroupName}/g" cw_agent_config.json`,
            '/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -c file:/home/ec2-user/cw_agent_config.json -s',

            // Get CLI
            // 'cliRelease=1.0.1',
            // 'cliArch=arm64',
            `curl -LO "https://github.com/daixba/drhcli/releases/download/v${cliRelease}/drhcli_${cliRelease}_linux_${cliArch}.tar.gz"`,
            `tar zxvf drhcli_${cliRelease}_linux_${cliArch}.tar.gz`,

            // Prepare the environment variables
            `echo "export JOB_TABLE_NAME=${props.env.JOB_TABLE_NAME}" >> env.sh`,
            `echo "export JOB_QUEUE_NAME=${props.env.JOB_QUEUE_NAME}" >> env.sh`,

            `echo "export SOURCE_TYPE=${props.env.SOURCE_TYPE}" >> env.sh`,
            `echo "export SRC_BUCKET=${props.env.SRC_BUCKET}" >> env.sh`,
            `echo "export SRC_PREFIX=${props.env.SRC_PREFIX}" >> env.sh`,
            `echo "export SRC_REGION=${props.env.SRC_REGION}" >> env.sh`,
            `echo "export SRC_ENDPOINT=${props.env.SRC_ENDPOINT}" >> env.sh`,
            `echo "export SRC_CREDENTIALS=${props.env.SRC_CREDENTIALS}" >> env.sh`,
            `echo "export SRC_IN_CURRENT_ACCOUNT=${props.env.SRC_IN_CURRENT_ACCOUNT}" >> env.sh`,

            `echo "export DEST_BUCKET=${props.env.DEST_BUCKET}" >> env.sh`,
            `echo "export DEST_PREFIX=${props.env.DEST_PREFIX}" >> env.sh`,
            `echo "export DEST_REGION=${props.env.DEST_REGION}" >> env.sh`,
            `echo "export DEST_CREDENTIALS=${props.env.DEST_CREDENTIALS}" >> env.sh`,
            `echo "export DEST_IN_CURRENT_ACCOUNT=${props.env.DEST_IN_CURRENT_ACCOUNT}" >> env.sh`,
            `echo "export DEST_STORAGE_CLASS=${props.env.DEST_STORAGE_CLASS}" >> env.sh`,
            `echo "export DEST_ACL=${props.env.DEST_ACL}" >> env.sh`,

            // `echo "export MULTIPART_THRESHOLD=${props.env.MULTIPART_THRESHOLD}" >> env.sh`,
            // `echo "export CHUNK_SIZE=${props.env.CHUNK_SIZE}" >> env.sh`,
            `echo "export FINDER_DEPTH=${props.env.FINDER_DEPTH}" >> env.sh`,
            `echo "export FINDER_NUMBER=${props.env.FINDER_NUMBER}" >> env.sh`,
            `echo "export WORKER_NUMBER=${props.env.WORKER_NUMBER}" >> env.sh`,
            `echo "export INCLUDE_METADATA=${props.env.INCLUDE_METADATA}" >> env.sh`,
            `echo "export AWS_DEFAULT_REGION=${Aws.REGION}" >> env.sh`,

            // Create the script
            'echo "source /home/ec2-user/env.sh" >> start-worker.sh',
            'echo "nohup ./drhcli run -t Worker >> /home/ec2-user/worker.log 2>&1 &" >> start-worker.sh',
            'chmod +x start-worker.sh',
            // Run the script
            './start-worker.sh',
        )

        const cwAgentPolicy = new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            resources: [
                '*'
            ],
            actions: [
                'cloudwatch:PutMetricData',
                'ec2:DescribeVolumes',
                'ec2:DescribeTags',
                'logs:CreateLogGroup',
                'logs:CreateLogStream',
                'logs:PutLogEvents',
                'logs:DescribeLogStreams',
                'logs:DescribeLogGroups',
            ],
        })


        this.workerAsg.addToRolePolicy(cwAgentPolicy)

        const namespace = DBNamespace.NS_EC2

        ec2LG.addMetricFilter('CompletedBytes', {
            metricName: 'CompletedBytes',
            metricNamespace: `${Aws.STACK_NAME}`,
            metricValue: '$Bytes',
            filterPattern: FilterPattern.literal('[data, time, p="----->Completed", Bytes, ...]')
        })

        ec2LG.addMetricFilter('Transferred-Objects', {
            metricName: 'TransferredObjects',
            metricNamespace: `${Aws.STACK_NAME}`,
            metricValue: '1',
            filterPattern: FilterPattern.literal('[data, time, p="----->Transferred", ..., s="DONE"]')
        })

        ec2LG.addMetricFilter('Failed-Objects', {
            metricName: 'FailedObjects',
            metricNamespace: `${Aws.STACK_NAME}`,
            metricValue: '1',
            filterPattern: FilterPattern.literal('[data, time, p="----->Transferred", ..., s="ERROR"]')
        })

        const allMsg = new cw.MathExpression({
            expression: "notvisible + visible",
            usingMetrics: {
                notvisible: props.queue.metricApproximateNumberOfMessagesNotVisible(),
                visible: props.queue.metricApproximateNumberOfMessagesVisible(),
            },
            period: Duration.minutes(1),
            label: "# of messages",
        })

        this.workerAsg.scaleOnMetric('ScaleOutSQS', {
            metric: allMsg,
            scalingSteps: [
                { upper: 0, change: -10000 }, // Scale in when no messages to process
                { lower: 100, change: +1 },
                { lower: 500, change: +2 },
                { lower: 2000, change: +5 },
                { lower: 10000, change: +10 },
            ],
            adjustmentType: asg.AdjustmentType.CHANGE_IN_CAPACITY,
        })



    }

}