import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { __diagnostics } from '../lib/index.js';

test('only the MiniMax account models are advertised, excluding custom providers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'minimax-roster-test-'));
  const config = join(dir, 'config.yaml');
  try {
    writeFileSync(config, `provider:
  minimax:
    models:
      MiniMax-Fixture:
        name: Account Model
        limit:
          context: 512000
          output: 64000
  other:
    models:
      Other-Provider:
        name: Other provider
custom_provider:
  ark:
    models:
      Custom-Model:
        name: Separately billed model
`);
    const { models, source } = __diagnostics.parseModels(config);
    assert.equal(source, 'config.yaml');
    assert.deepEqual(models.map(model => model.id), ['MiniMax-Fixture']);
    assert.equal(models[0].context, 512000);
    assert.equal(models[0].maxTokens, 64000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('maximum context never exceeds the declared window unless expansion is explicitly offered', () => {
  const dir = mkdtempSync(join(tmpdir(), 'minimax-context-test-'));
  const config = join(dir, 'config.yaml');
  try {
    for (const [context, options, expected] of [
      [32768, [], 32768], [512000, [], 512000], [32768, [16384], 32768],
      [32768, [32768, 65536], 65536],
    ]) {
      writeFileSync(config, `provider:\n  minimax:\n    models:\n      Fixture:\n        limit:\n          context: ${context}\n          output: 2048\n`
        + (options.length ? `        contextWindowOptions:\n${options.map(n => `          - ${n}\n`).join('')}` : ''));
      const roster = __diagnostics.parseModels(config);
      assert.equal(roster.models[0].contextMax, expected);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the real host adapter streams with the latest MiniMax credential and honors model switches', { timeout: 20_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'minimax-provider-test-'));
  const authFile = join(dir, 'auth.json');
  const save = token => writeFileSync(authFile, JSON.stringify({ records: { fixture: {
    accessToken: token, expiresAtMs: Date.now() + 3_600_000,
  } } }));
  let observed;
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    observed = { path: request.url, headers: request.headers, body: JSON.parse(body) };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = value => response.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);
    emit({ type: 'message_start', message: { id: 'fixture', type: 'message', role: 'assistant',
      model: 'fixture', content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 0 } } });
    emit({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    emit({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '连接成功' } });
    emit({ type: 'content_block_stop', index: 0 });
    emit({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } });
    emit({ type: 'message_stop' });
    response.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    save('fixture-token-before');
    let enabledIds = {};
    const built = await __diagnostics.buildAdapter(
      { authFile, baseUrl: `http://127.0.0.1:${server.address().port}/llm` },
      { models: [{ id: 'fixture', name: 'Fixture', context: 32768, maxTokens: 2048, reasoning: false }] },
      () => ({ enabledIds }),
      { get: () => undefined },
    );
    assert.equal(built.error, undefined);
    assert.deepEqual((await built.adapter.listModels('minimax')).map(model => model.id), ['fixture']);
    save('fixture-token-after');
    const chunks = [];
    for await (const chunk of built.adapter.stream({
      provider: 'minimax', model: 'fixture', maxTokens: 64,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
      signal: AbortSignal.timeout(10_000),
    })) chunks.push(chunk);
    assert.equal(new URL(observed.path, 'http://fixture').pathname, '/llm/v1/messages');
    assert.equal(observed.headers.authorization, 'Bearer fixture-token-after');
    assert.equal(observed.headers['x-api-key'], undefined);
    assert.equal(observed.body.model, 'fixture');
    assert.ok(JSON.stringify(chunks).includes('连接成功'));
    assert.equal(chunks.at(-1).type, 'finish');
    assert.notEqual(chunks.at(-1).reason?.kind, 'error');

    // Expiry on the first request must not leave a stale explicit header
    // overriding the freshly resolved provider credential.
    writeFileSync(authFile, JSON.stringify({ records: { fixture: {
      accessToken: 'fixture-expired', refreshToken: 'fixture-refresh', expiresAtMs: 1,
    } } }));
    const originalFetch = globalThis.fetch;
    let grants = 0;
    globalThis.fetch = async (input, init) => {
      if (String(input) === __diagnostics.OAUTH_TOKEN_ENDPOINT) {
        grants++;
        return new Response(JSON.stringify({ access_token: 'fixture-renewed-token',
          refresh_token: 'fixture-next-refresh', expires_in: 3600 }),
          { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return originalFetch(input, init);
    };
    try {
      const refreshed = [];
      for await (const chunk of built.adapter.stream({
        provider: 'minimax', model: 'fixture', maxTokens: 64,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'refresh ping' }] }],
        signal: AbortSignal.timeout(10_000),
      })) refreshed.push(chunk);
      assert.equal(grants, 1);
      assert.equal(observed.headers.authorization, 'Bearer fixture-renewed-token');
      assert.equal(JSON.parse(readFileSync(authFile, 'utf8')).records.fixture.refreshToken, 'fixture-next-refresh');
      assert.ok(JSON.stringify(refreshed).includes('连接成功'));
      assert.notEqual(refreshed.at(-1).reason?.kind, 'error');
    } finally {
      globalThis.fetch = originalFetch;
    }

    enabledIds = { fixture: false };
    assert.deepEqual(await built.adapter.listModels('minimax'), []);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});
