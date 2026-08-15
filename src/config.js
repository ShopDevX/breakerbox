import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { paths } from './paths.js';

export const DEFAULT_CONFIG = {
  /**
   * Hard caps in USD. `session` resets per agent session, `daily` per UTC day,
   * `action` applies to any single command line.
   */
  caps: {
    action: 20,
    session: 50,
    daily: 200,
  },

  /**
   * Velocity cap. A runaway loop shows up as call frequency long before it
   * shows up as dollars, so this trips first in the cases that matter.
   */
  rateLimit: {
    actions: 12,
    windowSeconds: 60,
  },

  /** Hours of runtime to charge an hourly resource against the cap up front. */
  horizonHours: 24,

  /** Iterations assumed for a loop we cannot count (e.g. `while true`). */
  unboundedLoopAssumption: 25,

  /** What to do when a cap is breached: "deny" or "ask". */
  onBreach: 'deny',

  /**
   * When the agent is running unattended (bypassPermissions / dontAsk / auto),
   * an "ask" cannot reach a human, so escalate it. Set to "ask" to disable.
   */
  unattendedEscalation: 'deny',

  /** Commands with no matching catalog rule: "allow" or "ask". */
  unmatched: 'allow',

  /** Per-risk-level decision applied even when under every cap. */
  riskPolicy: {
    low: 'allow',
    medium: 'allow',
    high: 'allow',
  },

  /** Actions whose cost cannot be read from the command line at all. */
  onUnknownBlastRadius: 'ask',

  /** Actions inside a loop we cannot bound. */
  onUnboundedLoop: 'deny',

  /** Substring matches. `allow` short-circuits to allow and never charges. */
  allow: [],
  deny: [],

  /** Rule ids to skip entirely, e.g. ["aws.s3.transfer"]. */
  ignoreRules: [],

  /** Override catalog pricing: { "aws.ec2.run-instances": { hourly: 0.2 } }. */
  priceOverrides: {},

  /** "open" lets tool calls through if breakerbox itself errors. */
  failMode: 'open',

  /** Tool names to inspect. Bash is where non-LLM spend happens. */
  tools: ['Bash'],
};

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function merge(base, override) {
  const out = { ...base };
  for (const [key, value] of Object.entries(override || {})) {
    if (isPlainObject(value) && isPlainObject(base[key])) out[key] = merge(base[key], value);
    else if (value !== undefined) out[key] = value;
  }
  return out;
}

function readJson(file) {
  try {
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    return { __error: `${path.basename(file)}: ${err.message}` };
  }
}

/**
 * Load config, layering: defaults < project config < local config < env.
 *
 * A malformed config is reported rather than thrown, so a typo cannot brick
 * every Bash call the agent tries to make.
 */
export function loadConfig(root) {
  const p = paths(root);
  const errors = [];
  let config = { ...DEFAULT_CONFIG };

  const sources = [];
  if (process.env.BREAKERBOX_CONFIG) sources.push(path.resolve(process.env.BREAKERBOX_CONFIG));
  else sources.push(p.projectConfig, p.localConfig);

  for (const file of sources) {
    const data = readJson(file);
    if (!data) continue;
    if (data.__error) { errors.push(data.__error); continue; }
    config = merge(config, data);
  }

  // Env overrides are the escape hatch for one-off runs and CI.
  const envSession = Number(process.env.BREAKERBOX_SESSION_CAP);
  if (Number.isFinite(envSession)) config.caps.session = envSession;
  const envDaily = Number(process.env.BREAKERBOX_DAILY_CAP);
  if (Number.isFinite(envDaily)) config.caps.daily = envDaily;
  if (process.env.BREAKERBOX_DISABLE === '1') config.disabled = true;

  return { config, errors, sources };
}

export function validateConfig(config) {
  const problems = [];
  const decisions = ['allow', 'deny', 'ask'];

  for (const key of ['action', 'session', 'daily']) {
    const v = config.caps?.[key];
    if (!Number.isFinite(v) || v < 0) problems.push(`caps.${key} must be a non-negative number`);
  }
  if (!Number.isFinite(config.horizonHours) || config.horizonHours <= 0) {
    problems.push('horizonHours must be a positive number');
  }
  for (const key of ['onBreach', 'unattendedEscalation', 'onUnknownBlastRadius', 'onUnboundedLoop']) {
    if (!decisions.includes(config[key])) problems.push(`${key} must be one of ${decisions.join(', ')}`);
  }
  if (!['allow', 'ask'].includes(config.unmatched)) problems.push('unmatched must be "allow" or "ask"');
  if (!['open', 'closed'].includes(config.failMode)) problems.push('failMode must be "open" or "closed"');

  return problems;
}
