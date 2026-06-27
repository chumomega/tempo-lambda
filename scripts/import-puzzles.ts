/**
 * One-shot script: reads the Lichess puzzle CSV and writes a filtered
 * subset to DynamoDB + a local SQLite for the iOS bundle.
 *
 * Usage:
 *   npm run import-puzzles -- --input ./lichess_db_puzzle.csv --limit 100000
 *
 * Filters applied (in order):
 *   1. popularity >= 80      — discard low-quality/disliked puzzles
 *   2. nbPlays >= 500        — enough data to trust the rating
 *   3. Proportional sampling per ratingBucket so no tier is over/under-represented
 *
 * Output:
 *   - DynamoDB table tempo-puzzles (all filtered rows)
 *   - ./bundled-puzzles.json  (the same rows, for bundling in the iOS app)
 */

import * as fs from 'fs';
import * as readline from 'readline';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { v4 as uuidv4 } from 'uuid';
import { ratingBucket } from '../functions/shared/types';

const client = new DynamoDBClient({ region: process.env.AWS_REGION ?? 'us-east-1' });
const db = DynamoDBDocumentClient.from(client);

const PUZZLES_TABLE = 'tempo-puzzles';
const BATCH_SIZE = 25; // DynamoDB BatchWrite limit
const DEFAULT_LIMIT = 100_000;

// --- CLI args ---
const args = process.argv.slice(2);
const inputFile = args[args.indexOf('--input') + 1] ?? './lichess_db_puzzle.csv';
const limit = parseInt(args[args.indexOf('--limit') + 1] ?? String(DEFAULT_LIMIT), 10);
const dryRun = args.includes('--dry-run');

interface CsvRow {
  PuzzleId: string;
  FEN: string;
  Moves: string;
  Rating: string;
  RatingDeviation: string;
  Popularity: string;
  NbPlays: string;
  Themes: string;
  GameUrl: string;
  OpeningTags: string;
}

async function main() {
  console.log(`Reading ${inputFile}, target ${limit.toLocaleString()} puzzles…`);

  const rl = readline.createInterface({
    input: fs.createReadStream(inputFile),
    crlfDelay: Infinity,
  });

  let headers: string[] = [];
  let accepted: object[] = [];
  let totalRead = 0;

  // Bucket-level counts so we sample proportionally.
  const bucketCounts: Record<number, number> = {};
  const MAX_PER_BUCKET = Math.ceil(limit / 30); // ~30 rating buckets in 400–3000

  for await (const line of rl) {
    if (!headers.length) {
      headers = line.split(',');
      continue;
    }

    totalRead++;
    const parts = line.split(',');
    const row = Object.fromEntries(headers.map((h, i) => [h, parts[i]])) as unknown as CsvRow;

    const popularity = parseInt(row.Popularity, 10);
    const nbPlays = parseInt(row.NbPlays, 10);
    const rating = parseInt(row.Rating, 10);

    if (popularity < 80 || nbPlays < 500 || isNaN(rating)) continue;

    const bucket = ratingBucket(rating);
    bucketCounts[bucket] = (bucketCounts[bucket] ?? 0) + 1;
    if (bucketCounts[bucket] > MAX_PER_BUCKET) continue;

    accepted.push({
      ratingBucket: bucket,
      randomId: uuidv4(),
      puzzleId: row.PuzzleId,
      fen: row.FEN,
      moves: row.Moves.split(' '),
      rating,
      themes: row.Themes ? row.Themes.split(' ') : [],
    });

    if (accepted.length >= limit) break;
  }

  console.log(`Read ${totalRead.toLocaleString()} rows, accepted ${accepted.length.toLocaleString()} puzzles.`);

  // Write bundled JSON for iOS app.
  const bundledPath = './bundled-puzzles.json';
  fs.writeFileSync(bundledPath, JSON.stringify(accepted));
  console.log(`Wrote ${bundledPath}`);

  if (dryRun) {
    console.log('Dry run — skipping DynamoDB writes.');
    return;
  }

  // Batch-write to DynamoDB.
  let written = 0;
  for (let i = 0; i < accepted.length; i += BATCH_SIZE) {
    const batch = accepted.slice(i, i + BATCH_SIZE);
    await db.send(new BatchWriteCommand({
      RequestItems: {
        [PUZZLES_TABLE]: batch.map(item => ({ PutRequest: { Item: item } })),
      },
    }));
    written += batch.length;
    if (written % 5000 === 0) {
      console.log(`  ${written.toLocaleString()} / ${accepted.length.toLocaleString()} written…`);
    }
  }

  console.log(`Done. ${written.toLocaleString()} puzzles written to ${PUZZLES_TABLE}.`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
