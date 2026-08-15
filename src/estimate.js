import { parseCommand } from './parse.js';
import { matchRule } from './catalog/index.js';
import { amount, round } from './util/money.js';

/**
 * Turn a command line into a list of priced findings.
 *
 * The cost model is two numbers per action: `oneTime` (charged once) and
 * `hourly` (charged for as long as the resource lives). A guardrail that only
 * counted `oneTime` would never trip on `aws ec2 run-instances`, because
 * launching an instance costs nothing at the moment you launch it — the bill
 * arrives over the following hours. So we project `hourly` over a configurable
 * horizon (default 24h) and charge that against the cap up front.
 */
export function estimateCommand(command, config) {
  const horizon = config.horizonHours;
  const { invocations } = parseCommand(command);
  const findings = [];

  for (const inv of invocations) {
    const rule = matchRule(inv.argv);
    if (!rule) continue;

    let est;
    try {
      est = rule.build(inv.argv);
    } catch (err) {
      // A rule that throws still tells us something ran that we care about.
      est = {
        ruleId: rule.id,
        provider: 'unknown',
        label: rule.id,
        risk: 'high',
        oneTime: 0,
        hourly: 0,
        qty: 1,
        confidence: 'low',
        unknownBlastRadius: true,
        note: `Rule error: ${err.message}`,
      };
    }

    const overrideKey = est.ruleId;
    const override = config.priceOverrides?.[overrideKey];
    if (override && typeof override === 'object') {
      if (Number.isFinite(override.hourly)) est.hourly = override.hourly;
      if (Number.isFinite(override.oneTime)) est.oneTime = override.oneTime;
    }

    const loop = inv.loop || null;
    const unbounded = Boolean(loop) && loop.iterations === null;
    const iterations = loop
      ? (loop.iterations ?? config.unboundedLoopAssumption)
      : 1;

    const perAction = amount(est.oneTime) + amount(est.hourly) * horizon;
    const charged = round(perAction * amount(est.qty) * Math.max(1, iterations));

    findings.push({
      ...est,
      command: inv.raw,
      substituted: Boolean(inv.substituted),
      loop: loop ? { kind: loop.kind, iterations: loop.iterations } : null,
      unbounded,
      iterations,
      horizonHours: horizon,
      charged,
    });
  }

  const total = round(findings.reduce((sum, f) => sum + f.charged, 0));

  return {
    findings,
    total,
    matched: findings.length > 0,
    unbounded: findings.some((f) => f.unbounded),
    unknownBlastRadius: findings.some((f) => f.unknownBlastRadius),
    highestRisk: highestRisk(findings),
  };
}

const RISK_ORDER = { low: 0, medium: 1, high: 2 };

function highestRisk(findings) {
  let best = null;
  for (const f of findings) {
    if (best === null || RISK_ORDER[f.risk] > RISK_ORDER[best]) best = f.risk;
  }
  return best;
}
