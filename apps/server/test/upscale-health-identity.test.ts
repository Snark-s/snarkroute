import { afterEach, describe, expect, it, vi } from 'vitest';
import { readLocalUpscaleStatus } from '../src/services/local-upscale-local';
describe('local upscale service identity', () => {
  afterEach(() => { vi.unstubAllEnvs(); });
  it('rejects a foreign 404 and sends no authenticated runtime request', async () => {
    vi.stubEnv('LOCAL_UPSCALE_WORKER_TOKEN', 'fixture');
    const fetchImpl = vi.fn(async () => new Response('{}', { status:404 }));
    expect(await readLocalUpscaleStatus({ fetchImpl })).toMatchObject({ state:'error', online:true });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
  it('does not label a hung listener stopped or authorize a duplicate start', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('timeout'); });
    expect(await readLocalUpscaleStatus({ fetchImpl, portListening:async () => true })).toMatchObject({state:'error',online:true});
  });
});
