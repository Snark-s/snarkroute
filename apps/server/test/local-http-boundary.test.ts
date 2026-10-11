import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerLocalHttpBoundary } from '../src/services/local-http-boundary';

describe('local API browser boundary', () => {
  it('rejects remote origins, null origins and rebinding Host before handlers run', async () => {
    const app = Fastify();
    registerLocalHttpBoundary(app);
    let calls = 0;
    app.post('/model', async () => { calls++; return { ok: true }; });
    for (const headers of [
      { origin: 'https://external.example', host: '127.0.0.1:4317' },
      { origin: 'null', host: '127.0.0.1:4317' },
      { host: 'attacker.example:4317' },
      { host: 'localhost.evil.example:4317' },
      { host: '127.0.0.1:4317', 'sec-fetch-site': 'cross-site' },
    ]) expect((await app.inject({ method: 'POST', url: '/model', headers })).statusCode).toBe(403);
    expect(calls).toBe(0);
    expect((await app.inject({ method: 'POST', url: '/model', headers: { host: '127.0.0.1:4317', origin: 'http://localhost:5172' } })).statusCode).toBe(200);
    expect(calls).toBe(1);
    await app.close();
  });
});
