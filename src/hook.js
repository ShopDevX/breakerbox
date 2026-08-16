import { appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolveRoot, paths } from './paths.js';
import { loadConfig } from './config.js';
import { decide, summarize } from './policy.js';
import { writePending, commitPending, sweepPending, utcDate } from './ledger.js';
import { usd } from './util/money.js';

/** Read the whole hook payload from stdin. */
function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    if (process.stdin.isTTY) return resolve('');
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

function logError(root, err) {
  try {
    const p = paths(root);
    if (!existsSync(p.home)) mkdirSync(p.home, { recursive: true });
    appendFileSync(p.errors, `${new Date().toISOString()} ${err?.stack || err}\n`, 'utf8');
  } catch { /* never let logging break the hook */ }
}

/**
 * Append one line to the decision log for every command breakerbox evaluates.
 *
 * Tests prove the code does the right thing in each case; the log is what tells you
 * *which* case you were actually in on the day of the bill. Three outcomes look
 * identical from outside — priced under the cap, crashed into fail-open, or never
 * invoked at all — and only a per-invocation record separates them. The absence of
 * a line during the incident window is itself the signal that the hook wasn't wired.
 */
function logDecision(root, entry) {
  try {
    const p = paths(root);
    if (!existsSync(p.home)) mkdirSync(p.home, { recursive: true });
    appendFileSync(p.decisions, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n', 'utf8');
  } catch { /* the audit line must never break the hook */ }
}

/**
 * Emit a PreToolUse decision.
 *
 * Allow is expressed as *silence*, not as `permissionDecision: "allow"`.
 * Returning an explicit allow would short-circuit Claude Code's own permission
 * checks and the user's allowlist — breakerbox would end up auto-approving
 * commands it merely had no opinion about. Staying quiet leaves the normal
 * permission flow intact, which is the only safe default for a guardrail.
 */
function emit(decision, reason) {
  if (decision === 'allow') return;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
  }));
}

function buildReason({ decision, reasons, charged, estimate, spent, config }) {
  const lines = [];
  lines.push(decision === 'deny'
    ? '[breakerbox] Blocked: this command breaches a configured spend guardrail.'
    : '[breakerbox] Spend guardrail wants confirmation before this runs.');

  if (estimate?.findings?.length) {
    lines.push('');
    lines.push('Billable actions detected:');
    for (const line of summarize(estimate.findings)) lines.push(`  - ${line}`);
  }

  lines.push('');
  for (const r of reasons) lines.push(`- ${r}`);

  if (spent) {
    lines.push('');
    lines.push(
      `Committed so far: ${usd(spent.session)} this session, ${usd(spent.daily)} today. `
      + `Caps: ${usd(config.caps.session)} session / ${usd(config.caps.daily)} daily / ${usd(config.caps.action)} per action.`,
    );
  }

  if (decision === 'deny') {
    lines.push('');
    lines.push(
      'Do not retry this command as-is and do not try to work around the guardrail. '
      + 'Either pick a cheaper resource, reduce the number of resources, or stop and ask the user '
      + 'to raise the cap in breakerbox.config.json (or run `breakerbox reset --session`).',
    );
  }

  return lines.join('\n');
}

async function handlePreToolUse(payload, root, config) {
  const toolName = payload.tool_name;
  if (!config.tools.includes(toolName)) return;

  const command = payload.tool_input?.command;
  if (typeof command !== 'string' || !command.trim()) return;

  const result = decide({
    command,
    config,
    root,
    sessionId: payload.session_id,
    permissionMode: payload.permission_mode,
  });

  logDecision(root, {
    session: payload.session_id,
    command: command.length > 400 ? `${command.slice(0, 400)}…` : command,
    verdict: result.decision,          // allow | ask | deny
    failMode: config.failMode,         // which policy was live for this call
    charged: Number(result.charged) || 0,
    priced: (result.estimate?.findings?.length || 0) > 0,
  });

  // Record the intent so PostToolUse can commit it if the tool actually runs.
  if (!result.skipLedger && result.decision !== 'deny' && result.charged > 0) {
    writePending(root, {
      toolUseId: payload.tool_use_id,
      sessionId: payload.session_id,
      ts: new Date().toISOString(),
      date: utcDate(),
      command,
      charged: result.charged,
      decision: result.decision,
      findings: (result.estimate?.findings || []).map((f) => ({
        ruleId: f.ruleId, label: f.label, charged: f.charged, iterations: f.iterations,
      })),
      cwd: payload.cwd,
      state: 'pending',
    });
  }

  if (result.decision === 'allow') return;

  emit(result.decision, buildReason({ ...result, config }));
}

function handlePostToolUse(payload, root) {
  // The tool ran, so the money is real now.
  commitPending(root, payload.tool_use_id, {
    exitStatus: payload.tool_response?.interrupted ? 'interrupted' : 'ok',
  });
  sweepPending(root);
}

/**
 * Hook entry point. Always exits 0.
 *
 * Exit code 2 would block the tool call, and exit 1 is a non-blocking error;
 * we express every decision through JSON instead so that a crash in breakerbox
 * cannot silently start blocking the user's agent.
 */
export async function runHook() {
  let root = process.cwd();
  try {
    const input = await readStdin();
    if (!input.trim()) return;

    const payload = JSON.parse(input);
    root = resolveRoot(payload.cwd || process.cwd());

    const { config, errors } = loadConfig(root);
    if (errors.length) logError(root, new Error(`config: ${errors.join('; ')}`));

    if (payload.hook_event_name === 'PostToolUse') {
      handlePostToolUse(payload, root);
      return;
    }
    if (payload.hook_event_name === 'PreToolUse') {
      await handlePreToolUse(payload, root, config);
    }
  } catch (err) {
    logError(root, err);
    let failMode = 'open';
    try {
      const { config } = loadConfig(root);
      failMode = config.failMode;
      if (failMode === 'closed') {
        emit('ask', '[breakerbox] Guardrail failed to evaluate this command. Failing closed as configured.');
      }
    } catch { /* fail open */ }
    // The guard ran but crashed. Record which way it fell, so a postmortem can tell
    // this apart from a clean allow — or from breakerbox never being invoked at all.
    logDecision(root, {
      verdict: failMode === 'closed' ? 'ask' : 'allow',
      outcome: 'evaluation-error',
      failMode,
      error: String(err?.message || err).slice(0, 300),
    });
  }
}
