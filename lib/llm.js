// llm.js — OpenAI-compatible chat-completions client for MiniMax (or any
// OpenAI-compatible endpoint). Returns parsed JSON when expectJson=true.
//
// Env:
//   LLM_BASE_URL   default https://api.minimax.io/v1
//   LLM_API_KEY    required for actual calls (helper throws a clear error otherwise)
//   LLM_MODEL      default minimax/MiniMax-M3
//   LLM_TIMEOUT_MS default 30000

const BASE_URL = (process.env.LLM_BASE_URL || 'https://api.minimax.io/v1').replace(/\/+$/, '');
const MODEL = process.env.LLM_MODEL || 'minimax/MiniMax-M3';

function stripCodeFences(s) {
  if (!s) return s;
  // Remove ```json ... ``` or ``` ... ``` fences anywhere in the string.
  return s
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .replace(/```(?:json)?\s*/gi, '')
    .replace(/```\s*/g, '')
    .trim();
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isRetriable(err) {
  // Network errors and 5xx → retriable. 4xx (except 408/429) → not retriable.
  if (!err) return false;
  if (err.name === 'AbortError') return true;
  if (err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT' || err.code === 'ENOTFOUND') return true;
  if (err.status >= 500 && err.status < 600) return true;
  if (err.status === 408 || err.status === 429) return true;
  return false;
}

/**
 * callLLM({ systemPrompt, userPrompt, expectJson, timeoutMs, retries })
 *   → parsed object (when expectJson=true) or raw text
 * Throws Error with a clear "LLM auth failed" message on 401/403.
 * Throws Error on parse failure after one retry with a re-prompt hint.
 */
async function callLLM({
  systemPrompt,
  userPrompt,
  expectJson = false,
  timeoutMs = parseInt(process.env.LLM_TIMEOUT_MS || '30000', 10),
  retries = 1,
} = {}) {
  if (!process.env.LLM_API_KEY) {
    const e = new Error('LLM_API_KEY is not set — cannot call LLM');
    e.code = 'LLM_NO_KEY';
    throw e;
  }

  const url = `${BASE_URL}/chat/completions`;
  const body = {
    model: MODEL,
    messages: [
      { role: 'system', content: systemPrompt || '' },
      { role: 'user', content: userPrompt || '' },
    ],
    temperature: 0.7,
    ...(expectJson ? { response_format: { type: 'json_object' } } : {}),
  };

  let attempt = 0;
  let lastErr = null;
  while (attempt <= retries) {
    attempt++;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.LLM_API_KEY}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (res.status === 401 || res.status === 403) {
        const txt = await res.text().catch(() => '');
        const e = new Error(`LLM auth failed — check LLM_API_KEY (status ${res.status}, body: ${txt.slice(0, 200)})`);
        e.status = res.status;
        throw e;
      }

      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        const e = new Error(`LLM HTTP ${res.status}: ${txt.slice(0, 200)}`);
        e.status = res.status;
        throw e;
      }

      const data = await res.json();
      const content = data?.choices?.[0]?.message?.content ?? '';

      if (!expectJson) return content;

      // JSON parse. Strip fences first; on failure, retry once with a hint suffix.
      try {
        return JSON.parse(stripCodeFences(content));
      } catch (parseErr) {
        if (attempt > retries) {
          const e = new Error(`LLM returned non-JSON after retry: ${parseErr.message}; content head: ${content.slice(0, 200)}`);
          e.parseError = true;
          throw e;
        }
        // Retry: re-call with a hint appended to the user prompt.
        body.messages = [
          ...body.messages,
          { role: 'assistant', content },
          { role: 'user', content: 'Return ONLY valid JSON, no markdown.' },
        ];
        // Drop response_format on retry so the model can produce plain text we can re-strip.
        delete body.response_format;
        continue;
      }
    } catch (err) {
      lastErr = err;
      if (err.status === 401 || err.status === 403) throw err; // auth: no retry
      if (!isRetriable(err) || attempt > retries) throw err;
      // small backoff before retry
      await sleep(500 * attempt);
    }
  }
  throw lastErr || new Error('LLM call failed');
}

module.exports = { callLLM, stripCodeFences };
