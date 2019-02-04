import cdk = require('@aws-cdk/cdk');
import codebuild = require('@aws-cdk/aws-codebuild');
import codecommit = require('@aws-cdk/aws-codecommit');
import codepipeline = require('@aws-cdk/aws-codepipeline');
import iam = require('@aws-cdk/aws-iam');
import s3 = require('@aws-cdk/aws-s3');

export class HugoAwsCdkStack extends cdk.Stack {
  constructor(scope: cdk.App, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // The code that defines your stack goes here

    const repo = new codecommit.Repository(this, 'CodeCommitRepository' ,{
      repositoryName: 'mikeapted.com-hugo',
      description: 'My personal website'
    });

    const websiteBucket = new s3.Bucket(this, 'WebsiteBucket', {
      websiteIndexDocument: 'index.html'
    });
    websiteBucket.grantPublicAccess();

    const project = new codebuild.PipelineProject(this, 'CodeBuildProject', {
      buildSpec: {
        version: '0.2',
        env: {
          variables: {
            'HUGO_VERSION': '0.54.0',
            'HUGO_SHA256': '76f90287c12a682c9137b85146c406be410b2b30b0df7367f02ee7c4142bb416'
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
              'git remote add origin https://git-codecommit.us-east-1.amazonaws.com/v1/repos/mikeapted.com-hugo',
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
          },
          post_build: {
            commands: [
              `aws s3 sync --acl "public-read" public/ s3://${websiteBucket.bucketName}`
            ],
          }
        },
        artifacts: {
          'files': [
            'public/**/*'
          ],
          'name': '$(AWS_REGION)-$(date +%Y-%m-%d)' 
        },
      }
    });

    project.addToRolePolicy(
      new iam.PolicyStatement()
        .addResource(repo.repositoryArn)
        .addAction('codecommit:BatchGet*')
        .addAction('codecommit:Get*')
        .addAction('codecommit:Describe*')
        .addAction('codecommit:List*')
        .addAction('codecommit:GitPull')
    );

    project.addToRolePolicy(
      new iam.PolicyStatement()
        .addResource(`${websiteBucket.bucketArn}`)
        .addResource(`${websiteBucket.bucketArn}/*`)
        .addAction('s3:PutObject*')
        .addAction('s3:DeleteObject')
        .addAction('s3:List*')
    );

    const pipeline = new codepipeline.Pipeline(this, 'CodePipeline', {
      pipelineName: 'HugoCodePipeline',
    });

    const sourceStage = pipeline.addStage('Source');
    repo.addToPipeline(sourceStage, 'CodeCommit');

    const buildStage = pipeline.addStage('Build');
    project.addToPipeline(buildStage, 'CodeBuild');

    // pipeline.addStage('Deploy');
  }
}
