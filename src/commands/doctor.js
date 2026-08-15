import { existsSync, readFileSync, accessSync, constants, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { resolveRoot, paths } from '../paths.js';
import { loadConfig, validateConfig } from '../config.js';
import { c, heading } from '../util/ui.js';

const PASS = () => c.green('  ok  ');
const WARN = () => c.yellow(' warn ');
const FAIL = () => c.red(' fail ');

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

/** Find every breakerbox hook registration across project and user settings. */
function findRegistrations(root) {
  const candidates = [
    path.join(root, '.claude', 'settings.json'),
    path.join(root, '.claude', 'settings.local.json'),
    path.join(os.homedir(), '.claude', 'settings.json'),
  ];
  const found = [];

  for (const file of candidates) {
    if (!existsSync(file)) continue;
    const settings = readJson(file);
    if (!settings?.hooks) continue;
    for (const [event, groups] of Object.entries(settings.hooks)) {
      for (const group of groups || []) {
        for (const hook of group.hooks || []) {
          if (typeof hook.command === 'string' && hook.command.includes('breakerbox')) {
            found.push({ file, event, matcher: group.matcher, command: hook.command });
          }
        }
      }
    }
  }
  return found;
}

/**
 * Run the registered hook command for real against a synthetic payload.
 * This is the only check that proves the whole chain works — path, node
 * resolution, stdin parsing, policy and output format.
 */
function selfTest(command, root) {
  const payload = JSON.stringify({
    session_id: 'breakerbox-doctor',
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_use_id: 'doctor-selftest',
    cwd: root,
    permission_mode: 'default',
    tool_input: {
      command: 'aws ec2 run-instances --instance-type p4d.24xlarge --count 8',
    },
  });

  const result = spawnSync(command, {
    input: payload,
    shell: true,
    encoding: 'utf8',
    timeout: 20000,
    env: { ...process.env, BREAKERBOX_DIR: path.join(os.tmpdir(), 'breakerbox-doctor') },
  });

  if (result.error) return { ok: false, detail: result.error.message };
  if (result.status !== 0) return { ok: false, detail: `exit ${result.status}: ${result.stderr?.trim()}` };

  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return { ok: false, detail: `expected JSON on stdout, got: ${result.stdout?.slice(0, 120) || '(nothing)'}` };
  }

  const decision = parsed?.hookSpecificOutput?.permissionDecision;
  if (decision !== 'deny') return { ok: false, detail: `expected deny for an 8x p4d fleet, got "${decision}"` };
  return { ok: true, detail: 'a $6,000/day EC2 fleet was correctly denied' };
}

export async function cmdDoctor() {
  const root = resolveRoot(process.cwd());
  const p = paths(root);
  const { config, errors, sources } = loadConfig(root);
  const lines = [];
  let failures = 0;
  let warnings = 0;

  const add = (status, label, detail) => {
    if (status === FAIL) failures++;
    if (status === WARN) warnings++;
    lines.push(`${status()}  ${label}${detail ? `\n        ${c.grey(detail)}` : ''}`);
  };

  // Node version
  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 18) add(PASS, `Node ${process.versions.node}`);
  else add(FAIL, `Node ${process.versions.node}`, 'breakerbox needs Node 18.17 or newer');

  // Config
  if (errors.length) add(FAIL, 'Config parses', errors.join('; '));
  else add(PASS, 'Config parses', sources.filter(existsSync).join(', ') || 'using built-in defaults');

  const problems = validateConfig(config);
  if (problems.length) add(FAIL, 'Config is valid', problems.join('; '));
  else add(PASS, 'Config is valid', `caps: $${config.caps.action} action / $${config.caps.session} session / $${config.caps.daily} daily`);

  // Ledger writability
  try {
    if (!existsSync(p.home)) mkdirSync(p.home, { recursive: true });
    accessSync(p.home, constants.W_OK);
    add(PASS, 'Ledger directory writable', p.home);
  } catch (err) {
    add(FAIL, 'Ledger directory writable', err.message);
  }

  // Hook registration
  const registrations = findRegistrations(root);
  const events = new Set(registrations.map((r) => r.event));

  if (!registrations.length) {
    add(FAIL, 'Hooks registered', 'No breakerbox hook found. Run `breakerbox init`.');
  } else {
    add(PASS, `Hooks registered (${registrations.length})`,
      registrations.map((r) => `${r.event}:${r.matcher} in ${r.file}`).join('\n        '));
  }

  if (registrations.length && !events.has('PreToolUse')) {
    add(FAIL, 'PreToolUse hook present', 'Without it nothing is ever blocked.');
  }
  if (registrations.length && !events.has('PostToolUse')) {
    add(WARN, 'PostToolUse hook present',
      'Without it, spend is never committed to the ledger and caps will never accumulate.');
  }

  // Stale npx path
  const stale = registrations.filter((r) => /_npx/.test(r.command));
  if (stale.length) {
    add(WARN, 'Hook path is stable', 'Registered command points into an npx cache that npm prunes. Run `npm i -g breakerbox && breakerbox init`.');
  }

  // End-to-end
  const target = registrations.find((r) => r.event === 'PreToolUse');
  if (target) {
    const test = selfTest(target.command, root);
    add(test.ok ? PASS : FAIL, 'End-to-end block works', test.detail);
  } else {
    add(WARN, 'End-to-end block works', 'Skipped: no PreToolUse hook registered.');
  }

  process.stdout.write(`\n${c.bold('breakerbox doctor')} ${c.grey(root)}\n\n`);
  process.stdout.write(`${lines.join('\n')}\n`);

  process.stdout.write(heading('Result'));
  if (failures) {
    process.stdout.write(`\n  ${c.red(`${failures} failing check${failures === 1 ? '' : 's'}`)} — the guardrail is not protecting you yet.\n\n`);
    process.exitCode = 1;
  } else if (warnings) {
    process.stdout.write(`\n  ${c.yellow(`${warnings} warning${warnings === 1 ? '' : 's'}`)} — working, but not fully.\n\n`);
  } else {
    process.stdout.write(`\n  ${c.green('All checks passed.')}\n\n`);
  }
}
