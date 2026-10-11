/** File-origin CEP panels use their native Node transport, never a CORS exception. */
export const cepFetch: typeof fetch = async (input, init = {}) => {
  const runtime = globalThis as typeof globalThis & {
    cep_node?: { require(name: string): any }; require?: (name: string) => any;
  };
  const isCepFile = typeof window !== 'undefined' && window.__adobe_cep__
    && (window.location.protocol === 'file:' || window.location.origin === 'null');
  if (!isCepFile) return globalThis.fetch(input, init);
  const requireNative = runtime.cep_node?.require?.bind(runtime.cep_node) ?? runtime.require;
  if (!requireNative) throw new Error('Native CEP Node transport is unavailable. Enable Node for this extension.');
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      || url.username || url.password) throw new Error('Native CEP transport requires a loopback SnarkRoute URL.');
  const headers = new Headers(init.headers);
  headers.delete('origin'); headers.delete('host'); headers.delete('cookie');
  const buffer = requireNative('buffer').Buffer;
  let body: any;
  if (init.body instanceof FormData) {
    const boundary = `snarkroute-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const parts: any[] = [];
    for (const [name, value] of init.body.entries()) {
      const escapedName = name.replace(/["\r\n]/g, '_');
      parts.push(buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${escapedName}"`));
      if (typeof value === 'string') parts.push(buffer.from(`\r\n\r\n${value}\r\n`));
      else {
        const filename = value.name.replace(/["\r\n]/g, '_');
        parts.push(buffer.from(`; filename="${filename}"\r\nContent-Type: ${value.type || 'application/octet-stream'}\r\n\r\n`));
        parts.push(buffer.from(await value.arrayBuffer()), buffer.from('\r\n'));
      }
    }
    parts.push(buffer.from(`--${boundary}--\r\n`)); body = buffer.concat(parts);
    headers.set('content-type', `multipart/form-data; boundary=${boundary}`);
  } else if (init.body != null) {
    if (typeof init.body === 'string' || init.body instanceof URLSearchParams) body = buffer.from(String(init.body));
    else if (init.body instanceof Blob) body = buffer.from(await init.body.arrayBuffer());
    else if (init.body instanceof ArrayBuffer || ArrayBuffer.isView(init.body)) body = buffer.from(init.body as any);
    else throw new Error('Unsupported native CEP request body.');
  }
  if (body) headers.set('content-length', String(body.length));
  return new Promise<Response>((resolve, reject) => {
    const transport = requireNative(url.protocol === 'https:' ? 'https' : 'http');
    const request = transport.request(url.href, { method: init.method ?? 'GET', headers: Object.fromEntries(headers.entries()) }, (response: any) => {
      const parts: any[] = []; let size = 0;
      response.on('data', (chunk: any) => {
        size += chunk.length;
        if (size > 250 * 1024 * 1024) request.destroy(new Error('Native CEP response exceeds the local limit.'));
        else parts.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => resolve(new Response(response.statusCode === 204 ? null : buffer.concat(parts), {
        status: response.statusCode, statusText: response.statusMessage,
        headers: Object.fromEntries(Object.entries(response.headers).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
      })));
    });
    const abort = () => request.destroy(new Error('Native CEP request aborted.'));
    if (init.signal?.aborted) { abort(); reject(new Error('Native CEP request aborted.')); return; }
    init.signal?.addEventListener('abort', abort, { once: true });
    request.on('close', () => init.signal?.removeEventListener('abort', abort));
    request.on('error', reject);
    request.setTimeout(120_000, () => request.destroy(new Error('Native CEP request timed out.')));
    if (body) request.write(body);
    request.end();
  });
};
