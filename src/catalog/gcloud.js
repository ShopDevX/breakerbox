import { matches, flag, intFlag, lookupRate, estimate } from './helpers.js';
import { GCE, CLOUD_SQL, FIXED } from './prices.js';

/** `gcloud compute instances create a b c` takes N positional names. */
function countPositionalNames(argv, afterWords) {
  let seen = 0;
  let wordIndex = 0;
  let skipNext = false;
  let names = 0;

  for (let i = 1; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith('-')) {
      skipNext = !token.includes('=');
      continue;
    }
    if (skipNext) { skipNext = false; continue; }
    if (wordIndex < afterWords.length && token === afterWords[wordIndex]) {
      wordIndex++;
      seen = wordIndex;
      continue;
    }
    if (seen === afterWords.length) names++;
  }
  return Math.max(1, names);
}

export const gcloudRules = [
  {
    id: 'gcp.compute.instances.create',
    test: (argv) => matches(argv, ['gcloud', 'compute', 'instances', 'create']),
    build: (argv) => {
      const type = flag(argv, '--machine-type');
      const count = countPositionalNames(argv, ['compute', 'instances', 'create']);
      const { hourly, confidence } = lookupRate(GCE, type, { cpuDefault: 0.15 });
      return estimate({
        ruleId: 'gcp.compute.instances.create',
        provider: 'gcp',
        label: `GCE ${type || 'instance'} x${count}`,
        risk: 'high',
        hourly,
        qty: count,
        confidence,
      });
    },
  },
  {
    id: 'gcp.container.clusters.create',
    test: (argv) => matches(argv, ['gcloud', 'container', 'clusters', 'create'])
      || matches(argv, ['gcloud', 'container', 'clusters', 'create-auto']),
    build: (argv) => {
      const type = flag(argv, '--machine-type');
      const nodes = intFlag(argv, ['--num-nodes'], 3);
      const { hourly } = lookupRate(GCE, type, { cpuDefault: 0.15 });
      return estimate({
        ruleId: 'gcp.container.clusters.create',
        provider: 'gcp',
        label: `GKE cluster (${nodes} nodes)`,
        risk: 'high',
        hourly: FIXED['gcp.gke.cluster'] + hourly * nodes,
        confidence: 'low',
        note: 'Cluster management fee plus estimated node pool.',
      });
    },
  },
  {
    id: 'gcp.sql.instances.create',
    test: (argv) => matches(argv, ['gcloud', 'sql', 'instances', 'create']),
    build: (argv) => {
      const tier = flag(argv, '--tier');
      const { hourly, confidence } = lookupRate(CLOUD_SQL, tier, { cpuDefault: 0.15 });
      return estimate({
        ruleId: 'gcp.sql.instances.create',
        provider: 'gcp',
        label: `Cloud SQL ${tier || 'instance'}`,
        risk: 'high',
        hourly,
        confidence,
      });
    },
  },
  {
    id: 'gcp.deployment-manager',
    test: (argv) => matches(argv, ['gcloud', 'deployment-manager', 'deployments', 'create']),
    build: () => estimate({
      ruleId: 'gcp.deployment-manager',
      provider: 'gcp',
      label: 'Deployment Manager deployment',
      risk: 'high',
      confidence: 'low',
      unknownBlastRadius: true,
      note: 'Template contents determine spend; not readable from the command line.',
    }),
  },
  {
    id: 'gcp.dataproc.clusters.create',
    test: (argv) => matches(argv, ['gcloud', 'dataproc', 'clusters', 'create']),
    build: (argv) => {
      const workers = intFlag(argv, ['--num-workers'], 2);
      return estimate({
        ruleId: 'gcp.dataproc.clusters.create',
        provider: 'gcp',
        label: `Dataproc cluster (${workers} workers)`,
        risk: 'high',
        hourly: 0.15 * (workers + 1),
        confidence: 'low',
      });
    },
  },
  {
    id: 'gcp.run.deploy',
    test: (argv) => matches(argv, ['gcloud', 'run', 'deploy']),
    build: (argv) => estimate({
      ruleId: 'gcp.run.deploy',
      provider: 'gcp',
      label: 'Cloud Run service',
      risk: 'low',
      hourly: intFlag(argv, ['--min-instances'], 0) * 0.03,
      confidence: 'low',
      note: 'Scale-to-zero services cost nothing idle; --min-instances is the billable floor.',
    }),
  },
];
