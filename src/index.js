/** Programmatic API. Everything the CLI does is available here. */
export { parseCommand, splitSegments, tokenize, detectLoop, extractSubstitutions } from './parse.js';
export { estimateCommand } from './estimate.js';
export { decide, summarize } from './policy.js';
export { loadConfig, validateConfig, DEFAULT_CONFIG } from './config.js';
export { rules, matchRule, PRICES_UPDATED } from './catalog/index.js';
export {
  totals, readLedger, reset, append, writePending, commitPending, recentActionCount,
} from './ledger.js';
export { resolveRoot, paths } from './paths.js';
export { runHook } from './hook.js';
