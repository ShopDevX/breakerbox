import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { estimatePlan } from '../src/terraform.js';
import { decidePlan } from '../src/policy.js';
import { loadConfig } from '../src/config.js';

const ENTRY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'breakerbox.js');
const tmpRoot = () => mkdtempSync(path.join(os.tmpdir(), 'breakerbox-tf-'));
const cfg = (root) => loadConfig(root).config;
const rc = (type, actions, after) => ({ address: `${type}.x`, type, name: 'x', change: { actions, after } });
const plan = (...changes) => ({ format_version: '1.2', resource_changes: changes });

test('prices a created GPU instance over the horizon and denies it', () => {
  const root = tmpRoot();
  try {
    const est = estimatePlan(plan(rc('aws_instance', ['create'], { instance_type: 'p4d.24xlarge' })), cfg(root));
    assert.equal(est.priced, 1);
    assert.ok(Math.abs(est.total - 786.54) < 0.5, `~786.54, got ${est.total}`);
    const v = decidePlan({ estimate: est, config: cfg(root), root, sessionId: 't' });
    assert.equal(v.decision, 'deny');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a replace counts as a create; delete/update/no-op do not', () => {
  const root = tmpRoot();
  try {
    const est = estimatePlan(plan(
      rc('aws_instance', ['delete', 'create'], { instance_type: 'm5.large' }),
      rc('aws_instance', ['delete'], null),
      rc('aws_instance', ['update'], { instance_type: 'm5.large' }),
      rc('aws_instance', ['no-op'], { instance_type: 'm5.large' }),
    ), cfg(root));
    assert.equal(est.findings.length, 1, 'only the replace is priced');
    assert.equal(est.findings[0].replace, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('unrecognised resource types are reported as unpriced, never crashed', () => {
  const root = tmpRoot();
  try {
    const est = estimatePlan(plan(
      rc('aws_s3_bucket', ['create'], {}),
      rc('random_pet', ['create'], {}),
      rc('aws_instance', ['create'], { instance_type: 't3.micro' }),
    ), cfg(root));
    assert.equal(est.created, 3);
    assert.equal(est.priced, 1);
    assert.equal(est.unpriced, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a managed node group multiplies by desired_size', () => {
  const root = tmpRoot();
  try {
    const est = estimatePlan(
      plan(rc('aws_eks_node_group', ['create'], { instance_types: ['g5.12xlarge'], scaling_config: [{ desired_size: 3 }] })),
      cfg(root),
    );
    assert.equal(est.findings[0].qty, 3);
    assert.ok(Math.abs(est.total - (5.672 * 24 * 3)) < 1, `~408.38, got ${est.total}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a modest plan stays within caps', () => {
  const root = tmpRoot();
  try {
    const est = estimatePlan(plan(rc('aws_instance', ['create'], { instance_type: 't3.micro' })), cfg(root));
    const v = decidePlan({ estimate: est, config: cfg(root), root, sessionId: 't' });
    assert.equal(v.decision, 'allow');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the plan CLI exits 2 on a denial and 0 on a pass', () => {
  const root = tmpRoot();
  try {
    writeFileSync(path.join(root, 'big.json'), JSON.stringify(plan(rc('aws_instance', ['create'], { instance_type: 'p4d.24xlarge' }))));
    writeFileSync(path.join(root, 'small.json'), JSON.stringify(plan(rc('aws_instance', ['create'], { instance_type: 't3.micro' }))));
    const env = { ...process.env, NO_COLOR: '1' };
    const deny = spawnSync(process.execPath, [ENTRY, 'plan', 'big.json'], { cwd: root, encoding: 'utf8', timeout: 20000, env });
    assert.equal(deny.status, 2);
    assert.match(deny.stdout, /DENY/);
    const ok = spawnSync(process.execPath, [ENTRY, 'plan', 'small.json'], { cwd: root, encoding: 'utf8', timeout: 20000, env });
    assert.equal(ok.status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a JSON that is not a plan is handled without crashing', () => {
  const root = tmpRoot();
  try {
    writeFileSync(path.join(root, 'nope.json'), JSON.stringify({ hello: 'world' }));
    const r = spawnSync(process.execPath, [ENTRY, 'plan', 'nope.json'], { cwd: root, encoding: 'utf8', timeout: 20000, env: { ...process.env, NO_COLOR: '1' } });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /resource_changes/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('version reports the shipped package version, not a hardcoded string', () => {
  const r = spawnSync(process.execPath, [ENTRY, 'version'], { encoding: 'utf8', timeout: 20000 });
  assert.match(r.stdout.trim(), /^\d+\.\d+\.\d+$/);
  assert.notEqual(r.stdout.trim(), '0.1.0');
});
