import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { v4 as uuidv4 } from 'uuid';
import { Puzzle, UserStats, ratingBucket } from '../shared/types';

const client = new DynamoDBClient({});
const db = DynamoDBDocumentClient.from(client);

const PUZZLES_TABLE = process.env.PUZZLES_TABLE!;
const USER_STATS_TABLE = process.env.USER_STATS_TABLE!;
const USER_HISTORY_TABLE = process.env.USER_HISTORY_TABLE!;

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const userId = event.queryStringParameters?.userId;
  if (!userId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'userId required' }) };
  }

  // 1. Get user's current rating (default 1500).
  const statsRes = await db.send(new GetCommand({
    TableName: USER_STATS_TABLE,
    Key: { userId },
  }));
  const userRating = (statsRes.Item as UserStats | undefined)?.rating ?? 1500;
  const bucket = ratingBucket(userRating);

  // 2. Try current bucket then adjacent ones until we find an unplayed puzzle.
  const bucketsToTry = [bucket, bucket - 100, bucket + 100, bucket - 200, bucket + 200];

  for (const b of bucketsToTry) {
    const puzzle = await findUnplayedInBucket(b, userId);
    if (puzzle) {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(puzzle),
      };
    }
  }

  return { statusCode: 404, body: JSON.stringify({ error: 'No puzzles available' }) };
};

async function findUnplayedInBucket(
  bucket: number,
  userId: string,
): Promise<Puzzle | null> {
  // Random UUID as ExclusiveStartKey so we sample a different region of the
  // keyspace each call. UUIDs are uniformly distributed so this is truly random.
  const startKey = uuidv4();

  // Two queries: from randomId >= startKey, then wrap-around from beginning.
  const candidates = await queryCandidates(bucket, startKey);
  const wrapped = candidates.length < 20
    ? await queryCandidates(bucket, undefined)
    : [];

  for (const puzzle of [...candidates, ...wrapped]) {
    const seen = await db.send(new GetCommand({
      TableName: USER_HISTORY_TABLE,
      Key: { userId, puzzleId: puzzle.puzzleId },
    }));
    if (!seen.Item) return puzzle as Puzzle;
  }

  return null;
}

async function queryCandidates(bucket: number, startKey: string | undefined) {
  const res = await db.send(new QueryCommand({
    TableName: PUZZLES_TABLE,
    KeyConditionExpression: startKey
      ? 'ratingBucket = :b AND randomId >= :start'
      : 'ratingBucket = :b',
    ExpressionAttributeValues: {
      ':b': bucket,
      ...(startKey ? { ':start': startKey } : {}),
    },
    Limit: 20,
  }));
  return res.Items ?? [];
}
