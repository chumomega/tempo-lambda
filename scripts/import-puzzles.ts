/**
 * One-shot script: reads the Lichess puzzle CSV and writes a filtered
 * subset to DynamoDB + a local JSON for the iOS bundle.
 *
 * Usage:
 *   npm run import-puzzles -- --input ./lichess_db_puzzle.csv --limit 100000
 *   npm run import-puzzles -- --input ./lichess_db_puzzle.csv --limit 6000000 --min-popularity 0 --min-plays 0 --skip-json
 *
 * Filters (all configurable via flags):
 *   --min-popularity  (default 80)
 *   --min-plays       (default 500)
 *   --limit           (default 100000)
 *   --skip-json       skip writing bundled-puzzles.json
 *   --dry-run         skip all writes
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
const BATCH_SIZE = 25;
const CONCURRENCY = 20; // parallel batch writes
const DEFAULT_LIMIT = 100_000;

const args = process.argv.slice(2);
const arg = (flag: string) => args[args.indexOf(flag) + 1];
const inputFile    = arg('--input')          ?? './lichess_db_puzzle.csv';
const limit        = parseInt(arg('--limit') ?? String(DEFAULT_LIMIT), 10);
const minPop       = parseInt(arg('--min-popularity') ?? '80', 10);
const minPlays     = parseInt(arg('--min-plays')      ?? '500', 10);
const dryRun       = args.includes('--dry-run');
const skipJson     = args.includes('--skip-json');

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

async function writeBatches(items: object[]) {
  // Fan out CONCURRENCY parallel batch writes
  const queue = [];
  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    queue.push(items.slice(i, i + BATCH_SIZE));
  }
  let written = 0;
  for (let i = 0; i < queue.length; i += CONCURRENCY) {
    const chunk = queue.slice(i, i + CONCURRENCY);
    await Promise.all(chunk.map(batch =>
      db.send(new BatchWriteCommand({
        RequestItems: {
          [PUZZLES_TABLE]: batch.map(item => ({ PutRequest: { Item: item } })),
        },
      }))
    ));
    written += chunk.reduce((s, b) => s + b.length, 0);
  }
  return written;
}

async function main() {
  console.log(`Reading ${inputFile}, target ${limit.toLocaleString()} puzzles…`);
  console.log(`Filters: min-popularity=${minPop}, min-plays=${minPlays}`);

  const rl = readline.createInterface({
    input: fs.createReadStream(inputFile),
    crlfDelay: Infinity,
  });

  let headers: string[] = [];
  let accepted: object[] = [];
  let totalRead = 0;
  let totalWritten = 0;

  const bucketCounts: Record<number, number> = {};
  const MAX_PER_BUCKET = Math.ceil(limit / 30);

  // Flush buffer once it hits FLUSH_SIZE so we don't hold 6M items in RAM
  const FLUSH_SIZE = 5000;

  for await (const line of rl) {
    if (!headers.length) {
      headers = line.split(',');
      continue;
    }

    totalRead++;
    const parts = line.split(',');
    const row = Object.fromEntries(headers.map((h, i) => [h, parts[i]])) as unknown as CsvRow;

    const popularity = parseInt(row.Popularity, 10);
    const nbPlays    = parseInt(row.NbPlays, 10);
    const rating     = parseInt(row.Rating, 10);

    if (popularity < minPop || nbPlays < minPlays || isNaN(rating)) continue;

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

    // Flush periodically to keep RAM low
    if (!dryRun && accepted.length >= FLUSH_SIZE) {
      if (!skipJson) {
        // JSON only for first flush (bundled set is small)
      }
      const w = await writeBatches(accepted);
      totalWritten += w;
      console.log(`  ${totalWritten.toLocaleString()} written (read ${totalRead.toLocaleString()} rows)…`);
      accepted = [];
    }
  }

  console.log(`Read ${totalRead.toLocaleString()} rows, accepted ${(totalWritten + accepted.length).toLocaleString()} puzzles.`);

  if (!skipJson) {
    const bundledPath = './bundled-puzzles.json';
    fs.writeFileSync(bundledPath, JSON.stringify(accepted));
    console.log(`Wrote ${bundledPath}`);
  }

  if (dryRun) {
    console.log('Dry run — skipping DynamoDB writes.');
    return;
  }

  if (accepted.length > 0) {
    const w = await writeBatches(accepted);
    totalWritten += w;
  }

  console.log(`Done. ${totalWritten.toLocaleString()} puzzles written to ${PUZZLES_TABLE}.`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
