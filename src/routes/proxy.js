import { Router } from 'express';
import { data, markDirty } from '../store.js';
import { requireMasterKey } from '../auth.js';
import { mapModel } from '../modelmap.js';
import { routeRequest, pickAccount } from '../pool.js';
import { pipeToResponse, sendBuffer } from '../upstream.js';

const UPSTREAM_BASE = 'https://api.commandcode.ai/provider';

export const proxyRouter = Router();

// Auth: every /v1/* request must carry the master key
proxyRouter.use('/v1', requireMasterKey);

// Rebuild upstream URL: originalUrl keeps the full /v1/... path.
function upstreamUrl(req) {
  return UPSTREAM_BASE + req.originalUrl;
}

// ---- GET /v1/models (cached 5 min; config'te exposedModels varsa filtreler) ----
proxyRouter.get('/v1/models', async (req, res) => {
  const now = Date.now();
  const cache = data.state.modelsCache;
  const ttl = (data.config.modelsCacheTtlSec ?? 300) * 1000;

  const sendJson = (body, status = 200) => {
    sendBuffer({
      res, status,
      headers: new Headers({ 'content-type': 'application/json' }),
      bodyBuffer: JSON.stringify(body)
    });
  };

  // --- taze çek (cache'li) ---
  let upstreamText = null;
  if (cache.data && cache.at && now - cache.at < ttl) {
    upstreamText = cache.data;
  } else {
    const account = pickAccount();
    if (!account) {
      sendJson({ error: 'aktif hesap yok' }, 503);
      return;
    }
    try {
      const up = await fetch(UPSTREAM_BASE + '/v1/models', {
        headers: { authorization: `Bearer ${account.apiKey}` }
      });
      upstreamText = await up.text();
      if (up.ok) {
        cache.data = upstreamText;
        cache.at = now;
        markDirty();
      } else {
        sendJson({ error: 'models alınamadı' }, up.status);
        return;
      }
    } catch (err) {
      sendJson({ error: `models alınamadı: ${err.message}` }, 502);
      return;
    }
  }

  // --- exposedModels filtresi ---
  const exposed = data.config.exposedModels || [];
  if (!exposed.length) {
    // boşsa hepsi aynen döner (cache'teki ham gövde)
    sendBuffer({
      res, status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      bodyBuffer: upstreamText
    });
    return;
  }

  // doluysa: CommandCode modellerini çek, sadece exposed olanları sun
  let allModels = [];
  try { allModels = JSON.parse(upstreamText).data ?? []; } catch { allModels = []; }
  const allowed = new Set(exposed);
  const filtered = allModels.filter((m) => allowed.has(m.id));
  // exposed'ta olup CommandCode'da bulunamayanları da ekle (API tutarlı olsun)
  for (const id of exposed) {
    if (!filtered.some((m) => m.id === id)) {
      filtered.push({ id, object: 'model', created: 0, owned_by: 'command-code', name: id, context_length: null });
    }
  }
  sendJson({ object: 'list', data: filtered });
});

// ---- any other /v1/* request -> passthrough (POST /v1/messages, chat/completions, etc.) ----
proxyRouter.use('/v1', async (req, res) => {
  const route = req.originalUrl;

  // apply model mapping on message bodies
  let body = req.body ?? {};
  let rawBody = null;
  if (req.method === 'POST' && (route.includes('/messages') || route.includes('/chat/completions'))) {
    if (typeof body === 'object' && body !== null) {
      const mapped = mapModel(body.model, data.config);
      if (mapped !== body.model) body.model = mapped;
      rawBody = JSON.stringify(body);
    }
  }

  const controller = new AbortController();
  const signal = controller.signal;
  res.on('close', () => controller.abort());

  const result = await routeRequest({
    url: upstreamUrl(req),
    method: req.method,
    headers: pickForwardHeaders(req),
    body: req.method === 'GET' || req.method === 'HEAD' ? undefined : (rawBody ?? JSON.stringify(body)),
    signal,
    route
  });

  if (result.bodyStream) {
    pipeToResponse({ upstreamRes: result, res, signal });
  } else {
    sendBuffer({
      res,
      status: result.status,
      headers: result.headers,
      bodyBuffer: result.bodyBuffer ?? JSON.stringify(result.body ?? {})
    });
  }
});

// forward all headers except ones the proxy must own
function pickForwardHeaders(req) {
  const h = { ...req.headers };
  delete h.host;
  delete h['content-length'];
  delete h['content-encoding'];
  delete h.connection;
  delete h.authorization; // replaced by pool with the selected account key
  return h;
}
