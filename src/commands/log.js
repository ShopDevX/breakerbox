import { resolveRoot } from '../paths.js';
import { readLedger } from '../ledger.js';
import { usd } from '../util/money.js';
import { c } from '../util/ui.js';

function truncate(s, n) {
  const str = String(s ?? '').replace(/\s+/g, ' ');
  return str.length > n ? `${str.slice(0, n - 1)}…` : str;
}

export async function cmdLog(flags = {}) {
  const root = resolveRoot(process.cwd());
  const limit = Number(flags.n) > 0 ? Number(flags.n) : 20;
  const entries = readLedger(root).slice(-limit);

  if (flags.json) {
    process.stdout.write(`${JSON.stringify(entries, null, 2)}\n`);
    return;
  }

  if (!entries.length) {
    process.stdout.write(`\n${c.grey('No committed actions yet.')}\n\n`);
    return;
  }

  process.stdout.write(`\n${c.bold(`Last ${entries.length} committed actions`)}\n\n`);
  for (const e of entries) {
    const when = (e.committedAt || e.ts || '').slice(11, 19);
    const rules = (e.findings || []).map((f) => f.ruleId).join(', ');
    process.stdout.write(
      `  ${c.grey(when)}  ${c.cyan(usd(e.charged).padStart(9))}  ${truncate(e.command, 60)}\n`,
    );
    if (rules) process.stdout.write(`             ${c.grey(rules)}\n`);
  }

  const total = entries.reduce((s, e) => s + (Number(e.charged) || 0), 0);
  process.stdout.write(`\n  ${c.grey('shown total')}  ${c.bold(usd(total))}\n\n`);
}
