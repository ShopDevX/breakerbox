# breakerbox — handover

Written 2026-08-15. Read this first if you're picking the project up on a new machine.

---

## 1. What this is

**breakerbox** is a spend guardrail for AI coding agents. It installs into Claude Code's
`PreToolUse` hook, reads every Bash command *before* it executes, estimates what that command
will cost in real cloud money, and blocks it if that breaches a cap you configured.

The wedge: LLM gateways (LiteLLM, Portkey, Bifrost) already cap **token** spend and do it well.
Nothing caps what the agent does *after* the model call — the `aws ec2 run-instances`, the
`terraform apply`, the shell command. That gap is the whole product.

Positioning line to keep: *"LiteLLM caps what your agent spends on tokens. breakerbox caps what
it spends on everything else."* It is complementary, not competitive. Do not let anyone reframe
it as a LiteLLM rival — that fight is lost and unnecessary.

### Status as of handover

| | |
|---|---|
| Version | 0.1.0, unreleased |
| Tests | **67 passing, 0 failing** |
| Runtime dependencies | **zero** (deliberate — see §5) |
| Build step | none |
| Git | **not initialised yet** |
| Published to npm | no — the name `breakerbox` was still free at handover |
| Node required | >= 18.17 (developed on 22.17.0) |

---

## 2. Getting it onto the new machine

### Option A — git (recommended)

```bash
cd C:\xampp\htdocs\breakerbox
git init
git add .
git commit -m "breakerbox 0.1.0: spend guardrail for AI agent tool calls"
gh repo create ShopDevX/breakerbox --public --source=. --push
```

Then on the new PC: `git clone https://github.com/ShopDevX/breakerbox.git`

`.gitignore` already excludes `.breakerbox/` and `node_modules/`, so nothing machine-specific
travels.

### Option B — copy the folder

Copy `C:\xampp\htdocs\breakerbox` wholesale, then **delete `.breakerbox/`** from the copy. That
directory is local runtime state (the spend ledger) and means nothing on another machine.

There is no `npm install` step either way — the package has no dependencies.

### ⚠️ The one thing that will not survive the move

`breakerbox init` writes an **absolute path** into `.claude/settings.json`:

```json
"command": "node \"C:/xampp/htdocs/breakerbox/bin/breakerbox.js\" hook"
```

That path won't exist on the new PC. **Re-run `breakerbox init` in any project you had it set up
in.** `breakerbox doctor` catches this — its end-to-end check will fail loudly rather than
silently leaving you unprotected.

---

## 3. Verify it arrived intact

Run these three on the new machine. All three passed here before handover.

```bash
# 1. Test suite — expect "# pass 67 / # fail 0"
node --test   # built-in discovery; the "test/**" glob only expands on Node >=21

# 2. The flagship case — expect DENY at $6292.34, exit code 2
node bin/breakerbox.js check "aws ec2 run-instances --instance-type p4d.24xlarge --count 8"

# 3. Full install check in a scratch project — expect "All checks passed"
mkdir /tmp/bbtest && cd /tmp/bbtest && echo "{}" > package.json
node <path-to>/breakerbox/bin/breakerbox.js init
node <path-to>/breakerbox/bin/breakerbox.js doctor
```

`doctor` is the real proof: it feeds a synthetic 8×`p4d.24xlarge` launch through the
actually-registered hook command and asserts it comes back denied. It tests the chain, not the
file listing.

Measured hook latency here was **48ms median** over 12 runs (essentially all Node process start).
If it's much worse on the new machine, something is wrong.

---

## 4. File map

```
breakerbox/
├─ bin/breakerbox.js        CLI entry point, nothing but arg forwarding
├─ src/
│  ├─ cli.js                Command router + arg parser
│  ├─ hook.js               ★ PreToolUse / PostToolUse contract. The integration point.
│  ├─ policy.js             ★ The decision engine. Precedence order lives here.
│  ├─ estimate.js           Turns a command into priced findings
│  ├─ parse.js              ★ Shell reader: quotes, escapes, $(...), loop counting
│  ├─ ledger.js             Pending-on-Pre / commit-on-Post spend record
│  ├─ config.js             Defaults + layered load + validation
│  ├─ paths.js              Project-root resolution (has a subtle guard — see §5)
│  ├─ index.js              Programmatic API surface
│  ├─ catalog/
│  │  ├─ index.js           Rule registry, first-match-wins
│  │  ├─ helpers.js         matches() / flag() / lookupRate() — read this before adding rules
│  │  ├─ prices.js          ★ The price table. ~120 hourly rates, stamped 2026-08.
│  │  ├─ aws.js  gcloud.js  azure.js  iac.js  generic.js
│  ├─ commands/             init · check · status · log · reset · doctor
│  └─ util/                 money.js (formatting) · ui.js (terminal color)
├─ test/                    67 tests: parse · estimate · policy · hook · paths
├─ docs/how-it-works.html   Plain-language explainer with 4 SVG diagrams
├─ README.md                Launch-facing. The "What this cannot see" section is load-bearing.
└─ HANDOVER.md              this file
```

★ = read these before changing behaviour.

The published explainer page is at
`https://claude.ai/code/artifact/171ac7d1-5d75-4d95-ab7e-b8a20b3489cf`
(private until shared; source of truth is `docs/how-it-works.html` — edit that, republish from it).

---

## 5. Design decisions a fresh session will otherwise undo

These are load-bearing and non-obvious. Each one looks like a bug or an oversight until you know
why. **If you're asking Claude Code to change something in this area, paste the reasoning in.**

### Allow is expressed as *silence*

`src/hook.js` never emits `permissionDecision: "allow"`. It only speaks up to `deny` or `ask`.

Emitting an explicit allow would **override Claude Code's own permission checks** — breakerbox
would end up auto-approving commands it merely had no opinion about, which is the opposite of a
guardrail. Staying quiet leaves the normal permission flow intact.

### Decide on Pre, charge on Post

`PreToolUse` writes a *pending intent* keyed by `tool_use_id`. `PostToolUse` promotes it to a
committed charge. Nothing counts against a cap until the tool actually ran.

Without the split, a command you *denied* — or the user cancelled at the prompt — would still eat
the session cap. A few blocked commands would lock out an agent that never spent a cent.

### Hourly cost is projected over a horizon, then charged up front

`charged = (oneTime + hourly × horizonHours) × qty × loopIterations`, default horizon 24h.

Launching an EC2 instance costs **$0 at the moment you launch it**. A guardrail counting only
immediate cost would never fire on the exact command that causes these incidents. This is the
single most counterintuitive decision in the codebase.

### `terraform apply` gets no invented number

IaC rules set `unknownBlastRadius: true` and return **$0**, then the policy escalates to `ask`.
The cost lives in files breakerbox isn't reading. Guessing a number would be worse than admitting
ignorance. Do not "improve" this by making up a placeholder cost.

### `ask` becomes `deny` when nobody is watching

If `permission_mode` is `bypassPermissions` / `dontAsk` / `auto`, an `ask` cannot reach a human,
so it escalates to `deny`. **This is the mode where the tool earns its keep** — Claude Code itself
asks nothing there.

### Zero dependencies, no build step

Not minimalism for its own sake. The hook runs on *every* Bash tool call, so process start is paid
constantly. Adding a dependency or a build output directly taxes every command the agent runs.
Measured: 48ms median. Guard this number.

### Unknown prices resolve *pessimistically*

`lookupRate()` falls back to $0.50/hr for unknown CPU shapes and $3.00/hr for anything matching a
GPU family pattern, and reports `confidence: 'low'`. A guardrail that guesses low is worse than no
guardrail. Keep the bias.

### `failMode` defaults to `"open"`

If breakerbox itself throws, the command proceeds and the error goes to `.breakerbox/errors.log`.
A bug in a safety tool must not brick someone's agent. `"closed"` is available for those who want
the inverse.

### `resolveRoot()` stops at the home directory

`src/paths.js` walks up looking for a project marker but **never returns `~`**. This was a real bug
found in testing: `~/.claude` and a stray `~/package.json` meant every marker-less directory
resolved to the home folder, so unrelated projects shared one ledger and one project's spend
consumed another's cap. `test/paths.test.js` covers it. Don't remove the guard.

---

## 6. Where the prices come from

**A static table** in `src/catalog/prices.js`. No network calls at runtime, ever.

This was investigated and settled at handover — don't relitigate it without reading this:

| Source | Auth | Notes |
|---|---|---|
| Azure Retail Prices API | none | Best of the three. OData-filterable, small JSON responses. **Verified live** — returned $0.192/hr for `Standard_D4s_v3` Linux, matching the table exactly. |
| AWS Price List Bulk | none | **457.8 MB** for one region's EC2 alone (measured). Stream-parse or use CSV. |
| AWS Price List Query | IAM creds | Small filtered results, but needs credentials. |
| GCP Cloud Billing Catalog | API key | The odd one out. |

**Decision: refresh at build time, never at runtime.** A network call in the hook would add
200–800ms to every `ls` and `git status`, and would make verdicts non-reproducible — the same
command could be allowed today and denied tomorrow because an API was slow. Google search is
categorically wrong here for the same reason (non-deterministic).

Planned mechanism (not built yet): a monthly GitHub Action running `scripts/refresh-prices.js`
that pulls the official endpoints, distills them to the same small table, and opens a PR with the
diff. Reviewable, zero runtime cost, ships in the next npm release.

**Perspective that should govern effort:** price precision barely affects behaviour. $32.77 vs
$33.10 never changes a verdict when the cap is $20. What changes verdicts is **coverage** (does a
rule exist for this command at all?) and **order of magnitude**. Spend effort on more catalog
rules, not more precise prices.

---

## 7. Next steps, ranked

1. **`git init` + push to GitHub.** Nothing is version controlled yet. Do this first.
2. **More catalog rules.** Highest value per hour of work — a missing rule means a command sails
   through unpriced. Gaps worth closing: Vertex AI, Bedrock provisioned throughput, Snowflake,
   Databricks, DigitalOcean, Hetzner, `kubectl apply` on cloud-backed clusters.
3. **CI**: a GitHub Action running `node --test` on push. Trivial, and it gates everything else.
4. **MCP tool-call interception** (`mcp__*` matchers). Currently only `Bash` is inspected — this
   is the biggest coverage hole and it's named in the README so it's a known-honest gap.
5. **`scripts/refresh-prices.js` + monthly Action** (see §6). A maintenance mechanism, not a
   launch feature. Do it once there are users.
6. **`terraform plan` parsing**, to replace `unknownBlastRadius` with a real number. The most
   valuable feature nobody else has, and the hardest.

### Launch checklist when ready

- [ ] `npm publish` — **the name `breakerbox` was still free at handover; confirm before you plan around it**
- [ ] Verify README's "What this cannot see" section is intact. It is the credibility of the whole
      launch. The failure mode for this product category is overselling and getting dismantled in
      the HN comments.
- [ ] Decide on the incident framing. `docs/how-it-works.html` currently uses the ~$6,500 runaway
      figure as an *unattributed* illustration. If you cite the incident directly in launch
      material, either link the source or keep the page generic — don't half-attribute it.

---

## 8. Project background

This is idea 1 of 3 that were on the table, chosen after checking the competitive claims:

- **Idea 2 (AI Agent Reputation Firewall)** — dropped. Needs hosted crawler infrastructure, can't
  be MIT-and-forget, no `npx` install story, and its core product is a classifier that publicly
  labels content as agent-authored and retaliatory — where false positives are defamation exposure,
  not a quality bug.
- **Idea 3 (AGENTS.md linter/sync)** — dropped as a standalone product. The "no maintained tool
  exists" premise was false: [rulesync](https://pypi.org/project/rulesync/) and
  [ai-rules-sync](https://github.com/PanisHandsome/ai-rules-sync) both already do cross-tool sync.
  The unserved slice (size-limit linting, drift detection in CI) is a weekend of work and belongs
  inside Adeptly's coverage-scoring feature.

The playbook being replicated is **Adeptly** (`https://adeptly.shopdevx.com`): MIT, free, local-first,
`npx`-installable, zero new trust surface, riding Claude Code's distribution as an adjacent layer.
Adeptly reached ~2,517 installs in two months at a ~40:1 install-to-star ratio — meaning the
distribution engine is one-command install and word of mouth, not GitHub virality. Anything new
should be `npx`-able on day one or it won't reproduce that.

One honest read on Adeptly's numbers worth carrying forward: month one was ~1,740 installs, month
two ~776. That's a normal launch-spike decay, but it means Adeptly proved *attention*, not
retention. **Judge breakerbox on whether people leave it installed, not on launch-day spike.**
