import { awsRules } from './aws.js';
import { gcloudRules } from './gcloud.js';
import { azureRules } from './azure.js';
import { iacRules } from './iac.js';
import { genericRules } from './generic.js';

export { PRICES_UPDATED } from './prices.js';

/** Ordered rule list. First match wins, so specific rules precede broad ones. */
export const rules = [
  ...awsRules,
  ...gcloudRules,
  ...azureRules,
  ...iacRules,
  ...genericRules,
];

/** Find the first rule that claims this invocation, or null. */
export function matchRule(argv) {
  for (const rule of rules) {
    try {
      if (rule.test(argv)) return rule;
    } catch {
      // A broken rule must never take the guardrail down with it.
    }
  }
  return null;
}
