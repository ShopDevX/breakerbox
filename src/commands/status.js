import { resolveRoot, paths } from '../paths.js';
import { loadConfig } from '../config.js';
import { totals, readLedger, recentActionCount } from '../ledger.js';
import { usd } from '../util/money.js';
import { c, heading, meter } from '../util/ui.js';

export async function cmdStatus(flags = {}) {
  const root = resolveRoot(process.cwd());
  const p = paths(root);
  const { config, errors } = loadConfig(root);

  const entries = readLedger(root);
  const sessionId = flags.session
    || entries.filter((e) => e.sessionId).slice(-1)[0]?.sessionId;

  const spent = totals(root, { sessionId });
  const recent = recentActionCount(root, { windowSeconds: config.rateLimit.windowSeconds, now: Date.now() });

  if (flags.json) {
    process.stdout.write(`${JSON.stringify({ root, sessionId, spent, recent, caps: config.caps }, null, 2)}\n`);
    return;
  }

  process.stdout.write(`\n${c.bold('breakerbox')} ${c.grey(root)}\n`);
  if (config.disabled) process.stdout.write(`${c.yellow('DISABLED')} via BREAKERBOX_DISABLE=1\n`);

  process.stdout.write(heading('Spend against caps'));
  process.stdout.write('\n');

  const rows = [
    ['session', spent.session, config.caps.session],
    ['today', spent.daily, config.caps.daily],
    ['last 24h', spent.rolling24h, config.caps.daily],
  ];
  const width = Math.max(...rows.map(([l]) => l.length));
  for (const [label, used, cap] of rows) {
    const amountText = `${usd(used)} / ${usd(cap)}`.padEnd(18);
    process.stdout.write(`  ${c.grey(label.padEnd(width))}  ${amountText} ${meter(used, cap)}\n`);
  }

  process.stdout.write(heading('Rate'));
  process.stdout.write(
    `\n  ${recent} billable action${recent === 1 ? '' : 's'} in the last ${config.rateLimit.windowSeconds}s `
    + `${c.grey(`(limit ${config.rateLimit.actions})`)}\n`,
  );

  process.stdout.write(heading('Ledger'));
  process.stdout.write(
    `\n  ${spent.entries} committed action${spent.entries === 1 ? '' : 's'} `
    + `${c.grey(p.ledger)}\n`,
  );
  if (sessionId) process.stdout.write(`  ${c.grey(`session ${sessionId}`)}\n`);

  if (errors.length) {
    process.stdout.write(`\n${c.yellow('config problems')}\n`);
    for (const e of errors) process.stdout.write(`  - ${e}\n`);
  }

  process.stdout.write('\n');
}
