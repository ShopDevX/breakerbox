const useColor = process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== 'dumb';

const wrap = (code) => (s) => (useColor ? `[${code}m${s}[0m` : String(s));

export const c = {
  bold: wrap(1),
  dim: wrap(2),
  red: wrap(31),
  green: wrap(32),
  yellow: wrap(33),
  blue: wrap(34),
  cyan: wrap(36),
  grey: wrap(90),
};

export function decisionColor(decision) {
  if (decision === 'deny') return c.red;
  if (decision === 'ask') return c.yellow;
  return c.green;
}

/** A simple aligned two-column list. */
export function kv(pairs, indent = '  ') {
  const width = Math.max(0, ...pairs.map(([k]) => String(k).length));
  return pairs.map(([k, v]) => `${indent}${c.grey(String(k).padEnd(width))}  ${v}`).join('\n');
}

/** A horizontal meter: [########------] 57% */
export function meter(used, cap, width = 24) {
  if (!Number.isFinite(cap) || cap <= 0) return '';
  const ratio = Math.max(0, Math.min(1, used / cap));
  const filled = Math.round(ratio * width);
  const bar = '#'.repeat(filled) + '-'.repeat(width - filled);
  const pct = `${Math.round(ratio * 100)}%`;
  const paint = ratio >= 1 ? c.red : ratio >= 0.75 ? c.yellow : c.green;
  return `${paint(`[${bar}]`)} ${pct}`;
}

export function heading(text) {
  return `\n${c.bold(text)}`;
}
