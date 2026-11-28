import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

/**
 * `admin:list` diagnostic tests.
 *
 * The problem it solves: a deployed console showed "Sign-in failed" with no way
 * to tell whether an account existed, so the only diagnosis available was to
 * guess. The command must therefore report the same storage engine the server
 * resolves, and must distinguish "no admin" from "admin exists but MFA is
 * pending" without ever printing a credential.
 */

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ws-list-'));
}

function runList(env: Record<string, string>): { status: number; out: string } {
  try {
    const out = execFileSync('npx', ['tsx', 'server/admin/list_admins.ts'], {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120000
    });
    return { status: 0, out };
  } catch (err: any) {
    return { status: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

test('admin:list reports an empty store and points at the bootstrap command', () => {
  const { status, out } = runList({ DATA_DIR: tmpDir(), STORAGE_ENGINE: 'json' });

  assert.equal(status, 0);
  assert.match(out, /Administrators: 0/);
  assert.match(out, /npm run admin:bootstrap/);
});

test('admin:list reports the storage engine the server would use', () => {
  const { status, out } = runList({ DATA_DIR: tmpDir(), STORAGE_ENGINE: 'json' });

  assert.equal(status, 0);
  assert.match(out, /Storage engine: json/);
});

test('admin:list refuses to fall back when postgres has no connection string', () => {
  const env = { ...process.env };
  delete env.DATABASE_URL;
  const { status, out } = runList({ ...env, DATA_DIR: tmpDir(), STORAGE_ENGINE: 'postgres' });

  assert.notEqual(status, 0);
  assert.match(out, /DATABASE_URL is required/);
});
