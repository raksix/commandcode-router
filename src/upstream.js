import { Readable } from 'node:stream';

// These headers are managed by Node/undici and must not be copied verbatim
// (undici auto-decompresses gzip; copying content-encoding would double-decompress).
const HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-encoding', 'content-length'
]);

/**
 * Forward an upstream fetch response to the client.
 * - Copies hop-safe headers, flushes headers immediately (streaming/SSE).
 * - Pipes the body (ReadableStream -> ServerResponse) so SSE events flow through.
 * - Aborts upstream if the client disconnects.
 */
export function pipeToResponse({ upstreamRes, res, controller }) {
  res.status(upstreamRes.status);
  for (const [k, v] of upstreamRes.headers.entries()) {
    if (!HOP_HEADERS.has(k.toLowerCase())) res.setHeader(k, v);
  }
  res.flushHeaders();

  if (!upstreamRes.body) {
    res.end();
    return;
  }
  Readable.fromWeb(upstreamRes.body).pipe(res);
  res.on('close', () => controller.abort());
}

/** Send a buffered body (already-serialized JSON or text) to the client. */
export function sendBuffer({ res, status, headers, bodyBuffer }) {
  res.status(status);
  if (headers) {
    for (const [k, v] of headers.entries()) {
      if (!HOP_HEADERS.has(k.toLowerCase())) res.setHeader(k, v);
    }
  }
  res.setHeader('content-type', headers?.get('content-type') || 'application/json');
  res.end(bodyBuffer);
}
