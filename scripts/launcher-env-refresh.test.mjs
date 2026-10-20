import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { refreshedEnvFileValues } from './launcher-control.mjs';

test('an edited .env reaches the next server start; explicit environment values keep winning', () => {
  const dir = mkdtempSync(join(tmpdir(), 'envrefresh-'));
  try {
    const envPath = join(dir, '.env');
    const atStart = { LOCAL_LLM_BASE_URL: 'http://127.0.0.1:8081/v1', MODE: 'a' };
    writeFileSync(envPath, 'LOCAL_LLM_BASE_URL=http://127.0.0.1:8092/v1\nMODE=b\nNEW_KEY=x\n');
    const current = { LOCAL_LLM_BASE_URL: 'http://127.0.0.1:8081/v1', MODE: 'explicit' };
    assert.deepEqual(refreshedEnvFileValues(envPath, current, atStart), {
      LOCAL_LLM_BASE_URL: 'http://127.0.0.1:8092/v1',
      NEW_KEY: 'x',
    });
    assert.deepEqual(refreshedEnvFileValues(join(dir, 'missing.env'), current, atStart), {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
