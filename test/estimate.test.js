import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateCommand } from '../src/estimate.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { matches, flag } from '../src/catalog/helpers.js';

const config = { ...DEFAULT_CONFIG };

test('matches a subcommand past global flags', () => {
  const argv = ['aws', '--region', 'us-east-1', '--profile', 'prod', 'ec2', 'run-instances'];
  assert.equal(matches(argv, ['aws', 'ec2', 'run-instances']), true);
});

test('does not match a different subcommand', () => {
  assert.equal(matches(['aws', 'ec2', 'describe-instances'], ['aws', 'ec2', 'run-instances']), false);
  assert.equal(matches(['aws', 's3', 'ls'], ['aws', 'ec2', 'run-instances']), false);
});

test('reads flags in both --k v and --k=v form', () => {
  assert.equal(flag(['aws', '--instance-type', 'm5.large'], '--instance-type'), 'm5.large');
  assert.equal(flag(['aws', '--instance-type=m5.large'], '--instance-type'), 'm5.large');
});

test('prices a known EC2 instance over the horizon', () => {
  const r = estimateCommand('aws ec2 run-instances --instance-type m5.large', config);
  // 0.096/hr * 24h = 2.304 -> 2.3
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].confidence, 'high');
  assert.ok(r.total > 2.2 && r.total < 2.4, `expected ~2.30, got ${r.total}`);
});

test('multiplies by --count', () => {
  const one = estimateCommand('aws ec2 run-instances --instance-type m5.large', config).total;
  const ten = estimateCommand('aws ec2 run-instances --instance-type m5.large --count 10', config).total;
  assert.ok(Math.abs(ten - one * 10) < 0.05, `expected 10x, got ${one} -> ${ten}`);
});

test('prices GPU instances high enough to matter', () => {
  const r = estimateCommand('aws ec2 run-instances --instance-type p4d.24xlarge --count 8', config);
  // 32.77/hr * 24h * 8 -> well over $6,000
  assert.ok(r.total > 6000, `expected > 6000, got ${r.total}`);
});

test('guesses pessimistically for unknown instance types', () => {
  const r = estimateCommand('aws ec2 run-instances --instance-type zz9.plural-z-alpha', config);
  assert.equal(r.findings[0].confidence, 'low');
  assert.ok(r.total > 0, 'an unknown type must still cost something');
});

test('treats an unknown GPU family as expensive', () => {
  const gpu = estimateCommand('aws ec2 run-instances --instance-type p9.128xlarge', config).total;
  const cpu = estimateCommand('aws ec2 run-instances --instance-type zz9.large', config).total;
  assert.ok(gpu > cpu, `GPU fallback (${gpu}) should exceed CPU fallback (${cpu})`);
});

test('multiplies by a bounded loop', () => {
  const r = estimateCommand(
    'for i in {1..50}; do aws ec2 run-instances --instance-type t3.micro; done',
    config,
  );
  assert.equal(r.findings[0].iterations, 50);
  assert.equal(r.unbounded, false);
});

test('flags an unbounded loop and still assigns a cost', () => {
  const r = estimateCommand(
    'while true; do aws ec2 run-instances --instance-type m5.large; done',
    config,
  );
  assert.equal(r.unbounded, true);
  assert.equal(r.findings[0].iterations, config.unboundedLoopAssumption);
  assert.ok(r.total > 0);
});

test('marks IaC applies as unknown blast radius rather than guessing', () => {
  const r = estimateCommand('terraform apply -auto-approve', config);
  assert.equal(r.unknownBlastRadius, true);
  assert.equal(r.total, 0, 'we must not invent a number for an unreadable plan');
});

test('marks CloudFormation the same way', () => {
  const r = estimateCommand('aws cloudformation create-stack --stack-name mesh --template-body file://t.yaml', config);
  assert.equal(r.unknownBlastRadius, true);
});

test('ignores read-only commands', () => {
  for (const cmd of ['aws ec2 describe-instances', 'aws s3 ls', 'ls -la', 'git status', 'npm test']) {
    assert.equal(estimateCommand(cmd, config).matched, false, `${cmd} should not match`);
  }
});

test('honours price overrides', () => {
  const overridden = {
    ...config,
    priceOverrides: { 'aws.ec2.run-instances': { hourly: 1.0 } },
  };
  const r = estimateCommand('aws ec2 run-instances --instance-type m5.large', overridden);
  assert.equal(r.total, 24);
});

test('costs GCP and Azure creates', () => {
  assert.ok(estimateCommand('gcloud compute instances create web-1 --machine-type e2-standard-4', config).total > 0);
  assert.ok(estimateCommand('az vm create --name vm1 --size Standard_D4s_v3', config).total > 0);
});

test('counts multiple positional GCE instance names', () => {
  const one = estimateCommand('gcloud compute instances create a --machine-type e2-medium', config).total;
  const three = estimateCommand('gcloud compute instances create a b c --machine-type e2-medium', config).total;
  assert.ok(three > one, `expected 3 instances to cost more than 1 (${one} vs ${three})`);
});
