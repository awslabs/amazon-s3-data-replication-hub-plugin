import { Construct, Fn, Duration, CfnMapping, CfnCondition, Aws, NestedStack, NestedStackProps } from '@aws-cdk/core';
import * as cr from '@aws-cdk/custom-resources';
import * as iam from '@aws-cdk/aws-iam';
import * as s3 from '@aws-cdk/aws-s3';
import * as sqs from '@aws-cdk/aws-sqs';


export interface EventProps extends NestedStackProps {
    readonly events: string,
    readonly bucket: s3.IBucket,
    readonly prefix: string,
    readonly queue: sqs.Queue,
}

/***
 * Event Stack
 */
export class EventStack extends NestedStack {

    constructor(scope: Construct, id: string, props: EventProps) {
        super(scope, id);

        const sqsPolicy = new iam.PolicyStatement({
            actions: ['SQS:SendMessage'],
            effect: iam.Effect.ALLOW,
            resources: [props.queue.queueArn],
            principals: [new iam.ServicePrincipal('s3.amazonaws.com')],
            conditions: {
                StringEquals: {
                    "aws:SourceArn": props.bucket.bucketArn,
                }
            }
        })

        props.queue.addToResourcePolicy(sqsPolicy)

        // const eventTable = new CfnMapping(this, 'EventTable', {
        //     mapping: {
        //         event: {
        //             'Create': 's3:ObjectCreated:*',
        //             'Delete': 's3:ObjectRemoved:Delete',
        //         }
        //     }
        // });
        // let events = Fn.split('And', props.events).map(e => eventTable.findInMap('event', e))
        // let events = Fn.split(',', props.events)


        const hasDelete = new CfnCondition(this, 'hasDelete', {
            expression: Fn.conditionEquals('CreateAndDelete', props.events),
        });
        const events = Fn.conditionIf(hasDelete.logicalId, 's3:ObjectCreated:*,s3:ObjectRemoved:Delete', 's3:ObjectCreated:*').toString();



        const s3Notification = new cr.AwsCustomResource(this, 'S3NotificationTrigger', {
            resourceType: 'Custom::CustomResource',
            policy: cr.AwsCustomResourcePolicy.fromStatements([
                new iam.PolicyStatement({
                    actions: ["S3:PutBucketNotification", "S3:GetBucketNotification"],
                    resources: [props.bucket.bucketArn],
                }),
            ]),
            timeout: Duration.minutes(15),
            onCreate: {
                service: 'S3',
                action: 'putBucketNotificationConfiguration',
                parameters: {
                    Bucket: props.bucket.bucketName,
                    NotificationConfiguration: {
                        QueueConfigurations: [
                            {
                                Events: Fn.split(',', events),
                                QueueArn: props.queue.queueArn,
                                Id: `${props.queue.queueName}-DTH-Notification`,
                                Filter: {
                                    Key: {
                                        FilterRules: [
                                            {
                                                Name: 'prefix',
                                                Value: props.prefix,
                                            }
                                        ]
                                    }
                                }
                            }
                        ]
                    },

                },
                physicalResourceId: cr.PhysicalResourceId.of(Date.now().toString())
            },
        });
        s3Notification.node.addDependency(props.queue, sqsPolicy)
    }


}