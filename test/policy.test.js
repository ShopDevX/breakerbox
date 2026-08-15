import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { decide } from '../src/policy.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { append, totals, readLedger, reset, writePending, commitPending, utcDate } from '../src/ledger.js';

function tmpRoot() {
  return mkdtempSync(path.join(os.tmpdir(), 'breakerbox-test-'));
}

function run(command, overrides = {}, ctx = {}) {
  const root = ctx.root || tmpRoot();
  const config = { ...DEFAULT_CONFIG, ...overrides };
  return decide({ command, config, root, sessionId: ctx.sessionId || 's1', permissionMode: ctx.mode });
}

test('allows an ordinary command', () => {
  assert.equal(run('git status').decision, 'allow');
  assert.equal(run('npm run build').decision, 'allow');
});

test('allows a small, in-budget launch', () => {
  const r = run('aws ec2 run-instances --instance-type t3.micro');
  assert.equal(r.decision, 'allow');
  assert.ok(r.charged > 0);
});

test('denies a launch over the per-action cap', () => {
  const r = run('aws ec2 run-instances --instance-type p4d.24xlarge --count 8');
  assert.equal(r.decision, 'deny');
  assert.ok(r.reasons.some((x) => x.includes('per-action cap')));
});

test('denies a billable action inside an unbounded loop', () => {
  const r = run('while true; do aws ec2 run-instances --instance-type t3.micro; done');
  assert.equal(r.decision, 'deny');
  assert.ok(r.reasons.some((x) => x.includes('no readable bound')));
});

test('asks before an IaC apply instead of guessing a cost', () => {
  const r = run('terraform apply -auto-approve');
  assert.equal(r.decision, 'ask');
  assert.equal(r.charged, 0);
});

test('escalates ask to deny when nobody can answer the prompt', () => {
  const attended = run('terraform apply -auto-approve', {}, { mode: 'default' });
  const unattended = run('terraform apply -auto-approve', {}, { mode: 'bypassPermissions' });
  assert.equal(attended.decision, 'ask');
  assert.equal(unattended.decision, 'deny');
  assert.ok(unattended.reasons.some((x) => x.includes('bypassPermissions')));
});

test('accumulates session spend across calls and then denies', () => {
  const root = tmpRoot();
  try {
    const cmd = 'aws ec2 run-instances --instance-type m5.4xlarge'; // ~$18.43/day
    let last;
    for (let i = 0; i < 5; i++) {
      last = run(cmd, {}, { root, sessionId: 's1' });
      if (last.decision === 'deny') break;
      append(root, {
        sessionId: 's1',
        charged: last.charged,
        date: utcDate(),
        committedAt: new Date().toISOString(),
      });
    }
    assert.equal(last.decision, 'deny');
    assert.ok(last.reasons.some((x) => x.includes('session cap')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a different session is not charged for the first one', () => {
  const root = tmpRoot();
  try {
    for (let i = 0; i < 4; i++) {
      append(root, { sessionId: 's1', charged: 20, date: '2020-01-01', committedAt: '2020-01-01T00:00:00Z' });
    }
    const other = run('aws ec2 run-instances --instance-type t3.micro', {}, { root, sessionId: 's2' });
    assert.equal(other.decision, 'allow');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('trips the rate limit before dollars accumulate', () => {
  const root = tmpRoot();
  try {
    const now = new Date();
    for (let i = 0; i < 12; i++) {
      append(root, {
        sessionId: 's1',
        charged: 0.01,
        date: utcDate(now),
        committedAt: new Date(now.getTime() - 1000).toISOString(),
      });
    }
    const r = run('aws ec2 run-instances --instance-type t3.nano', {}, { root, sessionId: 's1' });
    assert.equal(r.decision, 'deny');
    assert.ok(r.reasons.some((x) => x.includes('Rate limit')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('allow list short-circuits and never charges', () => {
  const r = run('aws ec2 run-instances --instance-type p4d.24xlarge', { allow: ['run-instances'] });
  assert.equal(r.decision, 'allow');
  assert.equal(r.charged, 0);
});

test('deny list beats everything', () => {
  const r = run('aws s3 ls', { deny: ['aws s3'] });
  assert.equal(r.decision, 'deny');
});

test('deny list supports regex form', () => {
  const r = run('aws iam delete-user --user-name bob', { deny: ['/iam\\s+delete-/'] });
  assert.equal(r.decision, 'deny');
});

test('unmatched:ask makes unknown commands prompt', () => {
  assert.equal(run('some-unknown-binary --go', { unmatched: 'ask' }).decision, 'ask');
});

test('ignoreRules removes a rule from consideration', () => {
  const r = run('aws s3 sync ./big s3://bucket', { ignoreRules: ['aws.s3.transfer'] });
  assert.equal(r.decision, 'allow');
  assert.equal(r.charged, 0);
});

test('BREAKERBOX_DISABLE style disable flag allows everything', () => {
  const r = run('aws ec2 run-instances --instance-type p4d.24xlarge --count 99', { disabled: true });
  assert.equal(r.decision, 'allow');
});

test('pending intents are not counted until committed', () => {
  const root = tmpRoot();
  try {
    writePending(root, { toolUseId: 't1', sessionId: 's1', charged: 40, date: utcDate() });
    assert.equal(totals(root, { sessionId: 's1' }).session, 0, 'pending must not count');

    commitPending(root, 't1');
    assert.equal(totals(root, { sessionId: 's1' }).session, 40, 'committed must count');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('committing an unknown tool_use_id is a no-op', () => {
  const root = tmpRoot();
  try {
    assert.equal(commitPending(root, 'never-existed'), null);
    assert.equal(readLedger(root).length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('reset clears the ledger', () => {
  const root = tmpRoot();
  try {
    append(root, { sessionId: 's1', charged: 10, date: utcDate(), committedAt: new Date().toISOString() });
    reset(root, { scope: 'all' });
    assert.equal(readLedger(root).length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('reset --session leaves other sessions intact', () => {
  const root = tmpRoot();
  try {
    append(root, { sessionId: 's1', charged: 10, date: utcDate(), committedAt: new Date().toISOString() });
    append(root, { sessionId: 's2', charged: 10, date: utcDate(), committedAt: new Date().toISOString() });
    reset(root, { scope: 'session', sessionId: 's1' });
    const left = readLedger(root);
    assert.equal(left.length, 1);
    assert.equal(left[0].sessionId, 's2');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
