import { resolveRoot } from '../paths.js';
import { loadConfig } from '../config.js';
import { decide } from '../policy.js';
import { usd, rate } from '../util/money.js';
import { c, heading, kv, decisionColor } from '../util/ui.js';

/**
 * Dry-run a command through the full policy engine without recording anything.
 * This is the demo surface and the debugging surface: if the hook made a
 * decision you did not expect, `check` shows you why.
 */
export async function cmdCheck(positional, flags = {}) {
  const command = positional.join(' ').trim();
  if (!command) {
    process.stderr.write('Usage: breakerbox check "<command>"\n');
    process.exitCode = 1;
    return;
  }

  const root = resolveRoot(process.cwd());
  const { config } = loadConfig(root);

  const result = decide({
    command,
    config,
    root,
    sessionId: flags.session || 'check',
    permissionMode: flags.mode,
  });

  if (flags.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  const paint = decisionColor(result.decision);
  process.stdout.write(`\n${c.grey('$')} ${command}\n`);
  process.stdout.write(`\n${paint(c.bold(result.decision.toUpperCase()))}  ${c.grey(`estimated ${usd(result.charged)}`)}\n`);

  const findings = result.estimate?.findings || [];
  if (findings.length) {
    process.stdout.write(heading('Billable actions'));
    process.stdout.write('\n');
    for (const f of findings) {
      const parts = [];
      if (f.hourly) parts.push(rate(f.hourly));
      if (f.oneTime) parts.push(`${usd(f.oneTime)} one-time`);
      if (f.qty > 1) parts.push(`qty ${f.qty}`);
      if (f.iterations > 1) parts.push(`x${f.iterations} iterations`);
      parts.push(`${f.confidence} confidence`);

      process.stdout.write(`  ${c.bold(f.label)}  ${c.cyan(usd(f.charged))}\n`);
      process.stdout.write(`  ${c.grey(`${f.ruleId} · ${parts.join(' · ')}`)}\n`);
      if (f.note) process.stdout.write(`  ${c.grey(f.note)}\n`);
      process.stdout.write('\n');
    }
  } else {
    process.stdout.write(`\n  ${c.grey('No cost-incurring action recognised.')}\n`);
  }

  if (result.reasons?.length) {
    process.stdout.write(heading('Why'));
    process.stdout.write('\n');
    for (const r of result.reasons) process.stdout.write(`  - ${r}\n`);
  }

  if (result.spent) {
    process.stdout.write(heading('Against your caps'));
    process.stdout.write('\n');
    process.stdout.write(kv([
      ['this action', `${usd(result.charged)} / ${usd(config.caps.action)}`],
      ['session', `${usd(result.spent.session)} / ${usd(config.caps.session)}`],
      ['today', `${usd(result.spent.daily)} / ${usd(config.caps.daily)}`],
    ]));
    process.stdout.write('\n');
  }

  process.stdout.write(
    `\n${c.grey(`Projection horizon: ${config.horizonHours}h. Prices are approximate list prices — see README.`)}\n`,
  );

  process.exitCode = result.decision === 'deny' ? 2 : 0;
}
