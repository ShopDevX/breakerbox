import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readLedger } from '../src/ledger.js';
import { registerHook } from '../src/commands/init.js';

const ENTRY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'breakerbox.js');

function tmpRoot() {
  return mkdtempSync(path.join(os.tmpdir(), 'breakerbox-hook-'));
}

function readDecisions(root) {
  try {
    return readFileSync(path.join(root, '.breakerbox', 'decisions.jsonl'), 'utf8')
      .trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}

/** Invoke the real binary the way Claude Code would. */
function invoke(payload, root, config) {
  if (config) writeFileSync(path.join(root, 'breakerbox.config.json'), JSON.stringify(config), 'utf8');
  const res = spawnSync(process.execPath, [ENTRY, 'hook'], {
    input: JSON.stringify({ cwd: root, ...payload }),
    encoding: 'utf8',
    timeout: 20000,
  });
  return {
    status: res.status,
    stdout: res.stdout || '',
    json: (() => { try { return JSON.parse(res.stdout); } catch { return null; } })(),
  };
}

const pre = (command, extra = {}) => ({
  session_id: 'sess-1',
  hook_event_name: 'PreToolUse',
  tool_name: 'Bash',
  tool_use_id: 'tool-1',
  permission_mode: 'default',
  tool_input: { command },
  ...extra,
});

test('stays silent on an allowed command so normal permissions still apply', () => {
  const root = tmpRoot();
  try {
    const r = invoke(pre('git status'), root);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '', 'allow must produce no output, not permissionDecision:allow');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('emits a well-formed deny for an over-cap launch', () => {
  const root = tmpRoot();
  try {
    const r = invoke(pre('aws ec2 run-instances --instance-type p4d.24xlarge --count 8'), root);
    assert.equal(r.status, 0, 'hook must always exit 0 and express itself through JSON');
    assert.ok(r.json, 'expected JSON on stdout');
    assert.equal(r.json.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.equal(r.json.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(r.json.hookSpecificOutput.permissionDecisionReason, /breakerbox/);
    assert.match(r.json.hookSpecificOutput.permissionDecisionReason, /per-action cap/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the deny message tells the agent not to work around it', () => {
  const root = tmpRoot();
  try {
    const r = invoke(pre('while true; do aws ec2 run-instances --instance-type m5.large; done'), root);
    const reason = r.json.hookSpecificOutput.permissionDecisionReason;
    assert.match(reason, /Do not retry this command as-is/);
    assert.match(reason, /work around the guardrail/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a denied command is never charged to the ledger', () => {
  const root = tmpRoot();
  try {
    invoke(pre('aws ec2 run-instances --instance-type p4d.24xlarge --count 8'), root);
    assert.equal(readLedger(root).length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an allowed command is charged only after PostToolUse', () => {
  const root = tmpRoot();
  try {
    invoke(pre('aws ec2 run-instances --instance-type t3.micro'), root);
    assert.equal(readLedger(root).length, 0, 'PreToolUse alone must not commit');

    invoke({
      session_id: 'sess-1',
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_use_id: 'tool-1',
      tool_input: { command: 'aws ec2 run-instances --instance-type t3.micro' },
      tool_response: {},
    }, root);

    const ledger = readLedger(root);
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].state, 'committed');
    assert.ok(ledger[0].charged > 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ignores tools other than Bash', () => {
  const root = tmpRoot();
  try {
    const r = invoke({
      session_id: 'sess-1',
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_use_id: 'tool-9',
      tool_input: { file_path: '/etc/passwd' },
    }, root);
    assert.equal(r.stdout.trim(), '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('survives malformed stdin without blocking the agent', () => {
  const res = spawnSync(process.execPath, [ENTRY, 'hook'], {
    input: 'not json at all',
    encoding: 'utf8',
    timeout: 20000,
  });
  assert.equal(res.status, 0);
  assert.equal((res.stdout || '').trim(), '');
});

test('survives empty stdin', () => {
  const res = spawnSync(process.execPath, [ENTRY, 'hook'], { input: '', encoding: 'utf8', timeout: 20000 });
  assert.equal(res.status, 0);
});

test('a broken config does not brick the agent (fails open)', () => {
  const root = tmpRoot();
  try {
    writeFileSync(path.join(root, 'breakerbox.config.json'), '{ this is not json', 'utf8');
    const r = invoke(pre('git status'), root);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fails CLOSED — an evaluation failure becomes an explicit ask, not a silent allow', () => {
  // The dangerous failure mode for a PreToolUse guard is the silent one: it crashes,
  // the call proceeds, and nothing says so. With failMode:"closed" the catch must turn
  // that into an explicit `ask`. Force the crash with malformed stdin so the failure
  // path is exercised end-to-end through the real binary.
  const root = tmpRoot();
  try {
    writeFileSync(path.join(root, 'breakerbox.config.json'), JSON.stringify({ failMode: 'closed' }), 'utf8');
    const res = spawnSync(process.execPath, [ENTRY, 'hook'], {
      input: 'not json at all',
      cwd: root, // so process.cwd() inside the hook resolves to this project's config
      encoding: 'utf8',
      timeout: 20000,
    });
    assert.equal(res.status, 0, 'still exits 0 — decisions are expressed as JSON');
    const json = (() => { try { return JSON.parse(res.stdout); } catch { return null; } })();
    assert.ok(json, 'failMode:closed must emit a decision, not stay silent');
    assert.equal(json.hookSpecificOutput.permissionDecision, 'ask',
      'a crash under failMode:closed must ask, never silently allow');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('writes one decision line per evaluated command — the postmortem trail', () => {
  const root = tmpRoot();
  try {
    invoke(pre('git status'), root); // allowed
    invoke(pre('aws ec2 run-instances --instance-type p4d.24xlarge --count 8'), root); // denied
    const log = readDecisions(root);
    assert.equal(log.length, 2, 'every evaluated Bash command leaves a line');
    assert.equal(log[0].verdict, 'allow');
    assert.equal(log[1].verdict, 'deny');
    assert.ok(log.every((l) => l.failMode && l.ts), 'each line records the live failMode and a timestamp');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the decision log tells a crash apart from a clean allow', () => {
  const root = tmpRoot();
  try {
    writeFileSync(path.join(root, 'breakerbox.config.json'), JSON.stringify({ failMode: 'closed' }), 'utf8');
    spawnSync(process.execPath, [ENTRY, 'hook'], { input: 'not json at all', cwd: root, encoding: 'utf8', timeout: 20000 });
    const log = readDecisions(root);
    assert.equal(log.length, 1);
    assert.equal(log[0].outcome, 'evaluation-error', 'a crash is recorded, never silent');
    assert.equal(log[0].verdict, 'ask', 'under failMode:closed the crash asks');
    assert.equal(log[0].failMode, 'closed', 'the log names which failMode was live');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('config caps are honoured from disk', () => {
  const root = tmpRoot();
  try {
    const r = invoke(pre('aws ec2 run-instances --instance-type t3.micro'), root, {
      caps: { action: 0.01, session: 0.01, daily: 0.01 },
    });
    assert.equal(r.json?.hookSpecificOutput?.permissionDecision, 'deny');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('registerHook does not duplicate an existing registration', () => {
  const settings = {};
  assert.equal(registerHook(settings, 'PreToolUse', 'Bash', 'node breakerbox hook'), true);
  assert.equal(registerHook(settings, 'PreToolUse', 'Bash', 'node breakerbox hook'), false);
  assert.equal(settings.hooks.PreToolUse[0].hooks.length, 1);
});

test('registerHook preserves hooks that are already there', () => {
  const settings = {
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'my-linter' }] }] },
  };
  registerHook(settings, 'PreToolUse', 'Bash', 'node breakerbox hook');
  const commands = settings.hooks.PreToolUse[0].hooks.map((h) => h.command);
  assert.deepEqual(commands, ['my-linter', 'node breakerbox hook']);
});

test('the CLI check command exits 2 on a denial', () => {
  const res = spawnSync(process.execPath, [
    ENTRY, 'check', 'aws ec2 run-instances --instance-type p4d.24xlarge --count 8',
  ], { encoding: 'utf8', cwd: tmpRoot(), timeout: 20000, env: { ...process.env, NO_COLOR: '1' } });
  assert.equal(res.status, 2);
  assert.match(res.stdout, /DENY/);
});
