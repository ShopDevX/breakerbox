import { estimateCommand } from './estimate.js';
import { totals, recentActionCount } from './ledger.js';
import { usd } from './util/money.js';

const RANK = { allow: 0, ask: 1, deny: 2 };

/** Permission modes where no human is watching the prompt. */
const UNATTENDED_MODES = new Set(['bypassPermissions', 'dontAsk', 'auto']);

function stronger(a, b) {
  return RANK[b] > RANK[a] ? b : a;
}

function matchesAny(command, patterns) {
  if (!Array.isArray(patterns)) return false;
  return patterns.some((p) => {
    if (typeof p !== 'string' || !p) return false;
    if (p.startsWith('/') && p.lastIndexOf('/') > 0) {
      try {
        const end = p.lastIndexOf('/');
        return new RegExp(p.slice(1, end), p.slice(end + 1)).test(command);
      } catch { return false; }
    }
    return command.includes(p);
  });
}

/**
 * Decide whether a command line may run.
 *
 * Returns the decision plus every reason that contributed, so `breakerbox check`
 * and the hook's message to Claude can explain themselves. The strongest
 * decision wins; we never downgrade.
 */
export function decide({ command, config, root, sessionId, permissionMode, now = new Date() }) {
  const reasons = [];
  const cmd = String(command ?? '');

  if (config.disabled) {
    return { decision: 'allow', reasons: ['breakerbox is disabled'], charged: 0, estimate: null };
  }

  if (matchesAny(cmd, config.deny)) {
    return {
      decision: 'deny',
      reasons: ['Command matches a breakerbox deny rule.'],
      charged: 0,
      estimate: null,
    };
  }

  if (matchesAny(cmd, config.allow)) {
    return {
      decision: 'allow',
      reasons: ['Command matches a breakerbox allow rule; not charged.'],
      charged: 0,
      estimate: null,
      skipLedger: true,
    };
  }

  const raw = estimateCommand(cmd, config);
  const ignored = new Set(config.ignoreRules || []);
  const findings = raw.findings.filter((f) => !ignored.has(f.ruleId));

  if (findings.length === 0) {
    const decision = config.unmatched === 'ask' ? 'ask' : 'allow';
    return {
      decision,
      reasons: decision === 'ask'
        ? ['No cost rule matched and unmatched commands are set to ask.']
        : ['No cost-incurring action recognised.'],
      charged: 0,
      estimate: { ...raw, findings },
      skipLedger: true,
    };
  }

  const charged = Number(findings.reduce((s, f) => s + f.charged, 0).toFixed(2));
  const spent = totals(root, { sessionId, now });
  const caps = config.caps;

  let decision = 'allow';

  // Velocity first: a runaway loop trips this long before it trips a dollar cap.
  const recent = recentActionCount(root, {
    windowSeconds: config.rateLimit.windowSeconds,
    now: now.getTime(),
  });
  if (recent + 1 > config.rateLimit.actions) {
    decision = stronger(decision, config.onBreach);
    reasons.push(
      `Rate limit: ${recent} billable actions already ran in the last ${config.rateLimit.windowSeconds}s `
      + `(limit ${config.rateLimit.actions}). This looks like a loop, not deliberate work.`,
    );
  }

  const unbounded = findings.filter((f) => f.unbounded);
  if (unbounded.length) {
    decision = stronger(decision, config.onUnboundedLoop);
    reasons.push(
      `Billable action inside a loop with no readable bound (${unbounded[0].loop?.kind}). `
      + `Cost was projected assuming ${config.unboundedLoopAssumption} iterations, but the real number is unbounded.`,
    );
  }

  const opaque = findings.filter((f) => f.unknownBlastRadius);
  if (opaque.length) {
    decision = stronger(decision, config.onUnknownBlastRadius);
    reasons.push(
      `${opaque[0].label} can provision an unbounded amount of infrastructure. `
      + 'Its cost is defined by files breakerbox does not read, so it cannot be capped by estimate.',
    );
  }

  if (charged > caps.action) {
    decision = stronger(decision, config.onBreach);
    reasons.push(`Single action estimated at ${usd(charged)}, over the per-action cap of ${usd(caps.action)}.`);
  }

  if (spent.session + charged > caps.session) {
    decision = stronger(decision, config.onBreach);
    reasons.push(
      `Session spend would reach ${usd(spent.session + charged)} `
      + `(${usd(spent.session)} already committed + ${usd(charged)} for this action), over the session cap of ${usd(caps.session)}.`,
    );
  }

  if (spent.daily + charged > caps.daily) {
    decision = stronger(decision, config.onBreach);
    reasons.push(
      `Today's spend would reach ${usd(spent.daily + charged)}, over the daily cap of ${usd(caps.daily)}.`,
    );
  }

  const riskDecision = config.riskPolicy?.[raw.highestRisk];
  if (riskDecision && riskDecision !== 'allow') {
    decision = stronger(decision, riskDecision);
    reasons.push(`Risk policy for "${raw.highestRisk}" actions is set to ${riskDecision}.`);
  }

  // An "ask" that no human can answer is not a guardrail. Escalate it.
  const unattended = UNATTENDED_MODES.has(permissionMode);
  if (decision === 'ask' && unattended && config.unattendedEscalation !== 'ask') {
    decision = config.unattendedEscalation;
    reasons.push(
      `Escalated from ask to ${decision}: the agent is running in "${permissionMode}" mode, `
      + 'where a permission prompt would not reach a human.',
    );
  }

  if (decision === 'allow' && reasons.length === 0) {
    reasons.push(`Estimated ${usd(charged)} over a ${config.horizonHours}h horizon; within all caps.`);
  }

  return { decision, reasons, charged, estimate: { ...raw, findings }, spent };
}

/** Human-readable summary of what a command was found to do. */
export function summarize(findings) {
  return findings.map((f) => {
    const bits = [f.label];
    if (f.iterations > 1) bits.push(`x${f.iterations} iterations`);
    if (f.hourly) bits.push(`${usd(f.hourly)}/hr`);
    if (f.oneTime) bits.push(`${usd(f.oneTime)} one-time`);
    bits.push(`≈ ${usd(f.charged)} over ${f.horizonHours}h`);
    return bits.join(' · ');
  });
}
