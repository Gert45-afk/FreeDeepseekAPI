const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createRelayServer } = require('../scripts/relay_server');
const key = 'test-secret-key-123456';
async function withServer(fn) {
  const server = createRelayServer({ key, timeoutMs: 2000 });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const fetcher = (p, options = {}) => fetch(base + p, { ...options, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...options.headers } });
  try { await fn(fetcher); } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); }
}
const post = body => ({ method: 'POST', body: JSON.stringify(body) });
const request = { model: 'relay', messages: [{ role: 'user', content: 'Привет' }] };
test('requires strong key and bearer auth', async () => {
  assert.throws(() => createRelayServer({ key: 'short' }));
  await withServer(async f => { assert.equal((await f('/v1/models', { headers: { authorization: 'Bearer wrong' } })).status, 401); });
});
test('single job, streaming, and completion', async () => withServer(async f => {
  const completion = f('/v1/chat/completions', post({ ...request, stream: true }));
  await new Promise(r => setTimeout(r, 30));
  assert.equal((await f('/v1/chat/completions', post(request))).status, 503);
  const { job } = await (await f('/relay/job')).json();
  assert.ok(job.prompt.includes('Привет'));
  assert.equal((await (await f('/relay/job')).json()).job, null);
  await f('/relay/update', post({ id: job.id, text: 'При' }));
  await f('/relay/update', post({ id: job.id, text: 'Привет!', done: true }));
  const response = await completion;
  const text = await response.text();
  assert.match(text, /При/); assert.match(text, /вет!/); assert.match(text, /\[DONE\]/);
}));
test('non-stream result and unsupported features', async () => withServer(async f => {
  assert.equal((await f('/v1/chat/completions', post({ ...request, tools: [] }))).status, 400);
  const pending = f('/v1/chat/completions', post(request));
  await new Promise(r => setTimeout(r, 30));
  const { job } = await (await f('/relay/job')).json();
  await f('/relay/update', post({ id: job.id, text: 'OK', done: true }));
  assert.equal((await (await pending).json()).choices[0].message.content, 'OK');
}));
test('rewritten text fails rather than silently corrupting stream', async () => withServer(async f => {
  const pending = f('/v1/chat/completions', post({ ...request, stream: true }));
  await new Promise(r => setTimeout(r, 30));
  const { job } = await (await f('/relay/job')).json();
  await f('/relay/update', post({ id: job.id, text: 'abc' }));
  await f('/relay/update', post({ id: job.id, text: 'xyz', done: true }));
  assert.match(await (await pending).text(), /rewrote/);
}));
