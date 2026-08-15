import { matches, flag, intFlag, lookupRate, estimate } from './helpers.js';
import { EC2, RDS, ELASTICACHE, REDSHIFT, SAGEMAKER, FIXED } from './prices.js';

export const awsRules = [
  {
    id: 'aws.ec2.run-instances',
    test: (argv) => matches(argv, ['aws', 'ec2', 'run-instances']),
    build: (argv) => {
      const type = flag(argv, '--instance-type');
      const count = intFlag(argv, ['--count'], 1);
      const { hourly, confidence } = lookupRate(EC2, type);
      return estimate({
        ruleId: 'aws.ec2.run-instances',
        provider: 'aws',
        label: `EC2 ${type || 'instance (type unspecified)'} x${count}`,
        risk: 'high',
        hourly,
        qty: count,
        confidence,
        note: confidence === 'low'
          ? `Unrecognised instance type "${type || 'none'}" — priced pessimistically.`
          : '',
      });
    },
  },
  {
    id: 'aws.ec2.create-fleet',
    test: (argv) => matches(argv, ['aws', 'ec2', 'create-fleet'])
      || matches(argv, ['aws', 'ec2', 'request-spot-fleet']),
    build: () => estimate({
      ruleId: 'aws.ec2.create-fleet',
      provider: 'aws',
      label: 'EC2 fleet request',
      risk: 'high',
      hourly: 2.0,
      confidence: 'low',
      unknownBlastRadius: true,
      note: 'Fleet size and instance mix come from a launch template we cannot read.',
    }),
  },
  {
    id: 'aws.cloudformation.deploy',
    test: (argv) => matches(argv, ['aws', 'cloudformation', 'create-stack'])
      || matches(argv, ['aws', 'cloudformation', 'deploy'])
      || matches(argv, ['aws', 'cloudformation', 'update-stack'])
      || matches(argv, ['aws', 'cloudformation', 'create-stack-set']),
    build: (argv) => estimate({
      ruleId: 'aws.cloudformation.deploy',
      provider: 'aws',
      label: `CloudFormation ${flag(argv, '--stack-name') || 'stack'}`,
      risk: 'high',
      confidence: 'low',
      unknownBlastRadius: true,
      note: 'A stack can provision any amount of billable infrastructure. Cost is unbounded from the command line alone.',
    }),
  },
  {
    id: 'aws.rds.create',
    test: (argv) => matches(argv, ['aws', 'rds', 'create-db-instance'])
      || matches(argv, ['aws', 'rds', 'create-db-cluster'])
      || matches(argv, ['aws', 'rds', 'restore-db-instance-from-db-snapshot']),
    build: (argv) => {
      const cls = flag(argv, '--db-instance-class');
      const { hourly, confidence } = lookupRate(RDS, cls, { cpuDefault: 0.25 });
      return estimate({
        ruleId: 'aws.rds.create',
        provider: 'aws',
        label: `RDS ${cls || 'instance'}`,
        risk: 'high',
        hourly,
        confidence,
      });
    },
  },
  {
    id: 'aws.eks.create-cluster',
    test: (argv) => matches(argv, ['aws', 'eks', 'create-cluster']),
    build: () => estimate({
      ruleId: 'aws.eks.create-cluster',
      provider: 'aws',
      label: 'EKS cluster control plane',
      risk: 'high',
      hourly: FIXED['aws.eks.cluster'],
      confidence: 'high',
      note: 'Control plane only. Node groups are billed separately.',
    }),
  },
  {
    id: 'aws.eks.create-nodegroup',
    test: (argv) => matches(argv, ['aws', 'eks', 'create-nodegroup']),
    build: (argv) => {
      const types = flag(argv, '--instance-types');
      const first = typeof types === 'string' ? types.split(',')[0] : undefined;
      const { hourly, confidence } = lookupRate(EC2, first);
      const desired = Number(flag(argv, '--scaling-config')) || 2;
      return estimate({
        ruleId: 'aws.eks.create-nodegroup',
        provider: 'aws',
        label: `EKS node group (${first || 'unknown type'})`,
        risk: 'high',
        hourly,
        qty: Number.isFinite(desired) ? desired : 2,
        confidence,
        note: 'Node count read from --scaling-config when parseable, otherwise assumed 2.',
      });
    },
  },
  {
    id: 'aws.sagemaker.create',
    test: (argv) => matches(argv, ['aws', 'sagemaker', 'create-training-job'])
      || matches(argv, ['aws', 'sagemaker', 'create-endpoint'])
      || matches(argv, ['aws', 'sagemaker', 'create-notebook-instance'])
      || matches(argv, ['aws', 'sagemaker', 'create-processing-job']),
    build: (argv) => {
      const type = flag(argv, '--instance-type');
      const { hourly, confidence } = lookupRate(SAGEMAKER, type, { cpuDefault: 1.0, gpuDefault: 4.0 });
      return estimate({
        ruleId: 'aws.sagemaker.create',
        provider: 'aws',
        label: `SageMaker ${type || 'resource'}`,
        risk: 'high',
        hourly,
        confidence,
      });
    },
  },
  {
    id: 'aws.redshift.create-cluster',
    test: (argv) => matches(argv, ['aws', 'redshift', 'create-cluster']),
    build: (argv) => {
      const type = flag(argv, '--node-type');
      const nodes = intFlag(argv, ['--number-of-nodes'], 1);
      const { hourly, confidence } = lookupRate(REDSHIFT, type, { cpuDefault: 1.0 });
      return estimate({
        ruleId: 'aws.redshift.create-cluster',
        provider: 'aws',
        label: `Redshift ${type || 'cluster'} x${nodes}`,
        risk: 'high',
        hourly,
        qty: nodes,
        confidence,
      });
    },
  },
  {
    id: 'aws.elasticache.create',
    test: (argv) => matches(argv, ['aws', 'elasticache', 'create-cache-cluster'])
      || matches(argv, ['aws', 'elasticache', 'create-replication-group']),
    build: (argv) => {
      const type = flag(argv, '--cache-node-type');
      const nodes = intFlag(argv, ['--num-cache-nodes'], 1);
      const { hourly, confidence } = lookupRate(ELASTICACHE, type, { cpuDefault: 0.15 });
      return estimate({
        ruleId: 'aws.elasticache.create',
        provider: 'aws',
        label: `ElastiCache ${type || 'node'} x${nodes}`,
        risk: 'medium',
        hourly,
        qty: nodes,
        confidence,
      });
    },
  },
  {
    id: 'aws.nat-gateway',
    test: (argv) => matches(argv, ['aws', 'ec2', 'create-nat-gateway']),
    build: () => estimate({
      ruleId: 'aws.nat-gateway',
      provider: 'aws',
      label: 'NAT gateway',
      risk: 'medium',
      hourly: FIXED['aws.nat-gateway'],
      confidence: 'high',
      note: 'Plus per-GB data processing, not included.',
    }),
  },
  {
    id: 'aws.elbv2.create',
    test: (argv) => matches(argv, ['aws', 'elbv2', 'create-load-balancer'])
      || matches(argv, ['aws', 'elb', 'create-load-balancer']),
    build: () => estimate({
      ruleId: 'aws.elbv2.create',
      provider: 'aws',
      label: 'Application load balancer',
      risk: 'low',
      hourly: FIXED['aws.alb'],
      confidence: 'high',
    }),
  },
  {
    id: 'aws.msk.create-cluster',
    test: (argv) => matches(argv, ['aws', 'kafka', 'create-cluster']),
    build: () => estimate({
      ruleId: 'aws.msk.create-cluster',
      provider: 'aws',
      label: 'MSK Kafka cluster',
      risk: 'high',
      hourly: FIXED['aws.msk.broker'] * 3,
      confidence: 'low',
      note: 'Assumes a 3-broker cluster.',
    }),
  },
  {
    id: 'aws.opensearch.create-domain',
    test: (argv) => matches(argv, ['aws', 'opensearch', 'create-domain'])
      || matches(argv, ['aws', 'es', 'create-elasticsearch-domain']),
    build: () => estimate({
      ruleId: 'aws.opensearch.create-domain',
      provider: 'aws',
      label: 'OpenSearch domain',
      risk: 'high',
      hourly: FIXED['aws.opensearch.node'] * 3,
      confidence: 'low',
      note: 'Assumes a 3-node domain.',
    }),
  },
  {
    id: 'aws.transit-gateway',
    test: (argv) => matches(argv, ['aws', 'ec2', 'create-transit-gateway']),
    build: () => estimate({
      ruleId: 'aws.transit-gateway',
      provider: 'aws',
      label: 'Transit gateway',
      risk: 'medium',
      hourly: FIXED['aws.transit-gateway'],
      confidence: 'high',
    }),
  },
  {
    id: 'aws.autoscaling.create',
    test: (argv) => matches(argv, ['aws', 'autoscaling', 'create-auto-scaling-group'])
      || matches(argv, ['aws', 'autoscaling', 'set-desired-capacity'])
      || matches(argv, ['aws', 'autoscaling', 'update-auto-scaling-group']),
    build: (argv) => {
      const desired = intFlag(argv, ['--desired-capacity', '--max-size'], 2);
      return estimate({
        ruleId: 'aws.autoscaling.create',
        provider: 'aws',
        label: `Auto Scaling group (capacity ${desired})`,
        risk: 'high',
        hourly: 0.2,
        qty: desired,
        confidence: 'low',
        note: 'Per-instance price unknown without the launch template.',
      });
    },
  },
  {
    id: 'aws.lightsail.create',
    test: (argv) => matches(argv, ['aws', 'lightsail', 'create-instances']),
    build: () => estimate({
      ruleId: 'aws.lightsail.create',
      provider: 'aws',
      label: 'Lightsail instance',
      risk: 'low',
      hourly: 0.0075,
      confidence: 'low',
    }),
  },
  {
    id: 'aws.s3.transfer',
    test: (argv) => matches(argv, ['aws', 's3', 'sync']) || matches(argv, ['aws', 's3', 'cp']),
    build: () => estimate({
      ruleId: 'aws.s3.transfer',
      provider: 'aws',
      label: 'S3 bulk transfer',
      risk: 'low',
      oneTime: 0.10,
      confidence: 'low',
      note: 'Egress is priced per GB and the transfer size is not knowable up front.',
    }),
  },
  {
    // Not a spend rule. Account-level surface an agent should never touch alone.
    id: 'aws.account.privileged',
    test: (argv) => matches(argv, ['aws', 'organizations'])
      || matches(argv, ['aws', 'iam', 'create-user'])
      || matches(argv, ['aws', 'iam', 'create-access-key'])
      || matches(argv, ['aws', 'iam', 'attach-user-policy'])
      || matches(argv, ['aws', 'iam', 'put-user-policy']),
    build: () => estimate({
      ruleId: 'aws.account.privileged',
      provider: 'aws',
      label: 'Privileged IAM / Organizations call',
      risk: 'high',
      confidence: 'high',
      unknownBlastRadius: true,
      note: 'Identity and account structure changes are not reversible by a retry.',
    }),
  },
];
