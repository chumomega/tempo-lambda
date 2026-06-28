import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNode from 'aws-cdk-lib/aws-lambda-nodejs';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { Construct } from 'constructs';
import * as path from 'path';

export class TempoPuzzleStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ── DynamoDB tables ────────────────────────────────────────────────────

    // All 100k (or 6M) puzzles. PK = ratingBucket (nearest 100), SK = randomId
    // (UUID). Querying by ratingBucket with a random SK start gives pseudo-
    // random selection within a difficulty band — no full-table scan needed.
    const puzzlesTable = new dynamodb.Table(this, 'Puzzles', {
      tableName: 'tempo-puzzles',
      partitionKey: { name: 'ratingBucket', type: dynamodb.AttributeType.NUMBER },
      sortKey: { name: 'randomId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // One row per (user, puzzle) — tracks which puzzles a user has seen.
    // TTL after 90 days so old history doesn't inflate the table forever.
    const userHistoryTable = new dynamodb.Table(this, 'UserHistory', {
      tableName: 'tempo-user-history',
      partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'puzzleId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // One row per user — rating, streak, daily count.
    const userStatsTable = new dynamodb.Table(this, 'UserStats', {
      tableName: 'tempo-user-stats',
      partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // Today's puzzle of the day, cached from Lichess. TTL after 2 days.
    const potdCacheTable = new dynamodb.Table(this, 'PotdCache', {
      tableName: 'tempo-potd-cache',
      partitionKey: { name: 'date', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      removalPolicy: cdk.RemovalPolicy.DESTROY, // cache, safe to drop
    });

    // Short-lived App Attest challenges. TTL after 5 minutes.
    // Safe to drop — a lost challenge just means the device retries.
    const attestChallengesTable = new dynamodb.Table(this, 'AttestChallenges', {
      tableName: 'tempo-attest-challenges',
      partitionKey: { name: 'challenge', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Registered App Attest public keys. One row per device key.
    // RETAIN so we don't lock out devices on a stack re-deploy.
    const attestKeysTable = new dynamodb.Table(this, 'AttestKeys', {
      tableName: 'tempo-attest-keys',
      partitionKey: { name: 'keyId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ── Shared Lambda config ───────────────────────────────────────────────

    const sharedFnProps: Omit<lambdaNode.NodejsFunctionProps, 'entry'> = {
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.seconds(10),
      memorySize: 256,
      bundling: {
        minify: true,
        sourceMap: false,
        externalModules: [],
        forceDockerBundling: false, // use local esbuild, not Docker
      },
    };

    function fn(scope: Construct, id: string, entry: string, env: Record<string, string>) {
      return new lambdaNode.NodejsFunction(scope, id, {
        ...sharedFnProps,
        entry: path.join(__dirname, '..', entry),
        environment: env,
      });
    }

    // ── Lambda functions ───────────────────────────────────────────────────

    const getPuzzleOfDay = fn(this, 'GetPuzzleOfDay',
      'functions/get-puzzle-of-day/index.ts',
      { POTD_TABLE: potdCacheTable.tableName },
    );
    potdCacheTable.grantReadWriteData(getPuzzleOfDay);
    // Note: get-puzzle-of-day has no userId so attestation is skipped there.

    const getNextPuzzle = fn(this, 'GetNextPuzzle',
      'functions/get-next-puzzle/index.ts',
      {
        PUZZLES_TABLE: puzzlesTable.tableName,
        USER_STATS_TABLE: userStatsTable.tableName,
        USER_HISTORY_TABLE: userHistoryTable.tableName,
        ATTEST_KEYS_TABLE: attestKeysTable.tableName,
        APPLE_APP_ID: '9PY7TZK328.com.tempo.apps',
      },
    );
    puzzlesTable.grantReadData(getNextPuzzle);
    userStatsTable.grantReadData(getNextPuzzle);
    userHistoryTable.grantReadData(getNextPuzzle);
    attestKeysTable.grantReadWriteData(getNextPuzzle);

    const recordSolve = fn(this, 'RecordSolve',
      'functions/record-solve/index.ts',
      {
        USER_STATS_TABLE: userStatsTable.tableName,
        USER_HISTORY_TABLE: userHistoryTable.tableName,
        ATTEST_KEYS_TABLE: attestKeysTable.tableName,
        APPLE_APP_ID: '9PY7TZK328.com.tempo.apps',
      },
    );
    userStatsTable.grantReadWriteData(recordSolve);
    userHistoryTable.grantReadWriteData(recordSolve);
    attestKeysTable.grantReadWriteData(recordSolve);

    const getUserStats = fn(this, 'GetUserStats',
      'functions/get-user-stats/index.ts',
      {
        USER_STATS_TABLE: userStatsTable.tableName,
        ATTEST_KEYS_TABLE: attestKeysTable.tableName,
        APPLE_APP_ID: '9PY7TZK328.com.tempo.apps',
      },
    );
    userStatsTable.grantReadData(getUserStats);
    attestKeysTable.grantReadWriteData(getUserStats);

    // ── App Attest: challenge + registration ──────────────────────────────

    const attestChallengeFn = fn(this, 'GetAttestChallenge',
      'functions/attest-challenge/index.ts',
      { ATTEST_CHALLENGES_TABLE: attestChallengesTable.tableName },
    );
    attestChallengesTable.grantReadWriteData(attestChallengeFn);

    const attestRegisterFn = fn(this, 'AttestRegister',
      'functions/attest-register/index.ts',
      {
        ATTEST_CHALLENGES_TABLE: attestChallengesTable.tableName,
        ATTEST_KEYS_TABLE: attestKeysTable.tableName,
        APPLE_APP_ID: '9PY7TZK328.com.tempo.apps',
      },
    );
    attestChallengesTable.grantReadWriteData(attestRegisterFn);
    attestKeysTable.grantReadWriteData(attestRegisterFn);

    // ── HTTP API (API Gateway v2) ──────────────────────────────────────────

    const api = new apigwv2.HttpApi(this, 'TempoPuzzleApi', {
      apiName: 'tempo-puzzle-api',
      corsPreflight: {
        allowOrigins: ['*'],
        allowMethods: [apigwv2.CorsHttpMethod.GET, apigwv2.CorsHttpMethod.POST],
        allowHeaders: ['Content-Type', 'X-App-Attest-Key-Id', 'X-App-Attest-Assertion'],
      },
    });

    const integrate = (fn: lambda.IFunction) =>
      new integrations.HttpLambdaIntegration(`${fn.node.id}Integration`, fn);

    api.addRoutes({ path: '/puzzle/daily',          methods: [apigwv2.HttpMethod.GET],  integration: integrate(getPuzzleOfDay) });
    api.addRoutes({ path: '/puzzle/next',           methods: [apigwv2.HttpMethod.GET],  integration: integrate(getNextPuzzle) });
    api.addRoutes({ path: '/puzzle/solve',          methods: [apigwv2.HttpMethod.POST], integration: integrate(recordSolve) });
    api.addRoutes({ path: '/user/{userId}/stats',   methods: [apigwv2.HttpMethod.GET],  integration: integrate(getUserStats) });
    api.addRoutes({ path: '/attest/challenge',      methods: [apigwv2.HttpMethod.GET],  integration: integrate(attestChallengeFn) });
    api.addRoutes({ path: '/attest/register',       methods: [apigwv2.HttpMethod.POST], integration: integrate(attestRegisterFn) });

    // ── Outputs ────────────────────────────────────────────────────────────

    new cdk.CfnOutput(this, 'ApiUrl', {
      value: api.apiEndpoint,
      description: 'Base URL for the Tempo Puzzle API',
    });
  }
}
