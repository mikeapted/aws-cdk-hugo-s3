#!/usr/bin/env node
import cdk = require('@aws-cdk/cdk');
import { HugoAwsCdkStack } from '../lib/hugo-aws-cdk-stack';

const app = new cdk.App();
new HugoAwsCdkStack(app, 'HugoAwsCdkStack', {
  env: {
    region: 'us-east-1'
  }
});
app.run();
