<img src="https://tempo64.com/icon.png" width="80" alt="Tempo64">

# tempo-lambda

AWS CDK backend for [Tempo64](https://tempo64.com) — the chess highlight video creator for iOS. Powers the **puzzle mode**: daily puzzles, adaptive difficulty selection, Elo-based user stats, and 90-day history so users never repeat a puzzle. Video export, board rendering, and audio are fully on-device; this service handles only the puzzle infrastructure.

[App Store](https://apps.apple.com/us/app/tempo64/id6764440731) · [tempo64.com](https://tempo64.com)

## Architecture

```
iOS app
  │
  └── API Gateway (HTTP API v2)
        ├── GET  /puzzle/daily          → get-puzzle-of-day   (Lichess POTD, cached 2 days)
        ├── GET  /puzzle/next?userId=   → get-next-puzzle      (adaptive by Elo rating)
        ├── POST /puzzle/solve          → record-solve         (Elo update + streak)
        └── GET  /user/{userId}/stats   → get-user-stats
```

### DynamoDB tables

| Table | PK | SK | Notes |
|---|---|---|---|
| `tempo-puzzles` | `ratingBucket` (NUMBER, nearest 100) | `randomId` (STRING, UUID) | All puzzles. Random SK as ExclusiveStartKey gives O(log n) pseudo-random selection per bucket. |
| `tempo-user-stats` | `userId` (STRING) | — | One row per user: `rating` (Elo, starts 1500), `streak`, `bestStreak`, `totalSolved`, `totalFailed`, `dailyCount`, `lastPlayDate`. |
| `tempo-user-history` | `userId` (STRING) | `puzzleId` (STRING) | Per-attempt history. 90-day TTL so seen puzzles age out automatically. |
| `tempo-potd-cache` | `date` (STRING) | — | Caches the Lichess puzzle of the day. 2-day TTL so Lichess isn't hit on every request. |

All tables use `PAY_PER_REQUEST` billing.

### API endpoints

**`GET /puzzle/daily`**
Returns today's puzzle sourced from the Lichess puzzle-of-the-day API. The result is cached in `tempo-potd-cache` keyed by date; subsequent requests on the same day return the cached entry.

**`GET /puzzle/next?userId={userId}`**
Returns the next puzzle matched to the user's current Elo rating.

1. Fetch user's rating from `tempo-user-stats` (default 1500 for new users).
2. Round to nearest 100 to get `ratingBucket`.
3. Query `tempo-puzzles` using a random UUID as `ExclusiveStartKey` — pseudo-random O(log n) selection within the bucket.
4. If the bucket has fewer than 3 unseen puzzles, expand to ±100, then ±200.
5. Filter out puzzles present in the user's `tempo-user-history` within the last 90 days.

**`POST /puzzle/solve`**
Records a solve or fail. Request body:
```json
{ "userId": "...", "puzzleId": "...", "puzzleRating": 1600, "solved": true }
```
Updates the user's Elo (K=32), streak, `bestStreak`, `dailyCount`, and `lastPlayDate`. Returns the updated `UserStats` object.

**`GET /user/{userId}/stats`**
Returns the user's current stats. New users receive 1500 rating and zero counts — no 404.

### Elo formula

K=32, bounded 400–3000:

```
expected  = 1 / (1 + 10^((puzzleRating - userRating) / 400))
newRating = userRating + 32 * (actual - expected)   // actual: 1=solve, 0=fail
```

### Live API

```
https://wkl9yj0pk8.execute-api.us-east-1.amazonaws.com
```

## userId convention and authentication

The iOS client sends `"G:" + GKLocalPlayer.gamePlayerID` when Game Center is authenticated, otherwise a stable UUID persisted in `UserDefaults`. There is no server-side authentication on the API — `userId` is trust-based. This is intentional for now; the stat data is low-sensitivity (puzzle ratings, streaks) and avoids requiring users to create an account.

## Prerequisites

- Node 18+
- AWS CLI configured (`aws configure`) with an IAM user that has CloudFormation, Lambda, DynamoDB, and API Gateway permissions
- CDK CLI: `npm install -g aws-cdk`
- esbuild: installed automatically via `npm install`

## Deploy

```bash
npm install

# First time only — bootstraps CDK in your AWS account/region
cdk bootstrap

cdk deploy
```

## Puzzle import

Download the [Lichess puzzle database](https://database.lichess.org/#puzzles) (`.csv.zst`), then:

```bash
# Decompress (requires zstd)
zstd -d lichess_db_puzzle.csv.zst

# Import a high-quality subset (also writes bundled-puzzles.json for the iOS app bundle)
npm run import -- --count 100000

# Import the full ~6M puzzle database (skip rewriting bundled JSON)
npm run import -- --count 6000000 --skip-json
```

The script proportionally samples across ~30 rating buckets (300–2900) so no difficulty tier is over-represented. It filters by popularity and play count before sampling. Writes are batched in groups of 25 with 20 concurrent writers; it flushes every 5000 items.

### Import flags

| Flag | Default | Description |
|---|---|---|
| `--count N` | `100000` | Maximum number of puzzles to import |
| `--min-popularity N` | `80` | Minimum Lichess popularity score |
| `--min-plays N` | `500` | Minimum number of times played on Lichess |
| `--skip-json` | off | Skip writing `bundled-puzzles.json` |

## Local development

```bash
# Type-check and compile
npm run build

# Test the import script without writing to DynamoDB
npm run import -- --count 1000 --skip-json
```

Lambda functions are bundled with esbuild (runs locally — no Docker required).
