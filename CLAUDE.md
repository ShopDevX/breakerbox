# breakerbox

A spend guardrail for AI coding agents. Installs into Claude Code's `PreToolUse` hook, reads each
Bash command before it runs, estimates its real cloud cost, and blocks it if that breaches a cap.

Full context, transfer notes and roadmap: **`HANDOVER.md`** — read it before non-trivial work.

## Commands

```bash
node --test                         # 67 tests, expect 0 failures (built-in discovery; the glob only works on Node >=21)
node bin/breakerbox.js check "..."  # dry-run the policy engine
node bin/breakerbox.js doctor       # end-to-end install check
```

## Constraints

- **Zero runtime dependencies, no build step.** The hook runs on every Bash tool call, so process
  start is paid constantly (~48ms median). Do not add a dependency or a build output without a
  very good reason.
- Plain ESM JavaScript, not TypeScript. Node >= 18.17.
- Tests are `node:test` only. No test framework.

## Invariants — do not change these without reading the reasoning in HANDOVER.md §5

1. **Allow is silence.** `src/hook.js` must never emit `permissionDecision: "allow"` — that would
   override Claude Code's own permission checks and auto-approve commands breakerbox had no
   opinion about. It only ever speaks up to `deny` or `ask`.
2. **Decide on Pre, charge on Post.** A denied or cancelled command must never be charged to the
   ledger, or blocked commands would consume the user's cap.
3. **Hourly cost is projected over a horizon and charged up front.** Launching a server costs $0
   at that instant; a guardrail counting only immediate cost would never fire.
4. **IaC applies return $0 with `unknownBlastRadius: true`,** and escalate to `ask`. Never invent
   a placeholder cost for `terraform apply` or `cloudformation create-stack`.
5. **Unknown prices resolve pessimistically** ($0.50/hr CPU, $3.00/hr GPU-family, low confidence).
   Guessing low is worse than not guarding.
6. **`failMode` defaults to `open`** — a bug in this tool must not brick someone's agent.
7. **`resolveRoot()` must never return the home directory.** `~/.claude` and `~/package.json`
   otherwise make every marker-less project share one ledger and one cap. Covered by
   `test/paths.test.js`.

## Prices

Static table in `src/catalog/prices.js`, stamped `2026-08`. **No network calls at runtime, ever** —
that would add latency to every command and make verdicts non-reproducible. Refresh happens at
build time. See `HANDOVER.md` §6 before touching this.

Coverage beats precision: a missing catalog rule means a command sails through unpriced, whereas a
5% stale price never changes a verdict.

## Docs

`README.md` is launch-facing. Its **"What this cannot see"** section is deliberate and load-bearing
— it states the tool is a spend guardrail and not a security sandbox, and that `eval`/base64/script
indirection evade it. Do not soften or remove it.
