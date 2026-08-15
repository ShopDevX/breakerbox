import path from 'node:path';
import { isBooleanFlag } from '../parse.js';

/** argv[0] may be an absolute path or have a .exe suffix on Windows. */
export function binaryName(token) {
  if (!token) return '';
  const base = path.basename(String(token));
  return base.replace(/\.(exe|cmd|bat)$/i, '');
}

/**
 * Does argv invoke this subcommand path? e.g. matches(argv, ['aws','ec2','run-instances']).
 *
 * Global flags may appear anywhere, including before the subcommand
 * (`aws --region us-east-1 ec2 run-instances`), so we skip flags and the values
 * they consume while walking the positional words.
 */
export function matches(argv, words) {
  if (!Array.isArray(argv) || argv.length === 0) return false;
  if (binaryName(argv[0]) !== words[0]) return false;

  let wordIndex = 1;
  let skipNext = false;

  for (let i = 1; i < argv.length && wordIndex < words.length; i++) {
    const token = argv[i];

    if (token.startsWith('-')) {
      skipNext = !token.includes('=') && !isBooleanFlag(token);
      continue;
    }
    if (skipNext) { skipNext = false; continue; }

    if (token === words[wordIndex]) { wordIndex++; continue; }
    return false; // first positional did not match: different subcommand
  }

  return wordIndex === words.length;
}

/** Read a flag value, supporting `--flag value` and `--flag=value`. */
export function flag(argv, ...names) {
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    for (const name of names) {
      if (token === name) {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('-')) return next;
        return true;
      }
      if (token.startsWith(`${name}=`)) return token.slice(name.length + 1);
    }
  }
  return undefined;
}

/** Read a flag as a positive integer, falling back to `fallback`. */
export function intFlag(argv, names, fallback = 1) {
  const raw = flag(argv, ...names);
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** True if any of these flags is present at all. */
export function hasFlag(argv, ...names) {
  return names.some((name) => argv.some((t) => t === name || t.startsWith(`${name}=`)));
}

/**
 * Look up an hourly rate, falling back to a family-based guess.
 *
 * A guardrail that guesses low is worse than useless, so unknown instance
 * shapes resolve to a deliberately pessimistic number and report low
 * confidence. The policy layer can then choose to ask rather than allow.
 */
export function lookupRate(table, key, { gpuDefault = 3.0, cpuDefault = 0.5 } = {}) {
  if (key && Object.prototype.hasOwnProperty.call(table, key)) {
    return { hourly: table[key], confidence: 'high' };
  }
  if (!key) return { hourly: cpuDefault, confidence: 'low' };

  const family = String(key).toLowerCase();
  const isGpu = /(^|\.)(p[0-9]|g[0-9]|inf[0-9]|trn[0-9]|dl[0-9])/.test(family)
    || /(a2-|a3-|g2-)/.test(family)
    || /_(nc|nd|nv)/i.test(family);

  return { hourly: isGpu ? gpuDefault : cpuDefault, confidence: 'low' };
}

/** Standard shape every rule returns. */
export function estimate({
  ruleId,
  provider,
  label,
  risk = 'medium',
  oneTime = 0,
  hourly = 0,
  qty = 1,
  confidence = 'medium',
  unknownBlastRadius = false,
  note = '',
}) {
  return { ruleId, provider, label, risk, oneTime, hourly, qty, confidence, unknownBlastRadius, note };
}
