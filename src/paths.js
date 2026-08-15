import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const MARKERS = ['.breakerbox', 'breakerbox.config.json', '.claude', '.git', 'package.json'];

/**
 * Resolve the project root breakerbox should scope its ledger to.
 *
 * Hook payloads carry `cwd`, which is the directory the agent is working in.
 * We walk up looking for a marker so that a ledger opened from a subdirectory
 * still lands on the same file as one opened from the repo root.
 *
 * The walk stops at the home directory and never considers it a project. `~`
 * usually contains `.claude` and often a stray `package.json`, so without this
 * guard any directory lacking its own marker would resolve to `~` — and every
 * such project would then share a single ledger, letting one project's spend
 * consume another's cap.
 */
export function resolveRoot(startDir) {
  const start = path.resolve(startDir || process.cwd());
  const home = path.resolve(os.homedir() || '');

  let dir = start;
  for (;;) {
    if (dir === home) return start;

    for (const marker of MARKERS) {
      if (existsSync(path.join(dir, marker))) return dir;
    }

    const parent = path.dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}

/** All paths breakerbox reads or writes, derived from a project root. */
export function paths(root) {
  const home = process.env.BREAKERBOX_DIR
    ? path.resolve(process.env.BREAKERBOX_DIR)
    : path.join(root, '.breakerbox');
  return {
    root,
    home,
    ledger: path.join(home, 'ledger.jsonl'),
    pending: path.join(home, 'pending'),
    errors: path.join(home, 'errors.log'),
    localConfig: path.join(home, 'config.json'),
    projectConfig: path.join(root, 'breakerbox.config.json'),
    claudeSettings: path.join(root, '.claude', 'settings.json'),
  };
}
