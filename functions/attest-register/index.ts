/**
 * POST /attest/register
 *
 * Body: { keyId: string, attestation: string (base64), challenge: string, userId: string }
 *
 * Validates the Apple App Attest attestation object, extracts the leaf
 * certificate's public key, and stores it in `tempo-attest-keys` keyed by
 * `keyId`. The challenge is consumed (deleted) so it cannot be replayed.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, DeleteCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { verifyAttestation } from '../shared/appAttest';

const client = new DynamoDBClient({});
const db = DynamoDBDocumentClient.from(client);

const ATTEST_CHALLENGES_TABLE = process.env.ATTEST_CHALLENGES_TABLE!;
const ATTEST_KEYS_TABLE = process.env.ATTEST_KEYS_TABLE!;

// TODO: Set APPLE_APP_ID in the CDK stack to "<TEAMID>.com.tempo.apps".
// Find your Team ID in Xcode → project target → Signing & Capabilities.
const APPLE_APP_ID = process.env.APPLE_APP_ID!;

interface RegisterBody {
  keyId: string;
  attestation: string; // base64-encoded CBOR attestation object
  challenge: string;   // UUID from GET /attest/challenge
  userId: string;
}

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  if (!event.body) {
    return { statusCode: 400, body: JSON.stringify({ error: 'body required' }) };
  }

  const body = JSON.parse(event.body) as RegisterBody;
  const { keyId, attestation, challenge, userId } = body;

  if (!keyId || !attestation || !challenge || !userId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'missing fields: keyId, attestation, challenge, userId' }) };
  }

  // ── Verify challenge exists and is not expired ───────────────────────────

  const challengeRow = await db.send(new GetCommand({
    TableName: ATTEST_CHALLENGES_TABLE,
    Key: { challenge },
  }));

  if (!challengeRow.Item) {
    return { statusCode: 404, body: JSON.stringify({ error: 'Challenge not found or expired' }) };
  }

  // Belt-and-suspenders: check TTL manually even if DynamoDB hasn't yet expired the row.
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (challengeRow.Item.ttl < nowSeconds) {
    return { statusCode: 410, body: JSON.stringify({ error: 'Challenge expired' }) };
  }

  // ── Verify attestation ───────────────────────────────────────────────────

  let publicKey: string;
  try {
    publicKey = await verifyAttestation(attestation, challenge, keyId, APPLE_APP_ID);
  } catch (err) {
    console.error('Attestation verification failed:', err);
    return { statusCode: 403, body: JSON.stringify({ error: 'Attestation verification failed' }) };
  }

  // ── Consume challenge (delete so it cannot be reused) ───────────────────

  await db.send(new DeleteCommand({
    TableName: ATTEST_CHALLENGES_TABLE,
    Key: { challenge },
  }));

  // ── Store key ────────────────────────────────────────────────────────────

  await db.send(new PutCommand({
    TableName: ATTEST_KEYS_TABLE,
    Item: {
      keyId,
      userId,
      publicKey,
      counter: 0,
      registeredAt: new Date().toISOString(),
    },
  }));

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ok: true }),
  };
};
