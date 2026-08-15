/**
 * A deliberately small shell reader.
 *
 * This is NOT a bash implementation and does not try to be. It exists to answer
 * one question well: "which cost-incurring binaries does this command line
 * invoke, and how many times?" Anything it cannot read confidently is reported
 * as unknown so the policy layer can fail toward asking a human.
 *
 * See README "What this cannot see" for the evasion paths we accept.
 */

const BOOLEAN_FLAGS = new Set([
  '--debug', '--no-verify-ssl', '--no-paginate', '--no-cli-pager', '--version',
  '--help', '-h', '--yes', '-y', '--force', '-f', '--quiet', '-q', '--auto-approve',
  '--dry-run', '--json', '--verbose', '-v', '--no-color', '--recursive',
]);

/** Command prefixes that wrap another command without changing what it costs. */
const TRANSPARENT_PREFIXES = new Set([
  'sudo', 'env', 'time', 'nohup', 'nice', 'command', 'exec', 'doas', 'stdbuf',
]);

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Split a command line into top-level segments, respecting quotes, escapes and
 * parenthesis nesting. Separators (`&&`, `||`, `;`, `|`, `&`, newline) are
 * boundaries; we do not care which one, only that a new command starts.
 */
export function splitSegments(command) {
  const src = String(command ?? '');
  const segments = [];
  let cur = '';
  let quote = null;
  let depth = 0;
  let escaped = false;

  const flush = () => {
    const trimmed = cur.trim();
    if (trimmed) segments.push(trimmed);
    cur = '';
  };

  for (let i = 0; i < src.length; i++) {
    const c = src[i];

    if (escaped) { cur += c; escaped = false; continue; }
    if (c === '\\') { cur += c; escaped = true; continue; }

    if (quote) {
      cur += c;
      // Single quotes are literal in shell, so only a matching quote closes.
      if (c === quote) quote = null;
      continue;
    }

    if (c === "'" || c === '"' || c === '`') { quote = c; cur += c; continue; }
    if (c === '(') { depth++; cur += c; continue; }
    if (c === ')') { depth = Math.max(0, depth - 1); cur += c; continue; }

    if (depth === 0) {
      const two = src.slice(i, i + 2);
      if (two === '&&' || two === '||') { flush(); i++; continue; }
      if (c === ';' || c === '|' || c === '&' || c === '\n') { flush(); continue; }
    }

    cur += c;
  }
  flush();
  return segments;
}

/**
 * Split a single segment into argv, stripping quotes and escapes the way a
 * shell would before the binary sees them.
 */
export function tokenize(segment) {
  const src = String(segment ?? '');
  const out = [];
  let cur = '';
  let started = false;
  let quote = null;
  let escaped = false;

  for (let i = 0; i < src.length; i++) {
    const c = src[i];

    if (escaped) { cur += c; started = true; escaped = false; continue; }
    if (c === '\\' && quote !== "'") { escaped = true; started = true; continue; }

    if (quote) {
      if (c === quote) quote = null;
      else { cur += c; }
      started = true;
      continue;
    }

    if (c === "'" || c === '"') { quote = c; started = true; continue; }

    if (/\s/.test(c)) {
      if (started) { out.push(cur); cur = ''; started = false; }
      continue;
    }

    cur += c;
    started = true;
  }
  if (started) out.push(cur);
  return out;
}

/**
 * Pull the inside of every `$(...)` and backtick substitution so commands
 * hidden inside them still get costed. Without this, `X=$(aws ec2
 * run-instances ...)` reads as a plain variable assignment.
 */
export function extractSubstitutions(command) {
  const src = String(command ?? '');
  const found = [];

  for (let i = 0; i < src.length; i++) {
    if (src[i] === '\\') { i++; continue; }

    if (src[i] === '$' && src[i + 1] === '(') {
      let depth = 1;
      let j = i + 2;
      for (; j < src.length && depth > 0; j++) {
        if (src[j] === '\\') { j++; continue; }
        if (src[j] === '(') depth++;
        else if (src[j] === ')') depth--;
      }
      if (depth === 0) {
        found.push(src.slice(i + 2, j - 1));
        i = j - 1;
      }
      continue;
    }

    if (src[i] === '`') {
      const end = src.indexOf('`', i + 1);
      if (end !== -1) {
        found.push(src.slice(i + 1, end));
        i = end;
      }
    }
  }
  return found;
}

/**
 * Infer how many times a loop body runs.
 *
 * Returns `null` for "unbounded or unreadable" — the policy layer treats that
 * very differently from a known count, because `while true` around a paid API
 * call is the exact shape of the runaway that motivated this tool.
 */
export function detectLoop(tokens) {
  const kind = tokens[0];

  if (kind === 'while' || kind === 'until') {
    return { kind, iterations: null };
  }

  const inIdx = tokens.indexOf('in');
  if (inIdx === -1) return { kind, iterations: null };

  const items = tokens.slice(inIdx + 1).filter((t) => t !== ';' && t !== 'do');
  const joined = items.join(' ');

  // Brace range: {1..50} or {0..100..5}
  const brace = joined.match(/\{(\d+)\.\.(\d+)(?:\.\.(\d+))?\}/);
  if (brace) {
    const from = Number(brace[1]);
    const to = Number(brace[2]);
    const step = brace[3] ? Math.abs(Number(brace[3])) || 1 : 1;
    return { kind, iterations: Math.floor(Math.abs(to - from) / step) + 1 };
  }

  // $(seq ...) in its one, two and three argument forms.
  const seq = joined.match(/\$\(\s*seq\s+([-\d\s]+?)\s*\)/);
  if (seq) {
    const n = seq[1].trim().split(/\s+/).map(Number);
    if (n.every(Number.isFinite)) {
      if (n.length === 1) return { kind, iterations: Math.max(0, n[0]) };
      if (n.length === 2) return { kind, iterations: Math.max(0, n[1] - n[0] + 1) };
      if (n.length === 3) {
        const step = Math.abs(n[1]) || 1;
        return { kind, iterations: Math.max(0, Math.floor(Math.abs(n[2] - n[0]) / step) + 1) };
      }
    }
    return { kind, iterations: null };
  }

  // A literal word list is a reliable count; anything with expansion is not.
  if (items.length && !joined.includes('$') && !joined.includes('*')) {
    return { kind, iterations: items.length };
  }

  return { kind, iterations: null };
}

/** Drop `VAR=x`, `sudo`, `time` and friends so argv[0] is the real binary. */
export function stripPrefixes(tokens) {
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (ENV_ASSIGNMENT.test(t)) { i++; continue; }
    if (TRANSPARENT_PREFIXES.has(t)) { i++; continue; }
    break;
  }
  return tokens.slice(i);
}

/** True when `flag` is known to take no value, so the next token is positional. */
export function isBooleanFlag(flag) {
  return BOOLEAN_FLAGS.has(flag);
}

/**
 * Parse a command line into the invocations it performs.
 *
 * Each invocation carries the loop context it sits inside, so the estimator can
 * multiply. `depth` guards against pathological nesting.
 */
export function parseCommand(command, depth = 0) {
  const invocations = [];
  const src = String(command ?? '');
  if (!src.trim() || depth > 4) return { invocations, source: src };

  const segments = splitSegments(src);
  let loop = null;
  let loopDepth = 0;

  for (const segment of segments) {
    // A subshell is just another command line; recurse and inherit the loop.
    if (segment.startsWith('(') && segment.endsWith(')')) {
      const inner = parseCommand(segment.slice(1, -1), depth + 1);
      for (const inv of inner.invocations) {
        invocations.push({ ...inv, loop: inv.loop || loop });
      }
      continue;
    }

    let tokens = tokenize(segment);
    if (!tokens.length) continue;

    // `do` and `then` can lead a segment once the separator has been consumed.
    while (tokens.length && (tokens[0] === 'do' || tokens[0] === 'then')) tokens = tokens.slice(1);
    if (!tokens.length) continue;

    const head = tokens[0];

    if (head === 'for' || head === 'while' || head === 'until') {
      const detected = detectLoop(tokens);
      // Nested loops multiply; an unbounded outer loop stays unbounded.
      if (loop) {
        const a = loop.iterations;
        const b = detected.iterations;
        loop = { kind: detected.kind, iterations: a === null || b === null ? null : a * b };
      } else {
        loop = detected;
      }
      loopDepth++;
      continue;
    }

    if (head === 'done' || head === 'fi') {
      loopDepth = Math.max(0, loopDepth - 1);
      if (loopDepth === 0) loop = null;
      continue;
    }

    if (head === 'if' || head === 'elif' || head === 'else') {
      tokens = tokens.slice(1);
      if (!tokens.length) continue;
    }

    const argv = stripPrefixes(tokens);
    if (!argv.length) continue;

    invocations.push({ argv, raw: segment, loop });
  }

  // Commands hidden inside substitutions still run, so cost them too.
  for (const sub of extractSubstitutions(src)) {
    const inner = parseCommand(sub, depth + 1);
    for (const inv of inner.invocations) {
      invocations.push({ ...inv, substituted: true });
    }
  }

  return { invocations, source: src };
}
