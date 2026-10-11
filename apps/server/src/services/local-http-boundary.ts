import type { FastifyInstance } from 'fastify';

export function localBrowserOriginAllowed(origin: string | undefined): boolean {
  if (!origin) return true;
  try {
    const url = new URL(origin);
    return ['http:', 'https:'].includes(url.protocol)
      && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      && !url.username && !url.password && url.origin === origin;
  } catch { return false; }
}

export function registerLocalHttpBoundary(app: FastifyInstance): void {
  app.addHook('onRequest', async (request, reply) => {
    const host = request.headers.host;
    try {
      const url = new URL(`http://${host}`);
      if (!host || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
          || url.username || url.password || url.host !== host.toLowerCase().replace(/:80$/, '')) {
        return reply.code(403).send({ code: 'LOCAL_HOST_REJECTED', error: 'Local API requires a loopback Host.' });
      }
    } catch {
      return reply.code(403).send({ code: 'LOCAL_HOST_REJECTED', error: 'Invalid Host.' });
    }
    // A CEP WebSocket still authenticates with a one-use pairing credential or
    // the existing owner token. Its file origin never gains general API access.
    const cepSocket = request.method === 'GET' && request.url.split('?')[0] === '/api/ae-bridge'
      && request.headers.upgrade?.toLowerCase() === 'websocket'
      && request.headers.origin === 'null';
    if ((!localBrowserOriginAllowed(request.headers.origin) && !cepSocket)
        || (request.headers['sec-fetch-site'] === 'cross-site' && !cepSocket)) {
      return reply.code(403).send({ code: 'LOCAL_ORIGIN_REJECTED', error: 'External browser origins cannot access the local API.' });
    }
  });
}
