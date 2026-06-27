import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { UserStats, computeNewRating, todayUTC } from '../shared/types';

const client = new DynamoDBClient({});
const db = DynamoDBDocumentClient.from(client);

const USER_STATS_TABLE = process.env.USER_STATS_TABLE!;
const USER_HISTORY_TABLE = process.env.USER_HISTORY_TABLE!;

interface SolveRequest {
  userId: string;
  puzzleId: string;
  puzzleRating: number;
  solved: boolean;
}

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  if (!event.body) {
    return { statusCode: 400, body: JSON.stringify({ error: 'body required' }) };
  }

  const body = JSON.parse(event.body) as SolveRequest;
  const { userId, puzzleId, puzzleRating, solved } = body;

  if (!userId || !puzzleId || puzzleRating == null || solved == null) {
    return { statusCode: 400, body: JSON.stringify({ error: 'missing fields' }) };
  }

  const today = todayUTC();

  // 1. Get or create user stats.
  const statsRes = await db.send(new GetCommand({
    TableName: USER_STATS_TABLE,
    Key: { userId },
  }));
  const existing = statsRes.Item as UserStats | undefined;
  const current: UserStats = existing ?? {
    userId,
    rating: 1500,
    streak: 0,
    bestStreak: 0,
    totalSolved: 0,
    totalFailed: 0,
    dailyCount: 0,
    lastPlayDate: '',
  };

  // 2. Update rating (Elo K=32).
  const newRating = computeNewRating(current.rating, puzzleRating, solved);

  // 3. Update streak. A miss resets to 0; a solve extends it.
  const newStreak = solved ? current.streak + 1 : 0;
  const newBestStreak = Math.max(current.bestStreak, newStreak);

  // 4. Daily count resets if it's a new calendar day.
  const dailyCount = current.lastPlayDate === today ? current.dailyCount + 1 : 1;

  const updated: UserStats = {
    userId,
    rating: newRating,
    streak: newStreak,
    bestStreak: newBestStreak,
    totalSolved: current.totalSolved + (solved ? 1 : 0),
    totalFailed: current.totalFailed + (solved ? 0 : 1),
    dailyCount,
    lastPlayDate: today,
  };

  // 5. Write history entry (TTL 90 days) and update stats in parallel.
  const ttl = Math.floor(Date.now() / 1000) + 90 * 24 * 60 * 60;
  await Promise.all([
    db.send(new PutCommand({
      TableName: USER_HISTORY_TABLE,
      Item: { userId, puzzleId, date: today, solved, ttl },
    })),
    db.send(new PutCommand({
      TableName: USER_STATS_TABLE,
      Item: updated,
    })),
  ]);

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updated),
  };
};
