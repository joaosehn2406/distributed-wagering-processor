#!/usr/bin/env sh
set -eu
awslocal sqs create-queue --queue-name wager-transactions-dlq.fifo --attributes FifoQueue=true,ContentBasedDeduplication=false >/dev/null
awslocal sqs create-queue --queue-name wallet-events-dlq.fifo --attributes FifoQueue=true,ContentBasedDeduplication=false >/dev/null
WAGER_DLQ_ARN=$(awslocal sqs get-queue-attributes --queue-url "$(awslocal sqs get-queue-url --queue-name wager-transactions-dlq.fifo --query QueueUrl --output text)" --attribute-names QueueArn --query 'Attributes.QueueArn' --output text)
EVENT_DLQ_ARN=$(awslocal sqs get-queue-attributes --queue-url "$(awslocal sqs get-queue-url --queue-name wallet-events-dlq.fifo --query QueueUrl --output text)" --attribute-names QueueArn --query 'Attributes.QueueArn' --output text)
awslocal sqs create-queue --queue-name wager-transactions.fifo --attributes "FifoQueue=true,ContentBasedDeduplication=false,VisibilityTimeout=60,ReceiveMessageWaitTimeSeconds=10,RedrivePolicy={\"deadLetterTargetArn\":\"$WAGER_DLQ_ARN\",\"maxReceiveCount\":\"5\"}" >/dev/null
awslocal sqs create-queue --queue-name wallet-events.fifo --attributes "FifoQueue=true,ContentBasedDeduplication=false,RedrivePolicy={\"deadLetterTargetArn\":\"$EVENT_DLQ_ARN\",\"maxReceiveCount\":\"5\"}" >/dev/null
