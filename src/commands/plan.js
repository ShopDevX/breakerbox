import { readFileSync } from 'node:fs';
import { resolveRoot } from '../paths.js';
import { loadConfig } from '../config.js';
import { estimatePlan } from '../terraform.js';
import { decidePlan } from '../policy.js';
import { usd, rate } from '../util/money.js';
import { c, heading, kv, decisionColor } from '../util/ui.js';

/**
 * Spend preflight for a Terraform plan.
 *
 *   terraform plan -out tfplan
 *   terraform show -json tfplan > plan.json
 *   breakerbox plan plan.json
 *
 * Prices every created/replaced resource against the catalog and applies your
 * caps — the real number that `terraform apply` hides behind one opaque string.
 */
export async function cmdPlan(positional, flags = {}) {
  const file = positional[0];
  if (!file) {
    process.stderr.write(
      'Usage: breakerbox plan <plan.json>\n'
      + '  where plan.json is:  terraform show -json tfplan > plan.json\n',
    );
    process.exitCode = 1;
    return;
  }

  let plan;
  try {
    plan = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    process.stderr.write(
      `Could not read a Terraform JSON plan from "${file}": ${err.message}\n`
      + 'Generate one with:  terraform show -json tfplan > plan.json\n',
    );
    process.exitCode = 1;
    return;
  }

  const root = resolveRoot(process.cwd());
  const { config } = loadConfig(root);
  const estimate = estimatePlan(plan, config);
  const result = decidePlan({ estimate, config, root, sessionId: flags.session || 'plan' });

  if (flags.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = result.decision === 'deny' ? 2 : 0;
    return;
  }

  const paint = decisionColor(result.decision);
  process.stdout.write(`\n${c.grey('terraform plan')} ${c.grey('→')} ${c.grey(file)}\n`);
  process.stdout.write(`\n${paint(c.bold(result.decision.toUpperCase()))}  ${c.grey(`estimated ${usd(result.charged)}`)}\n`);

  if (!estimate.isPlan) {
    process.stdout.write(
      `\n  ${c.grey('That file has no `resource_changes` — is it `terraform show -json` output?')}\n`,
    );
  }

  const findings = estimate.findings;
  if (findings.length) {
    process.stdout.write(heading('Priced resources'));
    process.stdout.write('\n');
    for (const f of findings) {
      const parts = [];
      if (f.hourly) parts.push(rate(f.hourly));
      if (f.qty > 1) parts.push(`qty ${f.qty}`);
      if (f.key) parts.push(String(f.key));
      if (f.replace) parts.push('replace');
      parts.push(`${f.confidence} confidence`);
      process.stdout.write(`  ${c.bold(f.label)}  ${c.cyan(usd(f.charged))}\n`);
      process.stdout.write(`  ${c.grey(`${f.ruleId} · ${parts.join(' · ')}`)}\n\n`);
    }
  } else {
    process.stdout.write(`\n  ${c.grey('No priced resources in this plan.')}\n`);
  }

  if (result.reasons?.length) {
    process.stdout.write(heading('Why'));
    process.stdout.write('\n');
    for (const r of result.reasons) process.stdout.write(`  - ${r}\n`);
  }

  process.stdout.write(heading('Against your caps'));
  process.stdout.write('\n');
  process.stdout.write(kv([
    ['this plan', `${usd(result.charged)} / ${usd(config.caps.action)}`],
    ['session', `${usd(result.spent.session)} / ${usd(config.caps.session)}`],
    ['today', `${usd(result.spent.daily)} / ${usd(config.caps.daily)}`],
  ]));
  process.stdout.write('\n');

  process.stdout.write(heading('Coverage'));
  process.stdout.write('\n');
  process.stdout.write(
    `  ${c.grey(`Priced ${estimate.priced} of ${estimate.created} created resource(s); `
      + `${estimate.unpriced} unpriced (no rule yet), ${estimate.resourceCount} total in the plan.`)}\n`,
  );
  process.stdout.write(
    `\n${c.grey(`Projection horizon: ${config.horizonHours}h. Prices are approximate list prices — see README.`)}\n`,
  );

  process.exitCode = result.decision === 'deny' ? 2 : 0;
}
