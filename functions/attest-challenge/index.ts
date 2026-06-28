/**
 * GET /attest/challenge
 *
 * Returns a fresh UUID challenge that the iOS client will use as the
 * clientData input for `DCAppAttestService.attestKey` and
 * `DCAppAttestService.generateAssertion`. The challenge is stored in
 * DynamoDB with a 5-minute TTL so the register endpoint can verify it.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { v4 as uuidv4 } from 'uuid';

const client = new DynamoDBClient({});
const db = DynamoDBDocumentClient.from(client);

const ATTEST_CHALLENGES_TABLE = process.env.ATTEST_CHALLENGES_TABLE!;

export const handler: APIGatewayProxyHandlerV2 = async () => {
  const challenge = uuidv4();
  const ttl = Math.floor(Date.now() / 1000) + 5 * 60; // 5-minute TTL

  await db.send(new PutCommand({
    TableName: ATTEST_CHALLENGES_TABLE,
    Item: { challenge, ttl },
  }));

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ challenge }),
  };
};
