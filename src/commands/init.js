import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolveRoot, paths } from '../paths.js';
import { DEFAULT_CONFIG } from '../config.js';
import { c, heading } from '../util/ui.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(HERE, '..', '..');
const ENTRY = path.join(PACKAGE_ROOT, 'bin', 'breakerbox.js');

/**
 * Build the command Claude Code will run for each tool call.
 *
 * We point at an absolute path rather than `npx breakerbox hook` on purpose:
 * this runs on every single Bash call, and an npx resolution round-trip adds
 * hundreds of milliseconds to each one.
 */
export function hookCommand() {
  const entry = ENTRY.split(path.sep).join('/');
  return `node "${entry}" hook`;
}

/** npx unpacks into a cache directory that gets pruned, so an absolute path there will rot. */
export function isEphemeralInstall(entry = ENTRY) {
  const normalized = entry.split(path.sep).join('/');
  return /\/_npx\//.test(normalized) || /\/\.npm\/_cacache\//.test(normalized);
}

function readSettings(file) {
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`${file} is not valid JSON (${err.message}). Fix or move it, then re-run init.`);
  }
}

/**
 * Add our hook to an event without disturbing anything already registered.
 * Returns true when a change was made.
 */
export function registerHook(settings, event, matcher, command) {
  settings.hooks ||= {};
  settings.hooks[event] ||= [];

  const alreadyThere = settings.hooks[event].some((entry) => (entry.hooks || [])
    .some((h) => typeof h.command === 'string' && h.command.includes('breakerbox')));
  if (alreadyThere) return false;

  const group = settings.hooks[event].find((entry) => entry.matcher === matcher);
  const hookDef = { type: 'command', command };

  if (group) {
    group.hooks ||= [];
    group.hooks.push(hookDef);
  } else {
    settings.hooks[event].push({ matcher, hooks: [hookDef] });
  }
  return true;
}

function starterConfig() {
  return {
    caps: DEFAULT_CONFIG.caps,
    rateLimit: DEFAULT_CONFIG.rateLimit,
    horizonHours: DEFAULT_CONFIG.horizonHours,
    onBreach: DEFAULT_CONFIG.onBreach,
    onUnknownBlastRadius: DEFAULT_CONFIG.onUnknownBlastRadius,
    onUnboundedLoop: DEFAULT_CONFIG.onUnboundedLoop,
    unattendedEscalation: DEFAULT_CONFIG.unattendedEscalation,
    allow: [],
    deny: [],
    priceOverrides: {},
  };
}

export async function cmdInit(flags = {}) {
  const root = resolveRoot(process.cwd());
  const p = paths(root);
  const global = Boolean(flags.global);
  const settingsFile = global
    ? path.join(os.homedir(), '.claude', 'settings.json')
    : p.claudeSettings;

  const out = [];
  const command = hookCommand();

  // 1. Config file
  if (!existsSync(p.projectConfig) || flags.force) {
    writeFileSync(p.projectConfig, `${JSON.stringify(starterConfig(), null, 2)}\n`, 'utf8');
    out.push(`${c.green('created')}  ${path.relative(root, p.projectConfig)}`);
  } else {
    out.push(`${c.grey('kept')}     ${path.relative(root, p.projectConfig)} (use --force to overwrite)`);
  }

  // 2. Ledger directory
  if (!existsSync(p.home)) {
    mkdirSync(p.home, { recursive: true });
    out.push(`${c.green('created')}  ${path.relative(root, p.home)}/`);
  }

  // 3. Hook registration
  mkdirSync(path.dirname(settingsFile), { recursive: true });
  const settings = readSettings(settingsFile);
  const addedPre = registerHook(settings, 'PreToolUse', 'Bash', command);
  const addedPost = registerHook(settings, 'PostToolUse', 'Bash', command);

  if (addedPre || addedPost) {
    writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
    out.push(`${c.green('updated')}  ${settingsFile}`);
  } else {
    out.push(`${c.grey('kept')}     ${settingsFile} (breakerbox hooks already registered)`);
  }

  process.stdout.write(`${out.join('\n')}\n`);

  process.stdout.write(heading('Hook command') + `\n  ${c.dim(command)}\n`);

  if (isEphemeralInstall()) {
    process.stdout.write(
      `\n${c.yellow('warning')}  breakerbox is running from an npx cache directory, which npm prunes.\n`
      + `         The hook path above will eventually break. Install it properly:\n`
      + `           ${c.bold('npm i -g breakerbox && breakerbox init')}\n`,
    );
  }

  const caps = starterConfig().caps;
  process.stdout.write(
    heading('Active caps')
    + `\n  $${caps.action} per action · $${caps.session} per session · $${caps.daily} per day\n`
    + `\n${c.grey('Edit breakerbox.config.json to change them. Restart Claude Code to load the hooks.')}\n`
    + `${c.grey('Try it now:')} breakerbox check "aws ec2 run-instances --instance-type p4d.24xlarge"\n`,
  );

  return undefined;
}
