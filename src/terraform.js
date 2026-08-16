/**
 * Price a Terraform plan — the point where breakerbox stops linting command
 * strings and starts doing real spend preflight.
 *
 * `terraform apply` at the command line is opaque: the cost lives in files the
 * hook never reads, which is why the live guardrail returns `unknownBlastRadius`
 * and asks. But once you render the plan to JSON (`terraform show -json tfplan`)
 * the priced diff is right there. This module maps each *created* (or replaced)
 * resource to the same catalog and horizon model the command estimator uses, so
 * a plan gets the exact same DENY/ASK treatment a command does.
 *
 * Deliberately NOT wired into the PreToolUse hook: it is an opt-in step
 * (`breakerbox plan plan.json`) so the hot path stays pure string-parsing with
 * no subprocess and no terraform dependency. Coverage over precision, same as
 * the command catalog — an unrecognised resource type is reported as unpriced
 * rather than guessed at.
 */
import {
  EC2, RDS, ELASTICACHE, REDSHIFT, SAGEMAKER, GCE, CLOUD_SQL, AZURE_VM, FIXED,
} from './catalog/prices.js';
import { lookupRate } from './catalog/helpers.js';
import { amount, round } from './util/money.js';

const first = (x) => (Array.isArray(x) ? x[0] : x);
const short = (x) => (x == null ? undefined : String(x).split('/').pop());
const posInt = (x) => {
  const n = Number(x);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
};

/** A table-priced resource: look the shape up, fall back pessimistically. */
function tbl(table, key, qty = 1) {
  const r = lookupRate(table, key);
  return { hourly: r.hourly, oneTime: 0, qty: posInt(qty), confidence: r.confidence, key: key ?? null };
}
/** A flat control-plane / appliance cost. */
function fixed(hourly, qty = 1, key = null) {
  return { hourly, oneTime: 0, qty: posInt(qty), confidence: 'high', key };
}

/**
 * type -> (after) => priced fields. `after` is `change.after` from the plan.
 * Terraform renders nested blocks as arrays, hence the `[0]` hops.
 */
const RULES = {
  // ---- AWS ----
  aws_instance:              (a) => tbl(EC2, a.instance_type),
  aws_spot_instance_request: (a) => tbl(EC2, a.instance_type),
  aws_db_instance:           (a) => tbl(RDS, a.instance_class),
  aws_rds_cluster_instance:  (a) => tbl(RDS, a.instance_class),
  aws_elasticache_cluster:   (a) => tbl(ELASTICACHE, a.node_type, a.num_cache_nodes),
  aws_redshift_cluster:      (a) => tbl(REDSHIFT, a.node_type, a.number_of_nodes),
  aws_sagemaker_notebook_instance: (a) => tbl(SAGEMAKER, a.instance_type),
  aws_eks_cluster:           () => fixed(FIXED['aws.eks.cluster']),
  aws_eks_node_group:        (a) => tbl(EC2, first(a.instance_types), a.scaling_config?.[0]?.desired_size),
  aws_nat_gateway:           () => fixed(FIXED['aws.nat-gateway']),
  aws_lb:                    () => fixed(FIXED['aws.alb']),
  aws_alb:                   () => fixed(FIXED['aws.alb']),
  aws_msk_cluster:           (a) => fixed(FIXED['aws.msk.broker'], a.broker_node_group_info?.[0]?.number_of_broker_nodes),

  // ---- GCP ----
  google_compute_instance:      (a) => tbl(GCE, short(a.machine_type)),
  google_container_cluster:     () => fixed(FIXED['gcp.gke.cluster']),
  google_container_node_pool:   (a) => tbl(GCE, short(a.node_config?.[0]?.machine_type), a.node_count),
  google_sql_database_instance: (a) => tbl(CLOUD_SQL, a.settings?.[0]?.tier),

  // ---- Azure (AKS control plane is free; the node pool is the real cost) ----
  azurerm_linux_virtual_machine:   (a) => tbl(AZURE_VM, a.size),
  azurerm_windows_virtual_machine: (a) => tbl(AZURE_VM, a.size),
  azurerm_virtual_machine:         (a) => tbl(AZURE_VM, a.vm_size),
  azurerm_kubernetes_cluster:      (a) => tbl(AZURE_VM, a.default_node_pool?.[0]?.vm_size, a.default_node_pool?.[0]?.node_count),
  azurerm_kubernetes_cluster_node_pool: (a) => tbl(AZURE_VM, a.vm_size, a.node_count),
};

function providerOf(type) {
  if (type.startsWith('aws_')) return 'aws';
  if (type.startsWith('google_')) return 'gcp';
  if (type.startsWith('azurerm_')) return 'azure';
  return 'unknown';
}

/**
 * Price a parsed `terraform show -json` document.
 *
 * Only resources whose plan action includes `create` are billed — that covers
 * both fresh creates and replaces (`["delete","create"]`). Updates and deletes
 * are left alone: an update *can* raise spend, but pricing that delta reliably
 * is a separate problem, so v1 stays honest about scope rather than guessing.
 */
export function estimatePlan(plan, config) {
  const horizon = config.horizonHours;
  const changes = Array.isArray(plan?.resource_changes) ? plan.resource_changes : [];
  const findings = [];
  let created = 0;
  let unpriced = 0;

  for (const rc of changes) {
    const actions = rc?.change?.actions || [];
    if (!actions.includes('create')) continue; // create or replace only
    created += 1;

    const rule = RULES[rc.type];
    if (!rule) { unpriced += 1; continue; }

    let f;
    try { f = rule(rc.change?.after || {}); } catch { f = null; }
    if (!f || (!f.hourly && !f.oneTime)) { unpriced += 1; continue; }

    const ruleId = `tf.${rc.type}`;
    const override = config.priceOverrides?.[ruleId];
    if (override && typeof override === 'object') {
      if (Number.isFinite(override.hourly)) f.hourly = override.hourly;
      if (Number.isFinite(override.oneTime)) f.oneTime = override.oneTime;
    }

    const perUnit = amount(f.oneTime) + amount(f.hourly) * horizon;
    const charged = round(perUnit * Math.max(1, f.qty));

    findings.push({
      ruleId,
      provider: providerOf(rc.type),
      resource: rc.type,
      address: rc.address,
      label: rc.address || rc.type,
      key: f.key,
      risk: 'medium',
      oneTime: f.oneTime || 0,
      hourly: f.hourly || 0,
      qty: f.qty || 1,
      confidence: f.confidence,
      horizonHours: horizon,
      charged,
      replace: actions.includes('delete'),
    });
  }

  return {
    findings,
    total: round(findings.reduce((s, f) => s + f.charged, 0)),
    matched: findings.length > 0,
    created,
    priced: findings.length,
    unpriced,
    resourceCount: changes.length,
    isPlan: Array.isArray(plan?.resource_changes),
  };
}
