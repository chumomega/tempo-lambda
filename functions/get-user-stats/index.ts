import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { UserStats, todayUTC } from '../shared/types';

const client = new DynamoDBClient({});
const db = DynamoDBDocumentClient.from(client);

const USER_STATS_TABLE = process.env.USER_STATS_TABLE!;

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const userId = event.pathParameters?.userId;
  if (!userId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'userId required' }) };
  }

  const res = await db.send(new GetCommand({
    TableName: USER_STATS_TABLE,
    Key: { userId },
  }));

  if (!res.Item) {
    // New user — return defaults so the app doesn't have to handle 404.
    const defaults: UserStats = {
      userId,
      rating: 1500,
      streak: 0,
      bestStreak: 0,
      totalSolved: 0,
      totalFailed: 0,
      dailyCount: 0,
      lastPlayDate: '',
    };
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(defaults),
    };
  }

  const stats = res.Item as UserStats;

  // Reset dailyCount if it's a new day (user may not have played yet today).
  if (stats.lastPlayDate !== todayUTC()) {
    stats.dailyCount = 0;
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(stats),
  };
};
