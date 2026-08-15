import { runHook } from './hook.js';
import { cmdInit } from './commands/init.js';
import { cmdStatus } from './commands/status.js';
import { cmdLog } from './commands/log.js';
import { cmdCheck } from './commands/check.js';
import { cmdReset } from './commands/reset.js';
import { cmdDoctor } from './commands/doctor.js';
import { c } from './util/ui.js';

const HELP = `
${c.bold('breakerbox')} — hard spend caps and a kill-switch for what your AI agent runs.

${c.bold('Usage')}
  breakerbox <command> [options]

${c.bold('Commands')}
  init [--global] [--force]   Install the PreToolUse/PostToolUse hooks and write a config
  check "<command>"           Dry-run: what would breakerbox decide about this command?
  status                      Spend against each cap right now
  log [-n 20] [--json]        Recent committed actions
  reset [--session <id>]      Clear ledger state (--day, --all)
  doctor                      Verify the install end to end
  hook                        Internal: read a hook payload on stdin

${c.bold('Options for check')}
  --mode <mode>               Simulate a permission_mode (e.g. bypassPermissions)
  --json                      Machine-readable output

${c.bold('Examples')}
  breakerbox init
  breakerbox check "aws ec2 run-instances --instance-type p4d.24xlarge --count 4"
  breakerbox check "for i in {1..50}; do aws ec2 run-instances --instance-type t3.micro; done"
  breakerbox status
`;

/** Minimal flag parser: --key value, --key=value, --flag, -n 5. */
export function parseArgs(argv) {
  const flags = {};
  const positional = [];

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--') { positional.push(...argv.slice(i + 1)); break; }

    if (token.startsWith('--')) {
      const [key, inline] = token.slice(2).split(/=(.*)/s);
      if (inline !== undefined) { flags[key] = inline; continue; }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-')) { flags[key] = next; i++; }
      else flags[key] = true;
      continue;
    }

    if (token.startsWith('-') && token.length > 1) {
      const key = token.slice(1);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-')) { flags[key] = next; i++; }
      else flags[key] = true;
      continue;
    }

    positional.push(token);
  }

  return { flags, positional };
}

export async function main(argv) {
  const [command, ...rest] = argv;
  const { flags, positional } = parseArgs(rest);

  switch (command) {
    case 'hook':
      return runHook();
    case 'init':
      return cmdInit(flags);
    case 'check':
      return cmdCheck(positional, flags);
    case 'status':
      return cmdStatus(flags);
    case 'log':
      return cmdLog(flags);
    case 'reset':
      return cmdReset(flags);
    case 'doctor':
      return cmdDoctor(flags);
    case 'version':
    case '--version':
    case '-v':
      process.stdout.write('0.1.0\n');
      return undefined;
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(`${HELP}\n`);
      return undefined;
    default:
      process.stderr.write(`Unknown command: ${command}\n${HELP}\n`);
      process.exitCode = 1;
      return undefined;
  }
}
