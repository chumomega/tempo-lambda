#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { TempoPuzzleStack } from '../lib/tempo-puzzle-stack';

const app = new cdk.App();

new TempoPuzzleStack(app, 'TempoPuzzleStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
});
