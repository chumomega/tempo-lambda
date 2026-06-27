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

    // ── Shared Lambda config ───────────────────────────────────────────────

    const sharedFnProps: Omit<lambdaNode.NodejsFunctionProps, 'entry'> = {
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.seconds(10),
      memorySize: 256,
      bundling: {
        minify: true,
        sourceMap: false,
        externalModules: [], // bundle everything including aws-sdk v3
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

    const getNextPuzzle = fn(this, 'GetNextPuzzle',
      'functions/get-next-puzzle/index.ts',
      {
        PUZZLES_TABLE: puzzlesTable.tableName,
        USER_STATS_TABLE: userStatsTable.tableName,
        USER_HISTORY_TABLE: userHistoryTable.tableName,
      },
    );
    puzzlesTable.grantReadData(getNextPuzzle);
    userStatsTable.grantReadData(getNextPuzzle);
    userHistoryTable.grantReadData(getNextPuzzle);

    const recordSolve = fn(this, 'RecordSolve',
      'functions/record-solve/index.ts',
      {
        USER_STATS_TABLE: userStatsTable.tableName,
        USER_HISTORY_TABLE: userHistoryTable.tableName,
      },
    );
    userStatsTable.grantReadWriteData(recordSolve);
    userHistoryTable.grantReadWriteData(recordSolve);

    const getUserStats = fn(this, 'GetUserStats',
      'functions/get-user-stats/index.ts',
      { USER_STATS_TABLE: userStatsTable.tableName },
    );
    userStatsTable.grantReadData(getUserStats);

    // ── HTTP API (API Gateway v2) ──────────────────────────────────────────

    const api = new apigwv2.HttpApi(this, 'TempoPuzzleApi', {
      apiName: 'tempo-puzzle-api',
      corsPreflight: {
        allowOrigins: ['*'],
        allowMethods: [apigwv2.CorsHttpMethod.GET, apigwv2.CorsHttpMethod.POST],
        allowHeaders: ['Content-Type'],
      },
    });

    const integrate = (fn: lambda.IFunction) =>
      new integrations.HttpLambdaIntegration(`${fn.node.id}Integration`, fn);

    api.addRoutes({ path: '/puzzle/daily',          methods: [apigwv2.HttpMethod.GET],  integration: integrate(getPuzzleOfDay) });
    api.addRoutes({ path: '/puzzle/next',           methods: [apigwv2.HttpMethod.GET],  integration: integrate(getNextPuzzle) });
    api.addRoutes({ path: '/puzzle/solve',          methods: [apigwv2.HttpMethod.POST], integration: integrate(recordSolve) });
    api.addRoutes({ path: '/user/{userId}/stats',   methods: [apigwv2.HttpMethod.GET],  integration: integrate(getUserStats) });

    // ── Outputs ────────────────────────────────────────────────────────────

    new cdk.CfnOutput(this, 'ApiUrl', {
      value: api.apiEndpoint,
      description: 'Base URL for the Tempo Puzzle API',
    });
  }
}
