import { matches, hasFlag, estimate } from './helpers.js';

/**
 * Infrastructure-as-code apply commands are the highest-leverage thing an agent
 * can run: one line, arbitrary spend, and the cost lives in files we are not
 * reading. Every rule here reports `unknownBlastRadius` so the policy layer
 * escalates rather than guessing a number.
 */
export const iacRules = [
  {
    id: 'iac.terraform.apply',
    test: (argv) => matches(argv, ['terraform', 'apply']) || matches(argv, ['tofu', 'apply']),
    build: (argv) => estimate({
      ruleId: 'iac.terraform.apply',
      provider: 'terraform',
      label: hasFlag(argv, '--auto-approve', '-auto-approve')
        ? 'terraform apply (auto-approved)'
        : 'terraform apply',
      risk: 'high',
      confidence: 'low',
      unknownBlastRadius: true,
      note: 'Spend is defined by the plan, not the command. Review the plan output before approving.',
    }),
  },
  {
    id: 'iac.terraform.destroy',
    test: (argv) => matches(argv, ['terraform', 'destroy']) || matches(argv, ['tofu', 'destroy']),
    build: () => estimate({
      ruleId: 'iac.terraform.destroy',
      provider: 'terraform',
      label: 'terraform destroy',
      risk: 'high',
      confidence: 'high',
      unknownBlastRadius: true,
      note: 'Reduces spend but destroys state. Flagged for the same reason as apply: unbounded effect.',
    }),
  },
  {
    id: 'iac.pulumi.up',
    test: (argv) => matches(argv, ['pulumi', 'up']) || matches(argv, ['pulumi', 'destroy']),
    build: () => estimate({
      ruleId: 'iac.pulumi.up',
      provider: 'pulumi',
      label: 'pulumi up/destroy',
      risk: 'high',
      confidence: 'low',
      unknownBlastRadius: true,
    }),
  },
  {
    id: 'iac.cdk.deploy',
    test: (argv) => matches(argv, ['cdk', 'deploy']) || matches(argv, ['cdk', 'destroy']),
    build: () => estimate({
      ruleId: 'iac.cdk.deploy',
      provider: 'aws',
      label: 'cdk deploy/destroy',
      risk: 'high',
      confidence: 'low',
      unknownBlastRadius: true,
    }),
  },
  {
    id: 'iac.sam.deploy',
    test: (argv) => matches(argv, ['sam', 'deploy']),
    build: () => estimate({
      ruleId: 'iac.sam.deploy',
      provider: 'aws',
      label: 'sam deploy',
      risk: 'medium',
      confidence: 'low',
      unknownBlastRadius: true,
    }),
  },
  {
    id: 'iac.serverless.deploy',
    test: (argv) => matches(argv, ['serverless', 'deploy']) || matches(argv, ['sls', 'deploy']),
    build: () => estimate({
      ruleId: 'iac.serverless.deploy',
      provider: 'aws',
      label: 'serverless deploy',
      risk: 'medium',
      confidence: 'low',
      unknownBlastRadius: true,
    }),
  },
  {
    id: 'iac.helm.install',
    test: (argv) => matches(argv, ['helm', 'install']) || matches(argv, ['helm', 'upgrade']),
    build: () => estimate({
      ruleId: 'iac.helm.install',
      provider: 'kubernetes',
      label: 'helm install/upgrade',
      risk: 'medium',
      confidence: 'low',
      unknownBlastRadius: true,
      note: 'Charts can request LoadBalancers and PersistentVolumes, which bill at the cloud layer.',
    }),
  },
];
