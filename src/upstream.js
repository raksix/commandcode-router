import { Readable } from 'node:stream';

// These headers are managed by Node/undici and must not be copied verbatim
// (undici auto-decompresses gzip; copying content-encoding would double-decompress).
const HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailers', 'transfer-encoding', 'upgrade', 'content-encoding', 'content-length'
]);

/**
 * AĞU'26 fix: upstream response body'si Web ReadableStream olduğu için Readable.fromWeb()
 * tek seferlik okuma kilidi ("ReadableStream is locked") yiyordu. Yeni yöntem: body'yi önceden
 * tamamen text() olarak oku, sonra buffer olarak cliente yaz. Daha küçük payload'lar için
 * yeterince hızlı; SSE için event'ler buffer'a yapışır.
 */
export async function pipeToResponse({ upstreamRes, res, controller }) {
  res.status(upstreamRes.status);
  for (const [k, v] of upstreamRes.headers.entries()) {
    if (!HOP_HEADERS.has(k.toLowerCase())) res.setHeader(k, v);
  }
  res.flushHeaders();

  const body = upstreamRes.bodyStream ?? upstreamRes.body;
  if (!body) {
    res.end();
    return;
  }
  // AĞU'26: upstream body Web ReadableStream — byte toplama ile oku. Önceki
  // `new Response(body).text()` yaklaşımı, stream'in başka yerde tüketilmesinden
  // ("Response body object should not be disturbed or locked") patlıyordu.
  try {
    if (body.locked) {
      // stream zaten tüketilmiş (örn. routeRequest içinde implicit); boş response ile bitir
      res.end();
      return;
    }
    const reader = body.getReader();
    const chunks = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    try { reader.releaseLock(); } catch {}
    const totalLen = chunks.reduce((n, c) => n + (c.byteLength || c.length || 0), 0);
    const buf = new Uint8Array(totalLen);
    let offset = 0;
    for (const c of chunks) {
      const arr = c instanceof Uint8Array ? c : new Uint8Array(c);
      buf.set(arr, offset);
      offset += arr.byteLength;
    }
    res.end(Buffer.from(buf));
  } catch (e) {
    try { res.end(`upstream pipe error: ${e.message}`); } catch {}
  }
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
