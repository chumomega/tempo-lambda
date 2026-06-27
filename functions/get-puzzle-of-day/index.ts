import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { Chess } from 'chess.js';
import { Puzzle, PotdCacheItem, todayUTC, ratingBucket } from '../shared/types';
import { v4 as uuidv4 } from 'uuid';

const client = new DynamoDBClient({});
const db = DynamoDBDocumentClient.from(client);

const POTD_TABLE = process.env.POTD_TABLE!;

export const handler: APIGatewayProxyHandlerV2 = async () => {
  const today = todayUTC();

  // 1. Check cache first.
  const cached = await db.send(new GetCommand({
    TableName: POTD_TABLE,
    Key: { date: today },
  }));

  if (cached.Item) {
    return ok(cached.Item.puzzle);
  }

  // 2. Fetch from Lichess.
  const res = await fetch('https://lichess.org/api/puzzle/daily', {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    return { statusCode: 502, body: JSON.stringify({ error: 'Lichess unavailable' }) };
  }

  const data = await res.json() as LichessPotdResponse;

  // 3. Reconstruct FEN at the puzzle's starting ply using chess.js.
  const chess = new Chess();
  chess.loadPgn(data.game.pgn);
  const history = chess.history({ verbose: true });

  // Reset and replay up to initialPly to get the FEN before the hook move.
  chess.reset();
  for (let i = 0; i < data.puzzle.initialPly; i++) {
    if (history[i]) chess.move(history[i]);
  }
  const fen = chess.fen();

  const puzzle: Puzzle = {
    puzzleId: data.puzzle.id,
    fen,
    moves: data.puzzle.solution,
    rating: data.puzzle.rating,
    ratingBucket: ratingBucket(data.puzzle.rating),
    themes: data.puzzle.themes,
    randomId: uuidv4(),
  };

  // 4. Cache with 2-day TTL.
  const ttl = Math.floor(Date.now() / 1000) + 2 * 24 * 60 * 60;
  const item: PotdCacheItem = { date: today, puzzle, ttl };
  await db.send(new PutCommand({ TableName: POTD_TABLE, Item: item }));

  return ok(puzzle);
};

function ok(puzzle: Puzzle) {
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(puzzle),
  };
}

interface LichessPotdResponse {
  puzzle: {
    id: string;
    initialPly: number;
    rating: number;
    solution: string[];
    themes: string[];
  };
  game: {
    pgn: string;
  };
}
