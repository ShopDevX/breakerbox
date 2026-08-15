#!/usr/bin/env node
/**
 * scripts/refresh-prices.js — on-demand price refresh.
 *
 * This is a BUILD-TIME / maintenance tool. It never runs inside breakerbox's hook,
 * so latency and determinism are not concerns here — the runtime only ever reads the
 * bundled table in src/catalog/prices.js.
 *
 * Sources
 *   Azure  — retail prices API, anonymous, works with no setup.        (always attempted)
 *   AWS    — the `aws pricing get-products` CLI, if `aws` is installed  (best-effort)
 *            and credentials resolve. Skipped cleanly otherwise.
 *   GCP    — needs a Billing Catalog API key; not wired here yet.       (skipped, noted)
 *
 * Safety
 *   - Dry-run by default. Prints a diff; changes nothing.
 *   - Pass --write to update src/catalog/prices.js in place and bump the stamp.
 *   - A refreshed price is REJECTED (kept at the old value, flagged) if it is $0 or
 *     moved more than MOVE_LIMIT vs the current table — that is almost always a bad
 *     parse or a transient API result, and a guardrail must never ship a wrong cap silently.
 *
 * Usage
 *   node scripts/refresh-prices.js            # dry-run, show the diff
 *   node scripts/refresh-prices.js --write    # apply it
 *   node scripts/refresh-prices.js --aws      # also attempt AWS (needs `aws` CLI + creds)
 *
 * Not shipped: scripts/ is excluded from the npm tarball (see package.json "files").
 */

import { readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { AZURE_VM, EC2 } from '../src/catalog/prices.js';

const exec = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const PRICES_FILE = join(HERE, '..', 'src', 'catalog', 'prices.js');

const WRITE = process.argv.includes('--write');
const DO_AWS = process.argv.includes('--aws');
const MOVE_LIMIT = 0.6; // reject swings larger than 60%

const changes = [];   // {table, key, old, next, pct}
const kept = [];      // {table, key, old, next, reason}
const missed = [];    // {source, key}
const notes = [];

function stamp() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function consider(table, key, old, raw) {
  if (typeof raw !== 'number' || !isFinite(raw) || raw <= 0) {
    kept.push({ table, key, old, next: raw, reason: 'non-positive / unparseable' });
    return;
  }
  const next = Number(raw.toFixed(4));
  if (next === old) return;
  const pct = old > 0 ? (next - old) / old : 1;
  if (Math.abs(pct) > MOVE_LIMIT) {
    kept.push({ table, key, old, next, reason: `moved ${(pct * 100).toFixed(0)}% (> ${MOVE_LIMIT * 100}% guard)` });
    return;
  }
  changes.push({ table, key, old, next, pct });
}

// ---------- Azure: anonymous retail API ----------
async function refreshAzure() {
  const base = 'https://prices.azure.com/api/retail/prices';
  for (const [sku, old] of Object.entries(AZURE_VM)) {
    const filter =
      `serviceName eq 'Virtual Machines' and priceType eq 'Consumption' ` +
      `and armRegionName eq 'eastus' and armSkuName eq '${sku}'`;
    const url = `${base}?currencyCode=USD&$filter=${encodeURIComponent(filter)}`;
    try {
      const res = await fetch(url, { headers: { accept: 'application/json' } });
      if (!res.ok) { missed.push({ source: 'azure', key: sku }); continue; }
      const json = await res.json();
      const items = (json.Items || []).filter(
        (i) => !/Windows/i.test(i.productName || '') &&
               !/Spot|Low Priority/i.test(i.meterName || '') &&
               !/Spot|Low Priority/i.test(i.skuName || '') &&
               typeof i.retailPrice === 'number' && i.retailPrice > 0,
      );
      if (!items.length) { missed.push({ source: 'azure', key: sku }); continue; }
      // smallest plausible on-demand hourly (guards against per-year/aggregate rows)
      const price = items.map((i) => i.retailPrice).sort((a, b) => a - b)[0];
      consider('AZURE_VM', sku, old, price);
    } catch {
      missed.push({ source: 'azure', key: sku });
    }
  }
}

// ---------- AWS: `aws pricing get-products` CLI, best-effort ----------
async function awsAvailable() {
  try { await exec('aws', ['--version']); return true; } catch { return false; }
}
function extractOnDemandUSD(priceListEntry) {
  const p = typeof priceListEntry === 'string' ? JSON.parse(priceListEntry) : priceListEntry;
  const od = p?.terms?.OnDemand;
  if (!od) return null;
  const term = Object.values(od)[0];
  const dim = term && Object.values(term.priceDimensions || {})[0];
  const usd = dim?.pricePerUnit?.USD;
  return usd != null ? Number(usd) : null;
}
async function refreshAws() {
  if (!(await awsAvailable())) {
    notes.push('AWS: `aws` CLI not found — skipped. Install the AWS CLI + creds and re-run with --aws.');
    return;
  }
  let credsOk = true;
  for (const [type, old] of Object.entries(EC2)) {
    if (!credsOk) break;
    const filters = [
      `Type=TERM_MATCH,Field=instanceType,Value=${type}`,
      'Type=TERM_MATCH,Field=operatingSystem,Value=Linux',
      'Type=TERM_MATCH,Field=tenancy,Value=Shared',
      'Type=TERM_MATCH,Field=preInstalledSw,Value=NA',
      'Type=TERM_MATCH,Field=capacitystatus,Value=Used',
      'Type=TERM_MATCH,Field=regionCode,Value=us-east-1',
    ];
    try {
      const { stdout } = await exec('aws', [
        'pricing', 'get-products', '--service-code', 'AmazonEC2',
        '--region', 'us-east-1', '--output', 'json', '--filters', ...filters,
      ], { maxBuffer: 8 * 1024 * 1024 });
      const list = JSON.parse(stdout).PriceList || [];
      if (!list.length) { missed.push({ source: 'aws', key: type }); continue; }
      const usd = extractOnDemandUSD(list[0]);
      if (usd == null) { missed.push({ source: 'aws', key: type }); continue; }
      consider('EC2', type, old, usd);
    } catch (e) {
      // first failure is almost always missing creds — stop hammering the API
      credsOk = false;
      notes.push('AWS: pricing query failed (likely no credentials) — skipped the rest. ' +
                 'Configure AWS creds (build-time only) and re-run with --aws.');
    }
  }
}

// ---------- write-back ----------
async function applyChanges() {
  let text = await readFile(PRICES_FILE, 'utf8');
  for (const c of changes) {
    const k = c.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`('${k}':\\s*)[0-9.]+`);
    if (!re.test(text)) { notes.push(`write: could not locate '${c.key}' in prices.js — skipped`); continue; }
    text = text.replace(re, `$1${c.next}`);
  }
  text = text.replace(/(PRICES_UPDATED = ')[0-9-]+(')/, `$1${stamp()}$2`);
  await writeFile(PRICES_FILE, text);
}

// ---------- report ----------
function report() {
  const n = (x) => x.toString().padStart(10);
  console.log(`\nbreakerbox price refresh · target stamp ${stamp()} · ${WRITE ? 'WRITE' : 'dry-run'}\n`);

  if (changes.length) {
    console.log(`Changed (${changes.length}):`);
    for (const c of changes.sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct))) {
      const dir = c.pct >= 0 ? '+' : '';
      console.log(`  ${(c.table + ' ' + c.key).padEnd(34)} ${n('$' + c.old)} -> ${n('$' + c.next)}  (${dir}${(c.pct * 100).toFixed(1)}%)`);
    }
  } else {
    console.log('Changed: none — the bundled table matches the sources checked.');
  }

  if (kept.length) {
    console.log(`\nFlagged, NOT applied (${kept.length}) — sanity guard held:`);
    for (const k of kept) console.log(`  ${(k.table + ' ' + k.key).padEnd(34)} ${k.reason} (saw ${k.next})`);
  }
  if (missed.length) {
    const bySrc = missed.reduce((m, x) => ((m[x.source] = (m[x.source] || 0) + 1), m), {});
    console.log(`\nNo price returned: ${Object.entries(bySrc).map(([s, c]) => `${s}×${c}`).join(', ')} (kept existing values)`);
  }
  if (notes.length) { console.log('\nNotes:'); for (const t of notes) console.log(`  - ${t}`); }

  console.log(WRITE
    ? `\nWrote ${changes.length} change(s) to src/catalog/prices.js. Review the diff, run the tests, commit.`
    : `\nDry-run. Re-run with --write to apply${DO_AWS ? '' : '  (add --aws to also refresh EC2 via the AWS CLI)'}.`);
  console.log('');
}

(async () => {
  await refreshAzure();
  if (DO_AWS) await refreshAws();
  else notes.push('AWS/GCP: not attempted. Azure refreshes anonymously; pass --aws to include EC2 (needs the AWS CLI + creds). GCP needs a Billing Catalog API key (not wired yet).');
  if (WRITE && changes.length) await applyChanges();
  report();
})().catch((e) => { console.error('refresh failed:', e.message); process.exit(1); });
