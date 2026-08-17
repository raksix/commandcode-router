import { randomUUID } from 'node:crypto';

/**
 * CommandCode CLI'nin kendi kullandığı endpoint: POST https://api.commandcode.ai/alpha/generate
 *
 * OmniRoute'dan öğrenildi: /provider/v1/* endpoint'leri Provider planı ister (Go planı -> 403),
 * ama /alpha/generate CLI'ya açık olduğu için HER planla çalışır.
 * İstek formatı CLI'nın kendi protokolü: { config: {...}, params: { model, messages, tools, system, stream } }
 * Yanıt: CLI event stream'i (text-delta / reasoning-delta / tool-call / finish-step / finish / error).
 *
 * Bu modül:
 *   - Anthropic (/v1/messages) gövdesini CLI formatına çevirir (anthropicToAlpha)
 *   - CLI event stream'ini Anthropic SSE'ye çevirir (alphaEventToAnthropicSSE)
 *   - CLI header'larını üretir (alphaHeaders)
 */

export const ALPHA_URL = 'https://api.commandcode.ai/alpha/generate';
export const COMMAND_CODE_VERSION = process.env.COMMAND_CODE_VERSION?.trim() || '1.15.1';
const MAX_TOKENS = 200_000; // /alpha/generate ceiling

/** CLI'yı taklit eden header'lar (OmniRoute birebir) */
export function alphaHeaders(apiKey) {
  return {
    'Content-Type': 'application/json',
    authorization: `Bearer ${apiKey}`,
    'x-command-code-version': COMMAND_CODE_VERSION,
    'x-cli-environment': 'external',
    'x-project-slug': 'pi-cc',
    'x-taste-learning': 'false',
    'x-co-flag': 'false',
    'x-session-id': randomUUID()
  };
}

/** Anthropic /v1/messages gövdesi -> CommandCode CLI { config, params } gövdesi */
export function anthropicToAlpha(body, stream = true) {
  let system = '';
  const addSystem = (t) => {
    if (!t) return;
    system = system ? `${system}\n\n${t}` : t;
  };

  // system (üst seviye veya messages içinde)
  if (body.system) {
    const sys = Array.isArray(body.system) ? body.system : [{ type: 'text', text: body.system }];
    addSystem(sys.map((s) => (typeof s === 'string' ? s : s.text || '')).join('\n'));
  }

  const messages = [];
  // tool_call_id -> toolName eşlemesi (assistant tool-call'larından)
  const toolNameById = new Map();
  for (const m of body.messages || []) {
    if (m.role !== 'assistant') continue;
    const blocks = Array.isArray(m.content) ? m.content : [];
    for (const b of blocks) {
      if (b.type === 'tool_use' && b.id) toolNameById.set(b.id, b.name || 'unknown');
    }
  }

  for (const m of body.messages || []) {
    if (m.role === 'system' || m.role === 'developer') {
      const t = typeof m.content === 'string' ? m.content : (m.content || []).map((b) => b.text || '').join('\n');
      addSystem(t);
      continue;
    }
    if (m.role === 'user') {
      const content = typeof m.content === 'string' ? m.content : (m.content || []);
      if (typeof content === 'string') {
        messages.push({ role: 'user', content });
        continue;
      }
      // tool_result bloklarını ayrı role:'tool' mesajına çevir (alpha formatı)
      let textParts = '';
      let hasToolResult = false;
      for (const b of content) {
        if (b.type === 'tool_result') {
          hasToolResult = true;
          const id = b.tool_use_id || b.tool_call_id;
          if (!id) continue;
          const value = typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '');
          messages.push({
            role: 'tool',
            content: [{
              type: 'tool-result',
              toolCallId: id,
              toolName: toolNameById.get(id) || 'unknown',
              arguments: '{}',
              output: { type: 'text', value }
            }]
          });
        } else if (b.type === 'text' && b.text) {
          textParts = textParts ? `${textParts}\n${b.text}` : b.text;
        }
      }
      if (textParts || !hasToolResult) messages.push({ role: 'user', content: textParts });
      continue;
    }
    if (m.role === 'assistant') {
      const parts = [];
      const blocks = Array.isArray(m.content) ? m.content : [{ type: 'text', text: m.content }];
      for (const b of blocks) {
        if (b.type === 'text' && b.text) parts.push({ type: 'text', text: b.text });
        else if (b.type === 'tool_use') {
          const input = b.input ?? {};
          parts.push({
            type: 'tool-call',
            toolCallId: b.id || `call_${randomUUID()}`,
            toolName: b.name || 'unknown',
            input,
            arguments: JSON.stringify(input)
          });
        }
      }
      if (!parts.length) parts.push({ type: 'text', text: '' });
      messages.push({ role: 'assistant', content: parts });
      continue;
    }
    if (m.role === 'tool' || m.role === 'tool_result') {
      const id = m.tool_call_id || m.tool_use_id;
      if (!id) continue;
      const value = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
      messages.push({
        role: 'tool',
        content: [{
          type: 'tool-result',
          toolCallId: id,
          toolName: m.name || 'unknown',
          arguments: '{}',
          output: { type: 'text', value }
        }]
      });
      continue;
    }
  }

  const tools = (body.tools || []).map((t) => ({
    type: 'function',
    name: t.name,
    description: t.description || '',
    input_schema: t.input_schema || { type: 'object', properties: {} }
  }));

  const params = { model: body.model, messages, system, stream };
  if (tools.length) params.tools = tools;
  if (body.max_tokens && Number.isFinite(body.max_tokens) && body.max_tokens > 0) {
    params.max_tokens = Math.min(Math.floor(body.max_tokens), MAX_TOKENS);
  }

  return { ...alphaConfig(), params };
}

/** CLI { config, memory, taste, skills, permissionMode } sarmalı */
function alphaConfig() {
  return {
    config: {
      workingDir: '/workspace',
      date: new Date().toISOString().slice(0, 10),
      environment: 'external',
      structure: [],
      isGitRepo: false,
      currentBranch: '',
      mainBranch: '',
      gitStatus: '',
      recentCommits: []
    },
    memory: '',
    taste: '',
    skills: '',
    permissionMode: 'standard'
  };
}

/** OpenAI /v1/chat/completions gövdesi -> CommandCode CLI { config, params } gövdesi */
export function openAIToAlpha(body, stream = true) {
  let system = '';
  const messages = [];
  for (const m of body.messages || []) {
    if (m.role === 'system') {
      const t = typeof m.content === 'string' ? m.content : (m.content || []).map((c) => c.text || '').join('\n');
      system = system ? `${system}\n\n${t}` : t;
      continue;
    }
    if (m.role === 'assistant') {
      const parts = [];
      if (typeof m.content === 'string' && m.content) parts.push({ type: 'text', text: m.content });
      else if (Array.isArray(m.content)) {
        for (const c of m.content) if (c.type === 'text' && c.text) parts.push({ type: 'text', text: c.text });
      }
      for (const tc of m.tool_calls || []) {
        let input = {};
        let argStr = tc.function?.arguments;
        if (typeof argStr === 'string') { try { input = JSON.parse(argStr); } catch { input = {}; } }
        else if (argStr && typeof argStr === 'object') input = argStr;
        parts.push({
          type: 'tool-call',
          toolCallId: tc.id || `call_${randomUUID()}`,
          toolName: tc.function?.name || 'unknown',
          input,
          arguments: typeof argStr === 'string' ? argStr : JSON.stringify(input)
        });
      }
      if (!parts.length) parts.push({ type: 'text', text: '' });
      messages.push({ role: 'assistant', content: parts });
      continue;
    }
    if (m.role === 'tool') {
      const id = m.tool_call_id;
      if (!id) continue;
      const value = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
      messages.push({
        role: 'tool',
        content: [{
          type: 'tool-result',
          toolCallId: id,
          toolName: m.name || 'unknown',
          arguments: '{}',
          output: { type: 'text', value }
        }]
      });
      continue;
    }
    const t = typeof m.content === 'string' ? m.content : (m.content || []).map((c) => c.text || '').join('\n');
    messages.push({ role: 'user', content: t || '' });
  }

  const tools = (body.tools || []).map((t) => ({
    type: 'function',
    name: t.function?.name || t.name,
    description: t.function?.description || t.description || '',
    input_schema: t.function?.parameters || t.input_schema || { type: 'object', properties: {} }
  }));

  const params = { model: body.model, messages, system, stream };
  if (tools.length) params.tools = tools;
  if (body.max_tokens && Number.isFinite(body.max_tokens) && body.max_tokens > 0) {
    params.max_tokens = Math.min(Math.floor(body.max_tokens), MAX_TOKENS);
  }

  return { ...alphaConfig(), params };
}

/** CLI stream satırını parse et -> event objesi | null */
export function parseAlphaLine(line) {
  let trimmed = (line || '').trim();
  if (!trimmed || trimmed.startsWith(':') || trimmed.startsWith('event:')) return null;
  if (trimmed.startsWith('data:')) trimmed = trimmed.slice(5).trim();
  if (!trimmed || trimmed === '[DONE]') return null;
  try { return JSON.parse(trimmed); } catch { return null; }
}

function mergeUsage(prev, next) {
  if (!next || typeof next !== 'object') return prev;
  return { ...(prev || {}), ...next };
}

/** CLI stream state — Anthropic/OpenAI SSE üretmek için */
export function createAlphaState() {
  return {
    started: false,      // Anthropic message_start gönderildi mi
    openaiStarted: false,// OpenAI ilk chunk gönderildi mi
    chunkId: 'chatcmpl-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    createdAt: Math.floor(Date.now() / 1000),
    messageId: 'msg_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    model: null,
    blocks: [],      // { type: 'text'|'thinking'|'tool_use', index }
    content: '',
    reasoning: '',
    toolCalls: [],   // { blockIndex, id, name, input }
    usage: null,
    finishReason: null,
    closed: false
  };
}

/**
 * CLI event -> Anthropic SSE bloğu (birden fazla `data:` satırı).
 * Ayrıca state'i ilerletir. stream başladığında message_start + content_block_start yazar.
 */
export function alphaEventToAnthropicSSE(state, event) {
  if (!event || typeof event !== 'object') return '';
  const out = [];
  const ensureStart = () => {
    if (state.started) return;
    state.started = true;
    out.push(JSON.stringify({
      type: 'message_start',
      message: {
        id: state.messageId,
        type: 'message', role: 'assistant', model: state.model || '',
        content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 }
      }
    }));
  };

  const openBlock = (type, contentBlock) => {
    const block = { type, index: state.blocks.length };
    state.blocks.push(block);
    out.push(JSON.stringify({ type: 'content_block_start', index: block.index, content_block: contentBlock }));
    return block;
  };
  const findBlock = (type) => state.blocks.find((b) => b.type === type);

  switch (event.type) {
    case 'text-delta': {
      if (!event.text) break;
      ensureStart();
      let b = findBlock('text');
      if (!b) b = openBlock('text', { type: 'text', text: '' });
      state.content += event.text;
      out.push(JSON.stringify({ type: 'content_block_delta', index: b.index, delta: { type: 'text_delta', text: event.text } }));
      break;
    }
    case 'reasoning-delta': {
      if (!event.text) break;
      ensureStart();
      let b = findBlock('thinking');
      if (!b) b = openBlock('thinking', { type: 'thinking', thinking: '' });
      state.reasoning += event.text;
      out.push(JSON.stringify({ type: 'content_block_delta', index: b.index, delta: { type: 'thinking_delta', thinking: event.text } }));
      break;
    }
    case 'tool-call': {
      ensureStart();
      const id = event.toolCallId || event.id || `toolu_${randomUUID()}`;
      const name = event.toolName || event.name || 'unknown';
      const input = event.input ?? event.args ?? event.arguments ?? {};
      const b = openBlock('tool_use', { type: 'tool_use', id, name, input: {} });
      state.toolCalls.push({ blockIndex: b.index, id, name, input });
      out.push(JSON.stringify({ type: 'content_block_delta', index: b.index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } }));
      break;
    }
    case 'finish-step': {
      const u = event.usage || event.totalUsage;
      if (u) state.usage = mergeUsage(state.usage, u);
      break;
    }
    case 'finish': {
      ensureStart();
      state.finishReason = event.finishReason || 'stop';
      const u = event.usage || event.totalUsage;
      if (u) state.usage = mergeUsage(state.usage, u);
      const reason = state.finishReason;
      const stopReason =
        reason === 'length' || reason === 'max_tokens' ? 'max_tokens'
        : reason === 'tool-calls' || reason === 'tool_calls' || reason === 'toolUse' ? 'tool_use'
        : 'end_turn';
      const usage = state.usage
        ? {
            input_tokens: state.usage.inputTokens ?? state.usage.input_tokens ?? state.usage.promptTokens ?? state.usage.prompt_tokens ?? 0,
            output_tokens: state.usage.outputTokens ?? state.usage.output_tokens ?? state.usage.completionTokens ?? state.usage.completion_tokens ?? 0
          }
        : undefined;
      const md = { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null } };
      if (usage) md.usage = usage;
      out.push(JSON.stringify(md));
      out.push(JSON.stringify({ type: 'message_stop' }));
      state.closed = true;
      break;
    }
    case 'error': {
      ensureStart();
      const msg = event.error?.message || String(event.error || 'CommandCode error');
      out.push(JSON.stringify({ type: 'error', error: { type: 'api_error', message: msg } }));
      state.closed = true;
      break;
    }
  }
  return out.map((e) => `data: ${e}\n\n`).join('');
}

/** CLI event -> OpenAI chat.completion.chunk SSE bloğu (state'i de ilerletir) */
export function alphaEventToOpenAISSE(state, event) {
  if (!event || typeof event !== 'object') return '';
  const out = [];

  const chunk = (payload) => out.push(JSON.stringify(payload));
  const makeChunk = (delta, finish) => ({
    id: state.chunkId,
    object: 'chat.completion.chunk',
    created: state.createdAt,
    model: state.model || '',
    choices: [{ index: 0, delta: delta || {}, finish_reason: finish ?? null }]
  });

  switch (event.type) {
    case 'text-delta': {
      if (!event.text) break;
      if (!state.openaiStarted) {
        state.openaiStarted = true;
        state.model = state.model || event.model || null;
        chunk(makeChunk({ role: 'assistant' }, null));
      }
      state.content += event.text;
      chunk(makeChunk({ content: event.text }, null));
      break;
    }
    case 'reasoning-delta': {
      if (!event.text) break;
      state.reasoning += event.text;
      break; // OpenAI formatında reasoning ayrı kanal yok — atla
    }
    case 'tool-call': {
      if (!state.openaiStarted) {
        state.openaiStarted = true;
        state.model = state.model || event.model || null;
        chunk(makeChunk({ role: 'assistant' }, null));
      }
      const id = event.toolCallId || event.id || `call_${randomUUID()}`;
      const name = event.toolName || event.name || 'unknown';
      const input = event.input ?? event.args ?? event.arguments ?? {};
      const argStr = typeof input === 'string' ? input : JSON.stringify(input);
      state.toolCalls.push({ id, name, input });
      chunk(makeChunk({
        tool_calls: [{
          index: state.toolCalls.length - 1,
          id,
          type: 'function',
          function: { name, arguments: argStr }
        }]
      }, null));
      break;
    }
    case 'finish-step': {
      const u = event.usage || event.totalUsage;
      if (u) state.usage = mergeUsage(state.usage, u);
      break;
    }
    case 'finish': {
      const u = event.usage || event.totalUsage;
      if (u) state.usage = mergeUsage(state.usage, u);
      state.finishReason = event.finishReason || 'stop';
      const finishReason =
        state.finishReason === 'tool-calls' || state.finishReason === 'tool_calls' || state.finishReason === 'toolUse'
          ? 'tool_calls'
          : state.finishReason === 'length' || state.finishReason === 'max_tokens' ? 'length' : 'stop';
      const payload = makeChunk({}, finishReason);
      if (state.usage) {
        payload.usage = {
          prompt_tokens: state.usage.inputTokens ?? state.usage.input_tokens ?? state.usage.promptTokens ?? state.usage.prompt_tokens ?? 0,
          completion_tokens: state.usage.outputTokens ?? state.usage.output_tokens ?? state.usage.completionTokens ?? state.usage.completion_tokens ?? 0,
          total_tokens: 0
        };
        payload.usage.total_tokens = payload.usage.prompt_tokens + payload.usage.completion_tokens;
      }
      chunk(payload);
      out.push('[DONE]');
      state.closed = true;
      break;
    }
    case 'error': {
      const msg = event.error?.message || String(event.error || 'CommandCode error');
      out.push(JSON.stringify({ error: { message: msg, type: 'api_error' } }));
      state.closed = true;
      break;
    }
  }
  return out.map((e) => (e === '[DONE]' ? 'data: [DONE]\n\n' : `data: ${e}\n\n`)).join('');
}

/** stream'siz (istek stream:false) için: birikmiş state'ten tek Anthropic JSON yanıt üret */
export function alphaStateToAnthropicMessage(state) {
  const content = [];
  for (const b of state.blocks) {
    if (b.type === 'text') content.push({ type: 'text', text: state.content });
    else if (b.type === 'thinking') content.push({ type: 'thinking', thinking: state.reasoning });
    else if (b.type === 'tool_use') {
      const tc = state.toolCalls.find((c) => c.blockIndex === b.index);
      if (tc) content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input });
    }
  }
  if (!content.length) content.push({ type: 'text', text: state.content || '' });
  const usage = state.usage
    ? {
        input_tokens: state.usage.inputTokens ?? state.usage.input_tokens ?? 0,
        output_tokens: state.usage.outputTokens ?? state.usage.output_tokens ?? 0
      }
    : undefined;
  const reason = state.finishReason || 'stop';
  return {
    id: state.messageId,
    type: 'message',
    role: 'assistant',
    model: state.model || '',
    content,
    stop_reason: reason === 'length' || reason === 'max_tokens' ? 'max_tokens' : 'end_turn',
    stop_sequence: null,
    ...(usage ? { usage } : {})
  };
}

/** stream'siz için: birikmiş state'ten tek OpenAI chat.completion JSON yanıt üret */
export function alphaStateToOpenAIMessage(state) {
  const message = { role: 'assistant' };
  const toolCalls = [];
  for (const tc of state.toolCalls) {
    toolCalls.push({
      id: tc.id,
      type: 'function',
      function: { name: tc.name, arguments: JSON.stringify(tc.input ?? {}) }
    });
  }
  if (state.content) message.content = state.content;
  if (toolCalls.length) message.tool_calls = toolCalls;
  const finishReason =
    state.finishReason === 'tool-calls' || state.finishReason === 'tool_calls' || state.finishReason === 'toolUse'
      ? 'tool_calls'
      : state.finishReason === 'length' || state.finishReason === 'max_tokens' ? 'length' : 'stop';
  const usage = state.usage
    ? {
        prompt_tokens: state.usage.inputTokens ?? state.usage.input_tokens ?? state.usage.promptTokens ?? state.usage.prompt_tokens ?? 0,
        completion_tokens: state.usage.outputTokens ?? state.usage.output_tokens ?? state.usage.completionTokens ?? state.usage.completion_tokens ?? 0
      }
    : undefined;
  if (usage) usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
  return {
    id: state.chunkId,
    object: 'chat.completion',
    created: state.createdAt,
    model: state.model || '',
    choices: [{ index: 0, message, finish_reason: finishReason }],
    ...(usage ? { usage } : {})
  };
}
