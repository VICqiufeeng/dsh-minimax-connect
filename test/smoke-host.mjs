/**
 * Drive `apply()` against a stub host.
 *
 * The point is not to emulate DSH — it is to prove that the wiring this version
 * claims to do actually runs: the settings presentation is configured, the
 * adapter and the configurable-provider directory both register, and every
 * route the card depends on gets a registration call.
 *
 * Run with:  node test/smoke-host.mjs
 *
 * `lib/index.js` imports its peers bare (`@deepseek-ai/schemastery`,
 * `@earendil-works/pi-ai`, …), so this only resolves from an installed copy —
 * inside `<profile>/node_modules/dsh-minimax-connect/`, or a scratch directory
 * whose `node_modules` links the profile's. From the bare source checkout the
 * peer imports fail with ERR_MODULE_NOT_FOUND before apply() is reached.
 * `test/smoke-client.mjs` has no peers and runs anywhere.
 */
import assert from 'node:assert/strict';

const mod = await import('../lib/index.js');

const effects = [];
const configured = [];
const routes = [];
const adapters = [];
const directories = [];

const settingsService = {
  configure(presentation, owner) {
    configured.push({ presentation, owner });
    return () => {};
  },
};

const webServer = {
  register(route) {
    routes.push(route);
    return () => {};
  },
};

const ctx = {
  fiber: { marker: 'this-plugin-fiber' },
  logger: { info() {}, warn() {}, error() {} },
  effect(fn, label) {
    effects.push(label);
    const dispose = fn();
    return dispose;
  },
  emit() {},
  get(name) {
    if (name === 'settings') return settingsService;
    if (name === 'webServer') return webServer;
    return undefined;
  },
  inject(names, callback) {
    const child = {
      settings: settingsService,
      webServer,
      effect: ctx.effect,
      logger: ctx.logger,
      get: ctx.get,
    };
    callback(child);
  },
  llm: {
    registerAdapter(providers, adapter) {
      adapters.push({ providers, adapter });
      return () => {};
    },
    registerConfigurableProviders(entries) {
      directories.push(entries);
      return () => {};
    },
  },
};

mod.apply(ctx, mod.Config({}));

// The adapter build is async (peers load through `import()`), so give it a beat.
await new Promise((resolve) => setTimeout(resolve, 600));

console.log('--- settings presentation');
assert.equal(configured.length, 1, 'configure() should run exactly once');
assert.deepEqual(configured[0].presentation, { auto: false });
assert.equal(configured[0].owner, ctx.fiber, 'owner must be this plugin fiber');
console.log('configure:', JSON.stringify(configured[0].presentation), '| owner is the plugin fiber');

console.log('--- routes');
const paths = routes.map((r) => `${r.kind} ${r.path}`).sort();
for (const p of paths) console.log(' ', p);
assert.equal(routes.length, 7, `expected 7 routes, got ${routes.length}`);
assert.ok(routes.every((r) => r.kind === 'exact'), 'every route must be exact');

console.log('--- llm registration');
assert.equal(adapters.length, 1, 'adapter should register');
assert.deepEqual(adapters[0].providers, ['minimax']);
assert.equal(directories.length, 1, 'directory should register');
assert.deepEqual(directories[0][0], {
  provider: 'minimax',
  displayName: 'MiniMax Code',
  settingsNs: 'llm-minimax',
  settingsPath: [],
  declared: false,
});
console.log('adapter providers:', JSON.stringify(adapters[0].providers));
console.log('directory:', JSON.stringify(directories[0][0]));

console.log('--- effects');
for (const label of effects) console.log(' ', label);

console.log('\nALL OK');
