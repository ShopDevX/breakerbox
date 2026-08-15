import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveRoot } from '../src/paths.js';

test('finds the project root from a nested subdirectory', () => {
  const base = mkdtempSync(path.join(os.tmpdir(), 'breakerbox-root-'));
  try {
    writeFileSync(path.join(base, 'package.json'), '{}', 'utf8');
    const nested = path.join(base, 'src', 'lib', 'deep');
    mkdirSync(nested, { recursive: true });
    assert.equal(resolveRoot(nested), base);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('never resolves to the home directory', () => {
  // A marker-less temp dir sits under ~ on Windows. Without the home guard this
  // returns ~, and unrelated projects would then share one ledger and one cap.
  const dir = mkdtempSync(path.join(os.tmpdir(), 'breakerbox-root-'));
  try {
    const resolved = resolveRoot(dir);
    assert.notEqual(resolved, path.resolve(os.homedir()));
    assert.equal(resolved, dir, 'a marker-less directory should be its own root');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('two marker-less projects do not share a root', () => {
  const a = mkdtempSync(path.join(os.tmpdir(), 'breakerbox-a-'));
  const b = mkdtempSync(path.join(os.tmpdir(), 'breakerbox-b-'));
  try {
    assert.notEqual(resolveRoot(a), resolveRoot(b));
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

test('prefers a nearer marker over a further one', () => {
  const base = mkdtempSync(path.join(os.tmpdir(), 'breakerbox-root-'));
  try {
    writeFileSync(path.join(base, 'package.json'), '{}', 'utf8');
    const inner = path.join(base, 'packages', 'api');
    mkdirSync(inner, { recursive: true });
    writeFileSync(path.join(inner, 'breakerbox.config.json'), '{}', 'utf8');
    assert.equal(resolveRoot(inner), inner);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
