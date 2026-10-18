import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { __diagnostics, apply, Config } from '../lib/index.js';

test('this build uses the released DSH 0.2.1-rc.2 host packages', () => {
  const plugin = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
  assert.equal(plugin.engines.dsh, '0.2.1-rc.2');
  // Client-only modules are supplied by the browser module loader, not Node.
  // Resolve the server packages here; the real Web smoke test covers client modules.
  for (const name of ['@deepseek-ai/dsh-client-connection', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-llm-pi-ai',
    '@deepseek-ai/dsh-host-webserver', '@deepseek-ai/dsh-settings']) {
    let directory = dirname(fileURLToPath(import.meta.resolve(name)));
    while (!existsSync(join(directory, 'package.json'))) {
      const parent = dirname(directory);
      assert.notEqual(parent, directory, `package.json not found for ${name}`);
      directory = parent;
    }
    const host = JSON.parse(readFileSync(join(directory, 'package.json')));
    assert.equal(host.name, name);
    assert.equal(host.version, plugin.engines.dsh, `${name} must come from the tested release`);
  }
});

async function withProvider(respond, run) {
  const directory = mkdtempSync(join(tmpdir(), 'minimax-rc2-'));
  const authFile = join(directory, 'auth.json');
  writeFileSync(authFile, JSON.stringify({ records: { fixture: {
    accessToken: 'fixture-account-token', expiresAtMs: Date.now() + 3_600_000,
  } } }));
  const observations = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const observation = { headers: request.headers, body: JSON.parse(body) };
    observations.push(observation);
    respond(response, observation);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const built = await __diagnostics.buildAdapter(
      { authFile, baseUrl: `http://127.0.0.1:${server.address().port}` },
      { models: [{ id: 'fixture', name: 'Fixture', context: 32768, maxTokens: 2048, reasoning: false }] },
      () => ({}), { get: () => undefined },
    );
    assert.equal(built.error, undefined);
    await run({ adapter: built.adapter, observations, authFile });
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
}

function toolResponse(response) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const emit = value => response.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);
  emit({ type: 'message_start', message: { id: 'fixture', type: 'message', role: 'assistant',
    model: 'fixture', content: [], stop_reason: null, stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 0 } } });
  emit({ type: 'content_block_start', index: 0, content_block: {
    type: 'tool_use', id: 'call-fixture', name: 'fixture_lookup', input: {},
  } });
  emit({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"city":"上海"}' } });
  emit({ type: 'content_block_stop', index: 0 });
  emit({ type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 3 } });
  emit({ type: 'message_stop' });
  response.end();
}

test('rc.2 preserves tool arguments, tool completion and usage through the real adapter', { timeout: 20_000 }, async () => {
  await withProvider(toolResponse, async ({ adapter, observations }) => {
    const chunks = [];
    for await (const chunk of adapter.stream({
      provider: 'minimax', model: 'fixture', maxTokens: 128,
      messages: [{ role: 'user', content: [{ type: 'text', text: '查询上海' }] }],
      tools: [{ name: 'fixture_lookup', description: 'Fixture lookup', parameters: {
        type: 'object', properties: { city: { type: 'string' } }, required: ['city'],
      } }], signal: AbortSignal.timeout(10_000),
    })) chunks.push(chunk);
    assert.equal(observations.length, 1);
    assert.equal(observations[0].body.tools[0].name, 'fixture_lookup');
    const block = chunks.find(chunk => chunk.type === 'block-end').block;
    assert.equal(block.type, 'tool-call');
    assert.equal(block.name, 'fixture_lookup');
    assert.deepEqual(JSON.parse(block.arguments), { city: '上海' });
    assert.ok(chunks.some(chunk => chunk.type === 'usage'));
    assert.equal(chunks.at(-1).type, 'finish');
    assert.equal(chunks.at(-1).reason.kind, 'tool-calls');
  });
});

test('missing MiniMax credentials never fall back to an ambient Anthropic API key', { timeout: 20_000 }, async () => {
  const before = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'fixture-unrelated-credential';
  try {
    await withProvider(toolResponse, async ({ adapter, observations, authFile }) => {
      rmSync(authFile);
      let failure;
      try {
        for await (const chunk of adapter.stream({
          provider: 'minimax', model: 'fixture', maxTokens: 16,
          messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
          signal: AbortSignal.timeout(5_000),
        })) {
          if (chunk.type === 'finish') failure = chunk.reason;
        }
      } catch (error) { failure = error; }
      assert.ok(failure, 'missing credentials must fail');
      assert.equal(observations.length, 0, 'no request may use an unrelated or empty credential');
    });
  } finally {
    if (before === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = before;
  }
});

function pluginContext() {
  const cleanups = [];
  const active = { adapters: 0, directories: 0 };
  const register = key => () => {
    active[key]++;
    return () => active[key]--;
  };
  return {
    active,
    dispose: () => cleanups.reverse().forEach(cleanup => cleanup()),
    ctx: {
      logger: { info() {}, warn() {}, error(...args) { throw new Error(args.map(String).join(' ')); } },
      get() {}, inject() {},
      effect(setup) { const cleanup = setup(); if (typeof cleanup === 'function') cleanups.push(cleanup); },
      llm: { registerAdapter: register('adapters'), registerConfigurableProviders: register('directories') },
    },
  };
}

test('hot reload cannot resurrect a provider after unloading during async setup', async () => {
  await withProvider(toolResponse, async ({ authFile }) => {
    const fixture = pluginContext();
    apply(fixture.ctx, Config({ authFile }));
    fixture.dispose();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(fixture.active, { adapters: 0, directories: 0 });
  });
});

test('unloading an initialized plugin removes its model route and picker directory', async () => {
  await withProvider(toolResponse, async ({ authFile }) => {
    const fixture = pluginContext();
    try {
      apply(fixture.ctx, Config({ authFile }));
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(fixture.active, { adapters: 1, directories: 1 });
    } finally { fixture.dispose(); }
    assert.deepEqual(fixture.active, { adapters: 0, directories: 0 });
  });
});

test('refresh updates the picker, subsequent card reads and status from one shared roster', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'minimax-refresh-'));
  const authFile = join(directory, 'missing-auth.json'); // status needs no upstream request
  const configFile = join(directory, 'config.yaml');
  const save = id => writeFileSync(configFile, `provider:\n  minimax:\n    models:\n      ${id}:\n        limit:\n          context: 32768\n          output: 2048\n`);
  const fixture = pluginContext();
  const routes = new Map();
  const events = [];
  let adapter;
  fixture.ctx.llm.registerAdapter = (ids, value) => { adapter = value; return () => {}; };
  fixture.ctx.emit = name => events.push(name);
  fixture.ctx.inject = (names, callback) => {
    if (names.length === 1 && names[0] === 'webServer') callback({
      webServer: { register(route) { routes.set(route.path, route.handler); return () => routes.delete(route.path); } },
      get: name => name === 'connection' ? { admit: () => ({ peer: { principal: { kind: 'owner' } } }) } : undefined,
    });
  };
  const get = async (name, query = '') => {
    let result;
    await routes.get(`/plugins/dsh-minimax-connect/${name}`)({
      method: 'GET', url: `/plugins/dsh-minimax-connect/${name}${query}`, socket: { remoteAddress: '127.0.0.1' },
    }, { writeHead(status) { assert.equal(status, 200); }, end(body) { result = JSON.parse(body); } });
    return result;
  };
  const ids = data => data.models.map(model => model.id);
  try {
    save('Fixture-A');
    apply(fixture.ctx, Config({ authFile, configFile, useMaximumContextWindow: true }));
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(adapter);
    assert.deepEqual(ids(await get('status')), ['Fixture-A']);
    save('Fixture-B');
    // A substring in another parameter must not trigger a refresh.
    assert.deepEqual(ids(await get('models', '?unrelated=refresh=1')), ['Fixture-A']);
    assert.deepEqual(ids(await get('models', '?refresh=1')), ['Fixture-B']);
    assert.deepEqual((await adapter.listModels('minimax')).map(model => model.id), ['Fixture-B']);
    const resolved = await adapter.resolveModel('minimax', 'Fixture-B');
    assert.equal(resolved.context.contextWindow, 32768, 'maximum-context mode must respect the declared limit');
    await assert.rejects(adapter.resolveModel('minimax', 'Fixture-A'), 'removed model must not remain routable');
    assert.deepEqual(ids(await get('models')), ['Fixture-B']);
    assert.deepEqual(ids(await get('status')), ['Fixture-B']);
    assert.ok(events.includes('llm/adapters-updated'));
  } finally { fixture.dispose(); rmSync(directory, { recursive: true, force: true }); }
});

test('all plugin routes require the authenticated DSH owner and fail closed without Connection', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'minimax-route-auth-'));
  const fixture = pluginContext();
  const routes = new Map();
  let connection;
  fixture.ctx.inject = (names, callback) => {
    if (names.length === 1 && names[0] === 'webServer') callback({
      webServer: { register(route) { routes.set(route.path, route.handler); return () => routes.delete(route.path); } },
      get: name => name === 'connection' ? connection : undefined,
    });
  };
  const call = async (path, options = {}) => {
    let result;
    await routes.get(path)({ method: path.endsWith('/claim') || path.endsWith('/__save') ? 'POST' : 'GET',
      url: path, socket: { remoteAddress: options.address ?? '127.0.0.1' }, headers: options.headers ?? {},
    }, { writeHead(status) { result = status; }, end() {} });
    return result;
  };
  try {
    apply(fixture.ctx, Config({ authFile: join(directory, 'missing.json'), configFile: join(directory, 'missing.yaml') }));
    assert.equal(routes.size, 7);
    for (const [admission, expected] of [
      [undefined, 503], [{ rejection: 401 }, 401], [{ rejection: 403 }, 403],
      [{ peer: { principal: { kind: 'operator' } } }, 403],
    ]) {
      connection = admission ? { admit: () => admission } : undefined;
      for (const path of routes.keys()) assert.equal(await call(path), expected, path);
    }
    connection = { admit: () => ({ peer: { principal: { kind: 'owner' } } }) };
    assert.equal(await call('/plugins/dsh-minimax-connect/models'), 200);
    assert.equal(await call('/plugins/dsh-minimax-connect/models', { address: '198.51.100.5' }), 403);
  } finally {
    fixture.dispose();
    await new Promise(resolve => setImmediate(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
});
