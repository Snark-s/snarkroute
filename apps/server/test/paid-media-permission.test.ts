import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultH3QueueRuntime } from '../src/services/h3-session-runtime';
import { assertPaidOperationPermission } from '../src/services/paid-operation-permission';
import type { H3QueueItem } from '../src/services/h3-queue';

describe('convenience media APIs preserve paid permission', () => {
  afterEach(() => vi.unstubAllEnvs());
  it('rejects permission strings and missing permission', () => {
    vi.stubEnv('APP_MODE', 'local');
    for (const value of [undefined, false, 'true', 1]) expect(() => assertPaidOperationPermission(value, 'worldlabs-marble')).toThrow(/explicit permission/);
    expect(() => assertPaidOperationPermission(true, 'worldlabs-marble')).not.toThrow();
  });
  it('never rents GPU or calls a hosted model without permission', async () => {
    vi.stubEnv('APP_MODE', 'local');
    const fetchImpl = vi.fn(() => { throw new Error('provider request must not occur'); });
    const runtime = createDefaultH3QueueRuntime({ fetchImpl: fetchImpl as typeof fetch });
    const item = { operation: 'text2video', modelVariant: 'h3_max' } as H3QueueItem;
    await expect(runtime.acquire('provider', async () => {}, [item])).rejects.toThrow(/explicit permission/);
    await expect(runtime.acquire('vast', async () => {}, [{ ...item, modelVariant:'h3_base' }])).rejects.toThrow(/explicit permission/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
