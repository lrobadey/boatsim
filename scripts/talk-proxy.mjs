// Dev-server proxy for the stall traders' voice (docs/pass-2-plan.md, lane C). The browser posts
// { instructions, input, tools, schema }; this calls the OpenAI Responses API with gpt-6-luna on medium reasoning,
// lets the model call the trusted tools (parallel calls off) and returns its output items: the reply text and any
// function calls, in order. The API key is read here (environment or .env.local) and never reaches the page.
import { loadEnv } from 'vite';

const MODEL = 'gpt-6-luna';
const ENDPOINT = 'https://api.openai.com/v1/responses';
const TIMEOUT_MS = 60000;
const MAX_BODY = 256 * 1024;

const reply = (res, status, body) => {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
};

const str = (v, max) => typeof v === 'string' && v.length <= max;

/** a function tool definition (strict) */
function validTool(t) {
  return !!t && typeof t === 'object' && t.type === 'function' && str(t.name, 64) && str(t.description, 2000) && t.strict === true && !!t.parameters && typeof t.parameters === 'object';
}

/** one input item: a message, a function call the model made, or its output */
function validItem(m) {
  if (!m || typeof m !== 'object') return false;
  if (m.type === 'function_call') return typeof m.call_id === 'string' && typeof m.name === 'string' && str(m.arguments, 4000);
  if (m.type === 'function_call_output') return typeof m.call_id === 'string' && str(m.output, 8000);
  return (m.role === 'user' || m.role === 'assistant' || m.role === 'developer') && str(m.content, 4000);
}

/** the request the page may send: bounded sizes, known item and tool shapes only */
function validRequest(b) {
  if (!b || typeof b !== 'object') return false;
  if (typeof b.instructions !== 'string' || b.instructions.length > 48000) return false;
  if (!b.schema || typeof b.schema !== 'object') return false;
  if (!Array.isArray(b.tools) || b.tools.length > 8 || !b.tools.every(validTool)) return false;
  if (!Array.isArray(b.input) || b.input.length < 1 || b.input.length > 80) return false;
  return b.input.every(validItem);
}

/**
 * why a request is refused before its body is read, or null. A JSON content type forces a CORS preflight, which
 * Vite does not grant to foreign origins; an Origin header, when the browser sends one, must be this server's own.
 * Without both checks any web page could post a text/plain body here and spend the user's key.
 */
export function refusal(req) {
  if (req.method !== 'POST') return [405, 'method'];
  const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') return [415, 'content-type'];
  const origin = req.headers.origin;
  if (origin !== undefined) {
    let host = null;
    try {
      host = new URL(origin).host;
    } catch {}
    if (!host || host !== req.headers.host) return [403, 'origin'];
  }
  return null;
}

/**
 * the response's output as the page reads it: a message's first output_text, each function call, reasoning and
 * other items dropped. A refusal, a message without text, or no items at all is null (an upstream error).
 */
function outputItems(data) {
  const items = [];
  for (const item of data?.output ?? []) {
    if (item?.type === 'message') {
      const parts = item.content ?? [];
      if (parts.some((c) => c.type === 'refusal')) return null;
      const text = parts.find((c) => c.type === 'output_text')?.text;
      if (typeof text !== 'string') return null;
      items.push({ type: 'message', text });
    } else if (item?.type === 'function_call') {
      items.push({ type: 'function_call', call_id: item.call_id, name: item.name, arguments: item.arguments });
    }
  }
  return items.length ? items : null;
}

export function talkProxy() {
  return {
    name: 'trieres-talk-proxy',
    configureServer(server) {
      const env = loadEnv(server.config.mode, server.config.root, '');
      const key = () => process.env.OPENAI_API_KEY || env.OPENAI_API_KEY || '';
      server.middlewares.use('/__trieres_talk__', (req, res) => {
        const refused = refusal(req);
        if (refused) return reply(res, refused[0], { ok: false, error: refused[1] });
        let body = '';
        let size = 0;
        req.on('data', (c) => {
          size += c.length;
          if (size <= MAX_BODY) body += c;
        });
        req.on('end', async () => {
          let b;
          try {
            b = JSON.parse(body);
          } catch {
            return reply(res, 400, { ok: false, error: 'request' });
          }
          if (size > MAX_BODY || !validRequest(b)) return reply(res, 400, { ok: false, error: 'request' });
          const apiKey = key();
          // a missing key is a normal state, not a failed request: answer 200 so the console stays clean
          if (!apiKey) return reply(res, 200, { ok: false, error: 'no-key' });
          try {
            const r = await fetch(ENDPOINT, {
              method: 'POST',
              headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                model: MODEL,
                reasoning: { effort: 'medium' },
                instructions: b.instructions,
                input: b.input,
                tools: b.tools,
                parallel_tool_calls: false,
                text: { format: { type: 'json_schema', name: 'trader_reply', strict: true, schema: b.schema } },
                max_output_tokens: 4000,
                store: false,
              }),
              signal: AbortSignal.timeout(TIMEOUT_MS),
            });
            const data = await r.json().catch(() => null);
            if (!r.ok) {
              console.warn(`[talk] OpenAI ${r.status}: ${data?.error?.message ?? 'no body'}`);
              return reply(res, 502, { ok: false, error: 'upstream' });
            }
            const output = outputItems(data);
            if (!output) return reply(res, 502, { ok: false, error: 'upstream' });
            return reply(res, 200, { ok: true, output });
          } catch (e) {
            const timeout = e?.name === 'TimeoutError' || e?.name === 'AbortError';
            if (!timeout) console.warn('[talk] request failed:', e?.message ?? e);
            return reply(res, timeout ? 504 : 502, { ok: false, error: timeout ? 'timeout' : 'upstream' });
          }
        });
      });
    },
  };
}
