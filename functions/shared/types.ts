export interface Puzzle {
  puzzleId: string;
  fen: string;          // position BEFORE the hook move
  moves: string[];      // UCI: moves[0] = opponent hook, moves[1..] = solution
  rating: number;
  ratingBucket: number; // nearest 100, used as DynamoDB PK
  themes: string[];
  randomId: string;     // UUID — sort key for pseudo-random selection
}

export interface UserStats {
  userId: string;
  rating: number;
  streak: number;
  bestStreak: number;
  totalSolved: number;
  totalFailed: number;
  dailyCount: number;
  lastPlayDate: string; // YYYY-MM-DD UTC
}

export interface PotdCacheItem {
  date: string;         // YYYY-MM-DD UTC — partition key
  puzzle: Puzzle;
  ttl: number;          // unix seconds, 2-day expiry
}

// Elo: K=32, bounded 400–3000.
export function computeNewRating(
  userRating: number,
  puzzleRating: number,
  solved: boolean,
): number {
  const expected = 1 / (1 + Math.pow(10, (puzzleRating - userRating) / 400));
  const actual = solved ? 1 : 0;
  const updated = Math.round(userRating + 32 * (actual - expected));
  return Math.max(400, Math.min(3000, updated));
}

export function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

export function ratingBucket(rating: number): number {
  return Math.round(rating / 100) * 100;
}
