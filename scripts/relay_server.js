#!/usr/bin/env node
// Local, single-worker browser relay. No DeepSeek credentials leave Chrome.
const http = require('http');
const crypto = require('crypto');
const { loadDotEnv } = require('../lib/env');
const path = require('path');
if (require.main === module) loadDotEnv(path.join(__dirname, '..', '.env'));

function createRelayServer({ key, timeoutMs = 180000 } = {}) {
  if (!key || key.length < 16) throw new Error('RELAY_API_KEY must contain at least 16 characters');
  let job = null;
  const json = (res, status, body) => { if (!res.writableEnded) { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); } };
  const error = (res, status, message) => json(res, status, { error: { message, type: 'relay_error' } });
  function finishJob(j, message) {
    if (job !== j) return;
    clearTimeout(j.timer); job = null;
    if (j.res.writableEnded || j.res.destroyed) return;
    if (message) {
      if (!j.started) error(j.res, 502, message);
      else { j.res.write(`data: ${JSON.stringify({ error: { message, type: 'relay_error' } })}\n\n`); j.res.end(); }
      return;
    }
    if (j.stream) {
      j.res.write(`data: ${JSON.stringify({ id: j.id, object: 'chat.completion.chunk', created: j.created, model: 'relay', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
      j.res.end();
    } else json(j.res, 200, { id: j.id, object: 'chat.completion', created: j.created, model: 'relay', choices: [{ index: 0, message: { role: 'assistant', content: j.text }, finish_reason: 'stop' }], usage: null });
  }
  const server = http.createServer(async (req, res) => {
    // The server does not grant CORS access to web pages. All endpoints require the key.
    const supplied = String(req.headers.authorization || '').replace(/^Bearer /, '');
    const a = Buffer.from(supplied), b = Buffer.from(key);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return error(res, 401, 'Invalid relay API key');
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/v1/models') return json(res, 200, { object: 'list', data: [{ id: 'relay', object: 'model', created: 0, owned_by: 'deepseek-web' }] });
    if (req.method === 'GET' && url.pathname === '/relay/job') {
      if (!job || job.claimed) return json(res, 200, { job: null });
      job.claimed = true;
      return json(res, 200, { job: { id: job.id, prompt: job.prompt } });
    }
    if (req.method !== 'POST' || !['/v1/chat/completions', '/relay/update'].includes(url.pathname)) return error(res, 404, 'Not found');
    let size = 0, chunks = [];
    try {
      for await (const chunk of req) { size += chunk.length; if (size > 1024 * 1024) return error(res, 413, 'Body too large'); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!body || typeof body !== 'object' || Array.isArray(body)) return error(res, 400, 'Expected JSON object');
      if (url.pathname === '/relay/update') {
        const j = job;
        if (!j || !j.claimed || body.id !== j.id) return error(res, 410, 'Job is no longer active');
        if (body.error) { finishJob(j, String(body.error).slice(0, 500)); return json(res, 200, { ok: true }); }
        if (typeof body.text !== 'string' || body.text.length > 1000000) return error(res, 400, 'Invalid response text');
        if (!body.text.startsWith(j.text)) { finishJob(j, 'The page rewrote previously streamed text; response cannot be continued safely'); return json(res, 200, { ok: false }); }
        const delta = body.text.slice(j.text.length); j.text = body.text;
        if (j.stream && delta) {
          if (!j.started) { j.res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' }); j.started = true; j.res.write(`data: ${JSON.stringify({ id: j.id, object: 'chat.completion.chunk', created: j.created, model: 'relay', choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })}\n\n`); }
          j.res.write(`data: ${JSON.stringify({ id: j.id, object: 'chat.completion.chunk', created: j.created, model: 'relay', choices: [{ index: 0, delta: { content: delta }, finish_reason: null }] })}\n\n`);
        }
        if (body.done === true) { if (!j.text) finishJob(j, 'Empty response'); else finishJob(j); }
        return json(res, 200, { ok: true });
      }
      if (job) return error(res, 503, 'Relay is busy');
      if (body.model !== 'relay' || !Array.isArray(body.messages) || !body.messages.length || body.messages.some(m => !m || !['system', 'user', 'assistant'].includes(m.role) || typeof m.content !== 'string')) return error(res, 400, 'Use model relay and text-only system/user/assistant messages');
      if (body.tools || body.functions || body.response_format || body.n > 1) return error(res, 400, 'Tools, structured output and multiple choices are not supported by relay');
      const prompt = body.messages.map(m => `${m.role.toUpperCase()}:\n${m.content}`).join('\n\n') + '\n\nASSISTANT:';
      const j = { id: `chatcmpl-${crypto.randomUUID()}`, prompt, res, text: '', stream: body.stream === true, started: false, claimed: false, created: Math.floor(Date.now() / 1000) };
      job = j;
      j.timer = setTimeout(() => finishJob(j, 'Browser relay timed out; open a fresh DeepSeek chat and enable the extension'), timeoutMs);
      res.on('close', () => { if (job === j) { clearTimeout(j.timer); job = null; } });
    } catch (e) { if (!res.headersSent) error(res, 400, 'Invalid JSON request'); }
  });
  return server;
}
if (require.main === module) {
  try {
    const server = createRelayServer({ key: process.env.RELAY_API_KEY });
    const port = 9656;
    server.listen(port, '127.0.0.1', () => console.log(`[relay] Listening on http://127.0.0.1:${port}`));
  } catch (e) { console.error(`[relay] ${e.message}`); process.exitCode = 1; }
}
module.exports = { createRelayServer };
