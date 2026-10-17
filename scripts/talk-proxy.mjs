// Dev-server proxy for the stall traders' voice (docs/kormakos-and-traders-spec.md, part B). The browser posts
// { instructions, messages, schema }; this calls the OpenAI Responses API with gpt-6-luna on low reasoning and
// returns the parsed reply. The API key is read here (environment or .env.local) and never reaches the page.
import { loadEnv } from 'vite';

const MODEL = 'gpt-6-luna';
const ENDPOINT = 'https://api.openai.com/v1/responses';
const TIMEOUT_MS = 30000;
const MAX_BODY = 96 * 1024;

const reply = (res, status, body) => {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
};

/** the request the page may send: bounded sizes, two roles only */
function validRequest(b) {
  if (!b || typeof b !== 'object') return false;
  if (typeof b.instructions !== 'string' || b.instructions.length > 24000) return false;
  if (!b.schema || typeof b.schema !== 'object') return false;
  if (!Array.isArray(b.messages) || b.messages.length < 1 || b.messages.length > 24) return false;
  return b.messages.every((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.length <= 1200);
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

/** the first output_text of the response's message, or a refusal */
function outputText(data) {
  for (const item of data?.output ?? []) {
    if (item.type !== 'message') continue;
    for (const c of item.content ?? []) {
      if (c.type === 'output_text') return { text: c.text };
      if (c.type === 'refusal') return { refusal: c.refusal };
    }
  }
  return {};
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
                reasoning: { effort: 'low' },
                instructions: b.instructions,
                input: b.messages.map((m) => ({ role: m.role, content: m.content })),
                text: { format: { type: 'json_schema', name: 'trader_reply', strict: true, schema: b.schema } },
                max_output_tokens: 2000,
                store: false,
              }),
              signal: AbortSignal.timeout(TIMEOUT_MS),
            });
            const data = await r.json().catch(() => null);
            if (!r.ok) {
              console.warn(`[talk] OpenAI ${r.status}: ${data?.error?.message ?? 'no body'}`);
              return reply(res, 502, { ok: false, error: 'upstream' });
            }
            const out = outputText(data);
            if (out.refusal || !out.text) return reply(res, 502, { ok: false, error: 'upstream' });
            return reply(res, 200, { ok: true, reply: JSON.parse(out.text) });
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
