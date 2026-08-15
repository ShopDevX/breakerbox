import { matches, flag, intFlag, lookupRate, estimate } from './helpers.js';
import { AZURE_VM, FIXED } from './prices.js';

export const azureRules = [
  {
    id: 'azure.vm.create',
    test: (argv) => matches(argv, ['az', 'vm', 'create']),
    build: (argv) => {
      const size = flag(argv, '--size');
      const count = intFlag(argv, ['--count'], 1);
      const { hourly, confidence } = lookupRate(AZURE_VM, size, { cpuDefault: 0.2 });
      return estimate({
        ruleId: 'azure.vm.create',
        provider: 'azure',
        label: `Azure VM ${size || '(size unspecified)'} x${count}`,
        risk: 'high',
        hourly,
        qty: count,
        confidence,
      });
    },
  },
  {
    id: 'azure.vmss.create',
    test: (argv) => matches(argv, ['az', 'vmss', 'create']),
    build: (argv) => {
      const size = flag(argv, '--vm-sku');
      const count = intFlag(argv, ['--instance-count'], 2);
      const { hourly, confidence } = lookupRate(AZURE_VM, size, { cpuDefault: 0.2 });
      return estimate({
        ruleId: 'azure.vmss.create',
        provider: 'azure',
        label: `VM scale set x${count}`,
        risk: 'high',
        hourly,
        qty: count,
        confidence,
      });
    },
  },
  {
    id: 'azure.aks.create',
    test: (argv) => matches(argv, ['az', 'aks', 'create']),
    build: (argv) => {
      const size = flag(argv, '--node-vm-size');
      const nodes = intFlag(argv, ['--node-count'], 3);
      const { hourly } = lookupRate(AZURE_VM, size, { cpuDefault: 0.2 });
      return estimate({
        ruleId: 'azure.aks.create',
        provider: 'azure',
        label: `AKS cluster (${nodes} nodes)`,
        risk: 'high',
        hourly: FIXED['azure.aks.cluster'] + hourly * nodes,
        confidence: 'low',
      });
    },
  },
  {
    id: 'azure.sql.create',
    test: (argv) => matches(argv, ['az', 'sql', 'db', 'create'])
      || matches(argv, ['az', 'postgres', 'server', 'create'])
      || matches(argv, ['az', 'mysql', 'server', 'create']),
    build: () => estimate({
      ruleId: 'azure.sql.create',
      provider: 'azure',
      label: 'Azure managed database',
      risk: 'high',
      hourly: 0.25,
      confidence: 'low',
    }),
  },
  {
    id: 'azure.deployment.create',
    test: (argv) => matches(argv, ['az', 'deployment', 'group', 'create'])
      || matches(argv, ['az', 'deployment', 'sub', 'create']),
    build: () => estimate({
      ruleId: 'azure.deployment.create',
      provider: 'azure',
      label: 'ARM/Bicep deployment',
      risk: 'high',
      confidence: 'low',
      unknownBlastRadius: true,
      note: 'Template contents determine spend; not readable from the command line.',
    }),
  },
];
