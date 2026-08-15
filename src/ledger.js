import {
  appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync,
  rmSync, statSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { paths } from './paths.js';
import { round } from './util/money.js';

const PENDING_TTL_MS = 30 * 60 * 1000;

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/** Safe filename for a tool_use_id of unknown provenance. */
function pendingFile(p, id) {
  const safe = String(id || 'unknown').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 120);
  return path.join(p.pending, `${safe}.json`);
}

export function utcDate(ts = new Date()) {
  return ts.toISOString().slice(0, 10);
}

/**
 * Record an intent to spend, keyed by tool_use_id.
 *
 * Nothing is charged here. PreToolUse fires before the tool runs, and the tool
 * may still be denied by breakerbox, denied by another hook, refused at the
 * permission prompt, or cancelled by the user. Charging on Pre would make the
 * ledger count money that was never spent, and would let a single blocked
 * command eat the session cap.
 */
export function writePending(root, entry) {
  const p = paths(root);
  ensureDir(p.pending);
  writeFileSync(pendingFile(p, entry.toolUseId), JSON.stringify(entry), 'utf8');
}

/**
 * Promote a pending intent to a committed charge. Called from PostToolUse,
 * which only fires once the tool has actually run.
 */
export function commitPending(root, toolUseId, extra = {}) {
  const p = paths(root);
  const file = pendingFile(p, toolUseId);
  if (!existsSync(file)) return null;

  let entry;
  try {
    entry = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    rmSync(file, { force: true });
    return null;
  }
  rmSync(file, { force: true });

  const committed = {
    ...entry,
    ...extra,
    committedAt: new Date().toISOString(),
    state: 'committed',
  };
  append(root, committed);
  return committed;
}

/** Append a committed entry to the ledger. */
export function append(root, entry) {
  const p = paths(root);
  ensureDir(p.home);
  appendFileSync(p.ledger, `${JSON.stringify(entry)}\n`, 'utf8');
}

/** Read committed entries, newest last. Tolerates partial final lines. */
export function readLedger(root) {
  const p = paths(root);
  if (!existsSync(p.ledger)) return [];
  let raw;
  try {
    raw = readFileSync(p.ledger, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip torn line */ }
  }
  return out;
}

/** Drop pending intents that were never committed (denied or abandoned calls). */
export function sweepPending(root, now = Date.now()) {
  const p = paths(root);
  if (!existsSync(p.pending)) return 0;
  let removed = 0;
  for (const name of readdirSync(p.pending)) {
    const file = path.join(p.pending, name);
    try {
      if (now - statSync(file).mtimeMs > PENDING_TTL_MS) {
        rmSync(file, { force: true });
        removed++;
      }
    } catch { /* raced with another process */ }
  }
  return removed;
}

/**
 * Current spend against each cap window.
 *
 * Only committed entries count. Pending intents are excluded on purpose — see
 * writePending. Claude Code runs tool calls sequentially within a session, so
 * the previous call has committed before the next one is evaluated.
 */
export function totals(root, { sessionId, now = new Date() } = {}) {
  const entries = readLedger(root);
  const today = utcDate(now);
  const windowStart = now.getTime() - 24 * 60 * 60 * 1000;

  let session = 0;
  let daily = 0;
  let rolling24h = 0;
  let sessionActions = 0;

  for (const e of entries) {
    const charged = Number(e.charged) || 0;
    const ts = Date.parse(e.committedAt || e.ts || '');

    if (sessionId && e.sessionId === sessionId) {
      session += charged;
      sessionActions++;
    }
    if ((e.date || utcDate(new Date(ts || Date.now()))) === today) daily += charged;
    if (Number.isFinite(ts) && ts >= windowStart) rolling24h += charged;
  }

  return {
    session: round(session),
    daily: round(daily),
    rolling24h: round(rolling24h),
    sessionActions,
    entries: entries.length,
  };
}

/** How many actions were committed inside the rate-limit window. */
export function recentActionCount(root, { windowSeconds, now = Date.now() }) {
  const cutoff = now - windowSeconds * 1000;
  let count = 0;
  for (const e of readLedger(root)) {
    const ts = Date.parse(e.committedAt || e.ts || '');
    if (Number.isFinite(ts) && ts >= cutoff) count++;
  }
  return count;
}

/** Clear ledger state. `scope` is "session", "day" or "all". */
export function reset(root, { scope = 'all', sessionId } = {}) {
  const p = paths(root);
  ensureDir(p.home);

  if (scope === 'all') {
    if (existsSync(p.ledger)) rmSync(p.ledger, { force: true });
    if (existsSync(p.pending)) rmSync(p.pending, { recursive: true, force: true });
    return { removed: 'all' };
  }

  const today = utcDate();
  const kept = readLedger(root).filter((e) => {
    if (scope === 'session') return e.sessionId !== sessionId;
    if (scope === 'day') return e.date !== today;
    return true;
  });

  writeFileSync(p.ledger, kept.map((e) => JSON.stringify(e)).join('\n') + (kept.length ? '\n' : ''), 'utf8');
  return { removed: scope, remaining: kept.length };
}
