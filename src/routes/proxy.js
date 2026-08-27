import { Router } from 'express';
import { data, markDirty } from '../store.js';
import { requireMasterKey } from '../auth.js';
import { routeRequest, pickAccount, addLog, recordTokens } from '../pool.js';
import { pipeToResponse, sendBuffer } from '../upstream.js';
import { isOssModel, anthropicToOpenAI, openAIToAnthropic, openAISToAnthropicSSE, extractOpenAIUsage, cleanModelPrefix } from '../convert.js';
import {
  ALPHA_URL, alphaHeaders, anthropicToAlpha, openAIToAlpha,
  parseAlphaLine, createAlphaState, alphaEventToAnthropicSSE, alphaStateToAnthropicMessage,
  alphaEventToOpenAISSE, alphaStateToOpenAIMessage
} from '../alpha.js';

const UPSTREAM_BASE = 'https://api.commandcode.ai/provider';
// alpha/generate yolu SADECE CommandCode hesapları için çalışır (opencode.ai'de böyle
// bir endpoint yok). Havuzda opencode-go hesabı varsa alpha kapatılır ve her şey
// normal provider-bazlı yoldan (pool.js account.upstreamBase) gider.
const hasOpenCodeGo = () => (data.config.accounts || []).some((a) => a.provider === 'opencode-go');
const useAlpha = () => data.config.useAlpha !== false && !hasOpenCodeGo(); // default: AÇIK (CommandCode-only havuz)

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
      // hesabın provider'ına göre model listesi (commandcode: /v1/models, opencode-go: /models)
      const base = (account.upstreamBase || UPSTREAM_BASE).replace(/\/+$/, '');
      const modelsPath = account.provider === 'opencode-go' ? '/models' : '/v1/models';
      const up = await fetch(base + modelsPath, {
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

  // /alpha/generate dalı (OmniRoute yöntemi): Go planı dahil HER planla çalışır.
  // config'te useAlpha:false yapılırsa eski /provider yolu kullanılır.
  if (useAlpha() && req.method === 'POST' && (route.endsWith('/v1/messages') || route.endsWith('/v1/chat/completions'))) {
    await handleAlpha(req, res, route, started);
    return;
  }

  // apply model mapping on message bodies
  let body = req.body ?? {};
  let rawBody = null;
  let convertOss = false;      // OSS model -> /v1/chat/completions + format dönüşümü
  let upstreamRoute = route;   // yönlendirilirse değişir (/v1/messages -> /v1/chat/completions)
  if (req.method === 'POST' && (route.includes('/messages') || route.includes('/chat/completions'))) {
    if (typeof body === 'object' && body !== null) {
      // Hermes/gateway prefix'lerini temizle (anthropic:cmd/... gibi)
      if (typeof body.model === 'string') body.model = cleanModelPrefix(body.model);
      // OSS model (deepseek/gpt/...) ise Anthropic endpoint'i kabul etmiyor ->
      // chat/completions'a yönlendir + gövdeyi OpenAI formatına çevir
      // (SADECE /v1/messages'ta; /v1/chat/completions zaten OpenAI formatı)
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
    url: upstreamRoute + (query ? `?${query}` : ''), // sadece path — hesabın provider base'ine eklenir
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
      pipeConvertedStream({ upstreamRes: result, res, controller, log });
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
      pipeToResponse({ upstreamRes: result, res, controller });
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
function pipeConvertedStream({ upstreamRes, res, controller, log }) {
  res.status(upstreamRes.status);
  res.setHeader('content-type', 'text/event-stream');
  res.setHeader('cache-control', 'no-cache');
  res.setHeader('connection', 'keep-alive');
  res.flushHeaders();

  if (!upstreamRes.bodyStream && !upstreamRes.body) {
    res.end();
    return;
  }

  const body = upstreamRes.bodyStream ?? upstreamRes.body;
  // AĞU'26: Web ReadableStream tek seferlik — locked kontrolü + byte toplama ile oku.
  (async () => {
    let text;
    try {
      if (body.locked) { try { res.end(); } catch {} ; return; }
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
      text = new TextDecoder().decode(buf);
    } catch (e) {
      try { res.end(); } catch {}
      return;
    }
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

    try {
      // buffer + text'i birleştir, \n\n event bloklarına böl
      buffer = text;
      const blocks = buffer.split('\n\n');
      for (const b of blocks) {
        if (!b.trim()) continue;
        const u = extractOpenAIUsage(b);
        if (u) usage = u;
        const converted = openAISToAnthropicSSE(b);
        if (!converted) {
          res.write(encoder.encode(b + '\n\n'));
          continue;
        }
        ensureStarted(b);
        res.write(encoder.encode(converted));
      }
      // son buffer'ı da işle (eksik event varsa)
      if (buffer.trim()) {
        const converted = openAISToAnthropicSSE(buffer);
        if (converted) {
          ensureStarted(buffer);
          res.write(encoder.encode(converted));
        }
      }
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
    } catch (err) {
      try { res.end(); } catch {}
    }
  })();

  res.on('close', () => controller.abort());
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

// ---------------------------------------------------------------------------
// /alpha/generate (OmniRoute yöntemi) — Go planı dahil HER planla çalışır
// ---------------------------------------------------------------------------

async function handleAlpha(req, res, route, started) {
  const isAnthropic = route.endsWith('/v1/messages');
  let body = req.body ?? {};
  let clientStream = true;
  // Claude Code, yanıtın model alanında istekteki model adını bekler.
  // Hermes/gateway prefix'lerini temizle (anthropic:cmd/... gibi)
  if (typeof body.model === 'string') body.model = cleanModelPrefix(body.model);
  const clientModel = body.model ?? null;

  if (typeof body === 'object' && body !== null) {
    // İstemci tek JSON yanıt istiyorsa (stream:false) clientStream kapatılır ve
    // event'ler toplanıp tek JSON üretilir. İstemci SSE bekliyorsa (stream:true,
    // jcode vb.) clientStream açık kalır ve dönüştürülmüş SSE akıtılır.
    // (Eski kod accept header'ına bakmadan hep false yapıyordu — SSE isteyen
    //  istemciler "boş yanıt" görüyordu. req.body?.stream esas alınır.)
    clientStream = Boolean(req.body?.stream);
  }

  let alphaBody;
  try {
    // CLI protokolü her zaman SSE üretir — stream:false'da tek JSON döner ve
    // çevirici onu tanımaz. Bu yüzden alpha'ya HER ZAMAN stream:true gönder,
    // client stream:false istiyorsa event'leri toplayıp tek JSON üret.
    alphaBody = isAnthropic ? anthropicToAlpha(body, true) : openAIToAlpha(body, true);
  } catch (err) {
    sendBuffer({
      res, status: 400,
      headers: new Headers({ 'content-type': 'application/json' }),
      bodyBuffer: JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: `alpha dönüşüm hatası: ${err.message}` } })
    });
    return;
  }

  const controller = new AbortController();
  const signal = controller.signal;
  res.on('close', () => controller.abort());

  // CLI header'ları (routeRequest authorization'ı hesap anahtarıyla override eder)
  const result = await routeRequest({
    url: ALPHA_URL,
    method: 'POST',
    headers: alphaHeaders(''),
    body: JSON.stringify(alphaBody),
    signal,
    route: '/alpha/generate'
  });
  const log = addLog({
    method: req.method,
    route: '/alpha/generate',
    model: body.model ?? req.body?.model,
    account: result.account?.name ?? null,
    status: result.status,
    ok: result.status >= 200 && result.status < 300,
    ms: Date.now() - started,
    detail: result.status >= 400 ? String(result.bodyBuffer ?? '').slice(0, 120) : null
  });
  log.clientStream = clientStream;
  log.clientAccept = String(req.headers?.accept ?? '').slice(0, 30);
  log.streamFlag = Boolean(req.body?.stream);

  if (result.bodyStream) {
    pipeAlphaStream({ upstreamRes: result, res, controller, log, isAnthropic, clientStream, bodyStream: result.bodyStream, model: clientModel || body.model });
  } else {
    // hata gövdesi (bodyBuffer) — olduğu gibi geç
    sendBuffer({
      res,
      status: result.status,
      headers: result.headers ?? new Headers({ 'content-type': 'application/json' }),
      bodyBuffer: result.bodyBuffer ?? JSON.stringify(result.body ?? {})
    });
  }
}

/**
 * CLI event stream'ini client formatına çevirerek pipe et.
 * - clientStream:true  -> Anthropic / OpenAI SSE olarak akıt
 * - clientStream:false -> event'leri topla, tek JSON yanıt üret
 */
function pipeAlphaStream({ upstreamRes, res, controller, log, isAnthropic, clientStream, bodyStream, model }) {
  const state = createAlphaState();
  // Claude Code, message_start.message.model boşsa yanıtı "malformed" sayar.
  // CLI event'leri model taşımaz -> istekten al (zaten map'lenmiş upstream modeli).
  state.model = model || null;
  if (clientStream) {
    res.status(upstreamRes.status);
    res.setHeader('content-type', 'text/event-stream');
    res.setHeader('cache-control', 'no-cache');
    res.setHeader('connection', 'keep-alive');
    res.flushHeaders();
  }

  if (!bodyStream) {
    const payload = isAnthropic ? alphaStateToAnthropicMessage(state) : alphaStateToOpenAIMessage(state);
    sendBuffer({
      res, status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      bodyBuffer: JSON.stringify(payload)
    });
    return;
  }

  const reader = bodyStream.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';
  const processEvent = (ev) => {
    if (!ev || typeof ev !== 'object') return;
    if (ev.model && !state.model) state.model = ev.model;
    const out = isAnthropic ? alphaEventToAnthropicSSE(state, ev) : alphaEventToOpenAISSE(state, ev);
    if (out && clientStream) res.write(encoder.encode(out));
  };

  const flushTokenLog = () => {
    const u = state.usage;
    if (!u) return;
    const input = u.inputTokens ?? u.input_tokens ?? u.promptTokens ?? u.prompt_tokens ?? 0;
    const output = u.outputTokens ?? u.output_tokens ?? u.completionTokens ?? u.completion_tokens ?? 0;
    if (!input && !output) return;
    recordTokens({ inputTokens: input, outputTokens: output });
    if (log) {
      log.inputTokens = input;
      log.outputTokens = output;
      markDirty();
    }
  };

  const pump = async () => {
    reader.read().then(async ({ done, value }) => {
      if (done) {
        for (const line of buffer.split('\n')) processEvent(parseAlphaLine(line));
        flushTokenLog();
        if (clientStream) {
          res.end();
        } else {
          const payload = isAnthropic ? alphaStateToAnthropicMessage(state) : alphaStateToOpenAIMessage(state);
          sendBuffer({
            res, status: 200,
            headers: new Headers({ 'content-type': 'application/json' }),
            bodyBuffer: JSON.stringify(payload)
          });
        }
        return;
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop(); // son satır eksik olabilir
      for (const line of lines) processEvent(parseAlphaLine(line));
      pump();
    }).catch((err) => {
      try {
        if (clientStream) {
          res.end();
        } else {
          sendBuffer({
            res, status: 502,
            headers: new Headers({ 'content-type': 'application/json' }),
            bodyBuffer: JSON.stringify({ type: 'error', error: { type: 'api_error', message: `alpha stream hatası: ${err.message}` } })
          });
        }
      } catch {}
    });
  };
  pump();

  res.on('close', () => {
    try { reader.cancel(); } catch {}
    controller.abort();
  });
}
