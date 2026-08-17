import { Router } from 'express';
import { data, markDirty } from '../store.js';
import { requireMasterKey } from '../auth.js';
import { mapModel } from '../modelmap.js';
import { routeRequest, pickAccount, addLog, recordTokens } from '../pool.js';
import { pipeToResponse, sendBuffer } from '../upstream.js';
import { isOssModel, anthropicToOpenAI, openAIToAnthropic, openAISToAnthropicSSE, extractOpenAIUsage } from '../convert.js';

const UPSTREAM_BASE = 'https://api.commandcode.ai/provider';

export const proxyRouter = Router();

// Auth: every /v1/* request must carry the master key
proxyRouter.use('/v1', requireMasterKey);

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
  // query string'i ayır — Claude Code /v1/messages?beta=true şeklinde istek atıyor
  const [pathname, query = ''] = req.originalUrl.split('?');
  const route = pathname;
  const started = Date.now();

  // apply model mapping on message bodies
  let body = req.body ?? {};
  let rawBody = null;
  let mappedTo = null;
  let convertOss = false;      // OSS model -> /v1/chat/completions + format dönüşümü
  let upstreamRoute = route;   // yönlendirilirse değişir (/v1/messages -> /v1/chat/completions)
  if (req.method === 'POST' && (route.includes('/messages') || route.includes('/chat/completions'))) {
    if (typeof body === 'object' && body !== null) {
      const mapped = mapModel(body.model, data.config, data.state);
      if (mapped !== body.model) {
        mappedTo = body.model;
        body.model = mapped;
      }
      // OSS model (deepseek/gpt/...) ise Anthropic endpoint'i kabul etmiyor ->
      // chat/completions'a yönlendir + gövdeyi OpenAI formatına çevir
      if (isOssModel(body.model) && route.endsWith('/v1/messages')) {
        convertOss = true;
        upstreamRoute = route.replace(/\/v1\/messages$/, '/v1/chat/completions');
        body = anthropicToOpenAI(body);
      }
      rawBody = JSON.stringify(body);
    }
  }

  const controller = new AbortController();
  const signal = controller.signal;
  res.on('close', () => controller.abort());

  const result = await routeRequest({
    url: UPSTREAM_BASE + upstreamRoute + (query ? `?${query}` : ''), // OSS'de upstreamRoute /v1/chat/completions olur
    method: req.method,
    headers: pickForwardHeaders(req),
    body: req.method === 'GET' || req.method === 'HEAD' ? undefined : (rawBody ?? JSON.stringify(body)),
    signal,
    route: upstreamRoute
  });

  // request log (panelde görünür)
  const log = addLog({
    method: req.method,
    route: upstreamRoute,
    model: body.model ?? req.body?.model,
    mappedTo,
    account: result.account?.name ?? null,
    status: result.status,
    ok: result.status >= 200 && result.status < 300,
    ms: Date.now() - started,
    detail: result.status >= 400 ? String(result.bodyBuffer ?? result.body ?? '').slice(0, 120) : null
  });

  if (convertOss) {
    // OpenAI yanıtını Anthropic formatına çevir
    if (result.bodyStream) {
      // stream: SSE event'lerini dönüştürerek pipe et (bitince log'a token yazar)
      pipeConvertedStream({ upstreamRes: result, res, signal, log });
    } else {
      let payload = result.bodyBuffer ?? JSON.stringify(result.body ?? {});
      try {
        const oj = typeof payload === 'string' ? JSON.parse(payload) : payload;
        // token istatistikleri (OpenAI usage)
        if (oj.usage) {
          recordTokens({ inputTokens: oj.usage.prompt_tokens, outputTokens: oj.usage.completion_tokens });
          log.inputTokens = oj.usage.prompt_tokens ?? null;
          log.outputTokens = oj.usage.completion_tokens ?? null;
          markDirty();
        }
        payload = JSON.stringify(openAIToAnthropic(oj));
      } catch {}
      sendBuffer({
        res,
        status: result.status,
        headers: new Headers({ 'content-type': 'application/json' }),
        bodyBuffer: payload
      });
    }
  } else {
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
  }
});

// OpenAI SSE stream -> Anthropic SSE stream pipe
function pipeConvertedStream({ upstreamRes, res, signal, log }) {
  res.status(upstreamRes.status);
  res.setHeader('content-type', 'text/event-stream');
  res.setHeader('cache-control', 'no-cache');
  res.setHeader('connection', 'keep-alive');
  res.flushHeaders();

  if (!upstreamRes.body) {
    res.end();
    return;
  }

  const reader = upstreamRes.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';
  let started = false; // Anthropic message_start + content_block_start gönderildi mi?
  let modelName = null;
  let usage = null; // stream'den çıkarılan token kullanımı

  // İlk geçerli data bloğunda Anthropic stream başlangıcı (message_start + content_block_start)
  const ensureStarted = (chunkText) => {
    if (started) return;
    try {
      const lines = chunkText.split('\n');
      for (const line of lines) {
        if (line.startsWith('data:') && line !== 'data: [DONE]') {
          const j = JSON.parse(line.slice(5));
          if (j.model) modelName = j.model;
        }
      }
    } catch {}
    const msgStart = JSON.stringify({
      type: 'message_start',
      message: {
        id: 'msg_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
        type: 'message', role: 'assistant', model: modelName || '',
        content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 }
      }
    });
    const blockStart = JSON.stringify({
      type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' }
    });
    res.write(encoder.encode(`data: ${msgStart}\n\ndata: ${blockStart}\n\n`));
    started = true;
  };

  const pump = () => {
    reader.read().then(({ done, value }) => {
      if (done) {
        // son buffer'ı da işle (tamamlanmamış event varsa)
        if (buffer.trim()) {
          const converted = openAISToAnthropicSSE(buffer);
          if (converted) {
            ensureStarted(buffer);
            res.write(encoder.encode(converted));
          }
        }
        // token istatistikleri
        const u = usage || extractOpenAIUsage(buffer);
        if (u) {
          recordTokens({ inputTokens: u.prompt_tokens, outputTokens: u.completion_tokens });
          if (log) {
            log.inputTokens = u.prompt_tokens ?? null;
            log.outputTokens = u.completion_tokens ?? null;
            markDirty();
          }
        }
        res.end();
        return;
      }
      buffer += decoder.decode(value, { stream: true });
      // `\n\n` ile ayrık event bloklarını işle
      const blocks = buffer.split('\n\n');
      buffer = blocks.pop(); // son blok eksik olabilir
      for (const b of blocks) {
        if (!b.trim()) continue;
        const u = extractOpenAIUsage(b);
        if (u) usage = u;
        const converted = openAISToAnthropicSSE(b);
        if (!converted) {
          // SSE parse edilemedi (örn. hata gövdesi) -> ham geç
          res.write(encoder.encode(b + '\n\n'));
          continue;
        }
        ensureStarted(b);
        res.write(encoder.encode(converted));
      }
      pump();
    }).catch((err) => {
      try { res.end(); } catch {}
    });
  };
  pump();

  res.on('close', () => {
    try { reader.cancel(); } catch {}
    signal.abort();
  });
}

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
