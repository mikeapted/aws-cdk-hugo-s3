import cdk = require('@aws-cdk/cdk');
import cloudfront = require('@aws-cdk/aws-cloudfront');
import codebuild = require('@aws-cdk/aws-codebuild');
import codecommit = require('@aws-cdk/aws-codecommit');
import codepipeline = require('@aws-cdk/aws-codepipeline');
import iam = require('@aws-cdk/aws-iam');
import lambda = require('@aws-cdk/aws-lambda');
import s3 = require('@aws-cdk/aws-s3');

export class HugoAwsCdkStack extends cdk.Stack {
  constructor(scope: cdk.App, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Setup based on envrionment variables

    // Domain name to use for the site
    const domainName = process.env.DOMAIN ? process.env.DOMAIN : 'my.static.site';
    /*
      Until DNS validation is available in CloudFormation, it’s probably better to provision your 
      certificates either in a separate stack from your main service, or provision them manually.
      In both cases, you’ll import the certificate into your stack afterwards.
    */
    const sslCertificateArn = process.env.CERTIFICATE ? process.env.CERTIFICATE : '';
    const hugoVersion = process.env.HUGO_VERSION ? process.env.HUGO_VERSION : '0.54.0';
    const hugoSHA256 = process.env.HUGO_SHA256 ? process.env.HUGO_SHA256 : '76f90287c12a682c9137b85146c406be410b2b30b0df7367f02ee7c4142bb416';

    // Repository for source code

    const repo = new codecommit.Repository(this, 'CodeCommitRepository' ,{
      repositoryName: `${domainName}-hugo`,
      description: 'My static website project'
    });

    // CodeBuild project to import submodules (themes) and generate static site content

    const project = new codebuild.PipelineProject(this, 'CodeBuildProject', {
      buildSpec: {
        version: '0.2',
        env: {
          variables: {
            'HUGO_VERSION': hugoVersion,
            'HUGO_SHA256': hugoSHA256
          }
        },
        phases: {
          install: {
            commands: [
              'curl -Ls https://github.com/gohugoio/hugo/releases/download/v${HUGO_VERSION}/hugo_${HUGO_VERSION}_Linux-64bit.tar.gz -o /tmp/hugo.tar.gz',
              'echo "${HUGO_SHA256}  /tmp/hugo.tar.gz" | sha256sum -c -',
              'mkdir /tmp/hugo_${HUGO_VERSION}',
              'tar xf /tmp/hugo.tar.gz -C /tmp/hugo_${HUGO_VERSION}',
              'mv /tmp/hugo_${HUGO_VERSION}/hugo /usr/bin/hugo',
              'rm -rf /tmp/hugo*',
              'git config --global credential.helper "!aws codecommit credential-helper $@"',
              'git config --global credential.UseHttpPath true',
              'git init',
              `git remote add origin ${repo.repositoryCloneUrlHttp}`,
              'git fetch',
              'git checkout -f -t origin/master',
              'git submodule init',
              'git submodule update --recursive'
            ]
          },
          build: {
            commands: [
              'hugo'
            ],
          }
        },
        artifacts: {
          'files': [
            '**/*'
          ],
          'base-directory': 'public',
          'name': '$(AWS_REGION)-$(date +%Y-%m-%d)' 
        },
      }
    });

    // Permission to access repo

    project.addToRolePolicy(
      new iam.PolicyStatement()
        .addResource(repo.repositoryArn)
        .addAction('codecommit:BatchGet*')
        .addAction('codecommit:Get*')
        .addAction('codecommit:Describe*')
        .addAction('codecommit:List*')
        .addAction('codecommit:GitPull')
    );

    // CloudFront Origin Access Identity

    const cloudFrontOriginAccessIdentity = new cloudfront.CfnCloudFrontOriginAccessIdentity(this, 'CfnCloudFrontOriginAccessIdentityProps', {
      cloudFrontOriginAccessIdentityConfig: {
        comment: 'Restrict access to bucket using Origin Access Identity'
      }
    });

    // Target bucket for static hosting

    const websiteBucket = new s3.Bucket(this, 'WebsiteBucket', {
      websiteIndexDocument: 'index.html'
    });

    websiteBucket.addToResourcePolicy(new iam.PolicyStatement()
      .addPrincipal(new iam.CanonicalUserPrincipal(cloudFrontOriginAccessIdentity.cloudFrontOriginAccessIdentityS3CanonicalUserId))
      .addAction('s3:GetObject')
      .addResource(`${websiteBucket.bucketArn}/*`)
    );

    // Lambda function to preserve clean URLs in Hugo

    const cleanUrlrole = new iam.Role(this, 'LambdaExecutionRole', {
      assumedBy: new iam.CompositePrincipal(
        new iam.ServicePrincipal('lambda.amazonaws.com'),
        new iam.ServicePrincipal('edgelambda.amazonaws.com')
      )
    });
    cleanUrlrole.attachManagedPolicy('arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole');
    
    const cleanUrlFn = new lambda.Function(this, 'CleanUrlFunction', {
      runtime: lambda.Runtime.NodeJS810,
      handler: 'defaultIndex.handler',
      code: lambda.Code.asset('resources'),
      role: cleanUrlrole
    });

    const cleanUrlFnVersion = cleanUrlFn.addVersion('1');

    // CloudFront distribution

    let cloudfrontProps = {
      originConfigs: [
        {
          s3OriginSource: {
            originAccessIdentity: cloudFrontOriginAccessIdentity,
            s3BucketSource: websiteBucket,
          },
          behaviors : [
            { 
              defaultTtlSeconds: 600,
              minTtlSeconds: 600,
              maxTtlSeconds: 600,
              isDefaultBehavior: true
            }
          ]
        }
      ]
    } as cloudfront.CloudFrontWebDistributionProps;

    // If an ACM TLS certificate ARN is provided than use it

    if (sslCertificateArn !== '') {
      cloudfrontProps.aliasConfiguration = {
        acmCertRef: sslCertificateArn,
        names: [
          domainName,
          `www.${domainName}`
        ]
      }
    };

    const cloudFrontDist = new cloudfront.CloudFrontWebDistribution(this, 'CdnDistribution', cloudfrontProps);

    // Get the CloudFront Distribution object to add the LambdaFunctionAssociations
    
    const cloudFrontDistCFN = cloudFrontDist.node.findChild('CFDistribution') as cloudfront.CfnDistribution;

    // Manually add the LambdaFunctionAssociations by adding an override
    
    cloudFrontDistCFN.addOverride('Properties.DistributionConfig.DefaultCacheBehavior.LambdaFunctionAssociations', [
      {
        EventType: 'origin-request',
        LambdaFunctionARN: `${cleanUrlFn.functionArn}:${cleanUrlFnVersion.functionVersion}`
      }
    ]);

    // CodePipeline to wrap it all together

    const pipeline = new codepipeline.Pipeline(this, 'CodePipeline', {
      pipelineName: 'HugoCodePipeline',
    });

    const sourceStage = pipeline.addStage('Source');
    repo.addToPipeline(sourceStage, 'CodeCommit');

    const buildStage = pipeline.addStage('Build');
    const buildAction = project.addToPipeline(buildStage, 'CodeBuild');

    const deployStage = pipeline.addStage('Deploy');
    new s3.PipelineDeployAction(this, 'S3Deploy', {
      stage: deployStage,
      bucket: websiteBucket,
      inputArtifact: buildAction.outputArtifact
    });
  }
}
