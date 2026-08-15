#!/usr/bin/env node
import { main } from '../src/cli.js';

main(process.argv.slice(2)).catch((err) => {
  process.stderr.write(`breakerbox: ${err?.message || err}\n`);
  process.exit(1);
});
