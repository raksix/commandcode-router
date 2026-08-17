/**
 * Anthropic <-> OpenAI format dönüşümleri.
 *
 * Claude Code (/v1/messages, Anthropic formatı) OSS modellere (deepseek/...)
 * istek atınca CommandCode onu reddediyor: OSS modeller yalnızca
 * /v1/chat/completions (OpenAI formatı) kabul ediyor. Bu yüzden:
 *   - İstek: Anthropic -> OpenAI (chat/completions'a gider)
 *   - Yanıt: OpenAI -> Anthropic (Claude Code anlasın diye geri çevrilir)
 */

/** Model OSS / OpenAI tabanlı mı? (claude- değilse kabul) */
export function isOssModel(model) {
  if (!model) return false;
  return !/^claude-/.test(model);
}

/**
 * CommandCode /provider API'si models listesinde vendor'lı model adları
 * gösterir (xiaomi/mimo-v2.5) AMA isteklerde vendor prefix'siz ad ister
 * (mimo-v2.5) — vendor'lı gönderilirse 401 "Model not supported" döner.
 * Bu yüzden upstream'e gitmeden önce `vendor/name` -> `name` normalize edilir.
 * (claude-* zaten prefix'siz; deepseek/deepseek-v4-flash -> deepseek-v4-flash)
 */
export function commandCodeModelName(model) {
  if (!model || typeof model !== 'string') return model;
  const idx = model.indexOf('/');
  if (idx > 0 && !model.startsWith('claude-')) {
    return model.slice(idx + 1);
  }
  return model;
}

/**
 * Hermes/gateway'ler model adına provider prefix'i ekleyebilir:
 *   anthropic:cmd/deepseek/deepseek-v4-flash  ->  cmd/deepseek/deepseek-v4-flash
 *   anthropic:claude-sonnet-5                 ->  claude-sonnet-5
 * CommandCode bu prefix'leri tanımaz (403 "Model/provider not recognized"),
 * bu yüzden upstream'e gitmeden önce temizlenir.
 */
export function cleanModelPrefix(model) {
  if (!model || typeof model !== 'string') return model;
  const idx = model.indexOf(':');
  if (idx > 0 && /^[a-zA-Z0-9_-]+$/.test(model.slice(0, idx))) {
    return model.slice(idx + 1);
  }
  return model;
}

/** Anthropic messages body -> OpenAI chat/completions body */
export function anthropicToOpenAI(body) {
  const out = { model: body.model, messages: [] };

  // system -> öne system mesajı
  if (body.system) {
    const sys = Array.isArray(body.system) ? body.system : [{ type: 'text', text: body.system }];
    const text = sys.map((s) => (typeof s === 'string' ? s : s.text || '')).join('\n');
    if (text) out.messages.push({ role: 'system', content: text });
  }

  // messages
  for (const m of body.messages || []) {
    const content = typeof m.content === 'string'
      ? m.content
      : (m.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    out.messages.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content });
  }

  if (body.max_tokens) out.max_tokens = body.max_tokens;
  if (typeof body.temperature === 'number') out.temperature = body.temperature;
  if (typeof body.top_p === 'number') out.top_p = body.top_p;
  if (body.stream !== undefined) out.stream = body.stream;
  if (body.stop_sequences) out.stop = body.stop_sequences;

  // tools: Anthropic {name, description, input_schema} -> OpenAI {type, function}
  if (Array.isArray(body.tools)) {
    out.tools = body.tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description || '',
        parameters: t.input_schema || { type: 'object', properties: {} }
      }
    }));
  }
  // tool_choice: Anthropic {type: auto|any|tool, name} -> OpenAI
  if (body.tool_choice) {
    const tc = body.tool_choice;
    if (tc.type === 'auto') out.tool_choice = 'auto';
    else if (tc.type === 'any') out.tool_choice = 'required';
    else if (tc.type === 'tool' && tc.name) out.tool_choice = { type: 'function', function: { name: tc.name } };
  }

  return out;
}

/** OpenAI JSON yanıt -> Anthropic messages yanıt (stream'siz) */
export function openAIToAnthropic(oj) {
  // hata gövdesi: { error: { message, type, code } } -> Anthropic error formatı
  if (oj.error) {
    return {
      type: 'error',
      error: {
        type: oj.error.type === 'authentication_error' ? 'authentication_error'
          : oj.error.type === 'rate_limit_error' ? 'rate_limit_error'
          : 'api_error',
        message: oj.error.message || 'Unknown error'
      }
    };
  }
  const choice = oj.choices?.[0] || {};
  const content = choice.message?.content ?? '';
  const stopReason = choice.finish_reason === 'length' ? 'max_tokens' : 'end_turn';
  return {
    id: oj.id || 'msg_' + Math.random().toString(36).slice(2, 12),
    type: 'message',
    role: 'assistant',
    model: oj.model || '',
    content: [{ type: 'text', text: content }],
    stop_reason: stopReason,
    stop_sequence: null,
    usage: oj.usage ? { input_tokens: oj.usage.prompt_tokens || 0, output_tokens: oj.usage.completion_tokens || 0 } : undefined
  };
}

/**
 * OpenAI SSE stream -> Anthropic SSE stream.
 * Girdi: `data: {json}` satırları (bir veya birden fazla `data:` satırı, `\n\n` ile ayrık).
 * Çıktı: Anthropic message_start / content_block_start / delta / message_stop zinciri.
 */
export function openAISToAnthropicSSE(chunk) {
  // chunk bir data bloğu (tek `data: {...}`), birden fazla JSON içerebilir
  const jsons = [];
  const lines = chunk.split('\n');
  for (const line of lines) {
    if (line.startsWith('data:') && line !== 'data: [DONE]') {
      try { jsons.push(JSON.parse(line.slice(5))); } catch {}
    }
  }
  if (!jsons.length) return '';

  const events = [];
  let lastModel = null;
  for (const j of jsons) {
    if (j.id) lastModel = j.id;
    if (j.choices && j.choices.length) {
      const c = j.choices[0];
      const delta = c.delta || {};
      if (delta.content) {
        events.push(JSON.stringify({
          type: 'content_block_delta', index: 0,
          delta: { type: 'text_delta', text: delta.content }
        }));
      }
      if (c.finish_reason) {
        events.push(JSON.stringify({
          type: 'message_delta',
          delta: { stop_reason: c.finish_reason === 'length' ? 'max_tokens' : 'end_turn', stop_sequence: null }
        }));
        events.push(JSON.stringify({ type: 'message_stop' }));
      }
    }
  }

  if (!events.length) return '';
  return events.map((e) => `data: ${e}\n\n`).join('');
}

/**
 * OpenAI SSE chunk'ından usage (token) bilgisini çıkarır.
 * `data: {...}` satırlarındaki son usage değerini döner: { prompt_tokens, completion_tokens }.
 */
export function extractOpenAIUsage(chunk) {
  const lines = chunk.split('\n');
  let usage = null;
  for (const line of lines) {
    if (!line.startsWith('data:') || line === 'data: [DONE]') continue;
    try {
      const j = JSON.parse(line.slice(5));
      if (j.usage) usage = j.usage;
    } catch {}
  }
  return usage;
}
