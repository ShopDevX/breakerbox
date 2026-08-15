import { resolveRoot } from '../paths.js';
import { reset, readLedger } from '../ledger.js';
import { c } from '../util/ui.js';

export async function cmdReset(flags = {}) {
  const root = resolveRoot(process.cwd());

  let scope = 'all';
  let sessionId;

  if (flags.session) {
    scope = 'session';
    sessionId = flags.session === true
      ? readLedger(root).filter((e) => e.sessionId).slice(-1)[0]?.sessionId
      : flags.session;
    if (!sessionId) {
      process.stderr.write('No session found to reset. Pass --session <id>, or use --all.\n');
      process.exitCode = 1;
      return;
    }
  } else if (flags.day) {
    scope = 'day';
  } else if (!flags.all) {
    process.stderr.write(
      'Refusing to guess. Pass one of --session [id], --day, or --all.\n',
    );
    process.exitCode = 1;
    return;
  }

  const result = reset(root, { scope, sessionId });
  process.stdout.write(
    `${c.green('reset')}  scope=${result.removed}`
    + `${sessionId ? ` session=${sessionId}` : ''}`
    + `${result.remaining !== undefined ? ` remaining=${result.remaining}` : ''}\n`,
  );
}
