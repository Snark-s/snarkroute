import { afterEach, describe, expect, it, vi } from 'vitest';
import { cepFetch } from './cep-fetch';

describe('native CEP loopback transport', () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  it('keeps ordinary browser requests on fetch', async () => {
    vi.stubGlobal('window', { location: { protocol: 'http:', origin: 'http://localhost' } });
    const fetchImpl = vi.fn(async () => new Response('browser'));
    vi.stubGlobal('fetch', fetchImpl);
    expect(await (await cepFetch('http://127.0.0.1:4317/health')).text()).toBe('browser');
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
  it('never falls back to a null-origin browser request when native Node is unavailable', async () => {
    vi.stubGlobal('window', { __adobe_cep__: {}, location: { protocol: 'file:', origin: 'null' } });
    vi.stubGlobal('cep_node', undefined); vi.stubGlobal('require', undefined);
    const fetchImpl = vi.fn(); vi.stubGlobal('fetch', fetchImpl);
    await expect(cepFetch('http://127.0.0.1:4317/health')).rejects.toThrow(/Native CEP Node transport/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('blocks remote URLs before the native request', async () => {
    vi.stubGlobal('window', { __adobe_cep__: {}, location: { protocol: 'file:', origin: 'null' } });
    const requireNative = vi.fn(); vi.stubGlobal('cep_node', { require: requireNative });
    await expect(cepFetch('https://example.com/model')).rejects.toThrow(/loopback/);
    expect(requireNative).not.toHaveBeenCalled();
  });
});
