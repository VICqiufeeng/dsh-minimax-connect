/**
 * Host-mount contract for the 0.2.1-rc.2 fixes, without booting a host.
 *
 * `apply()` is the only entry the Loader calls, so the whole registration path
 * can be exercised against a stub context: route ids, the configurable-provider
 * declaration, the settings presentation policy, and the absence of warnings.
 *
 *   node test/host-apply.mjs
 *
 * The plugin under test is copied into a scratch directory whose `node_modules`
 * holds symlinks to the host's own packages, so peer `import()` calls resolve
 * exactly the way the host overlay does — the repo itself deliberately has no
 * `node_modules`, because a link-installed plugin must resolve peers through
 * the host.
 */
import assert from 'node:assert/strict';
import { cp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = '/Applications/DSH Desktop Beta.app/Contents/Resources/app/node_modules';
const REPO = new URL('..', import.meta.url).pathname;
const SCRATCH = join(tmpdir(), 'dsh-minimax-connect-stub');

await rm(SCRATCH, { recursive: true, force: true });
await mkdir(join(SCRATCH, 'lib'), { recursive: true });
await cp(join(REPO, 'lib', 'index.js'), join(SCRATCH, 'lib', 'index.js'));
await cp(join(REPO, 'package.json'), join(SCRATCH, 'package.json'));

const links = [
  ['@deepseek-ai/schemastery', `${APP}/@deepseek-ai/schemastery`],
  ['@deepseek-ai/dsh-llm', `${APP}/@deepseek-ai/dsh-llm`],
  ['@deepseek-ai/dsh-llm-pi-ai', `${APP}/@deepseek-ai/dsh-llm-pi-ai`],
  ['@earendil-works/pi-ai', `${APP}/@earendil-works/pi-ai`],
];
for (const [name, target] of links) {
  const path = join(SCRATCH, 'node_modules', ...name.split('/'));
  await mkdir(join(path, '..'), { recursive: true });
  await symlink(target, path, 'dir');
}

const { apply } = await import(`file://${join(SCRATCH, 'lib', 'index.js')}`);

// ---- stub context ---------------------------------------------------------
const events = { adapters: [], directories: [], settings: [], warnings: [], errors: [], routes: [] };
const volatile = (value) => ({ get: () => value });
const config = {
  enabledModelIds: volatile({}),
  imageOverrides: volatile({}),
  useMaximumContextWindow: volatile(false),
};

const routes = [];
const webServer = {
  register(route) {
    routes.push(route.path);
    return () => {};
  },
};

const settings = {
  configure(presentation) {
    events.settings.push(presentation);
    return () => {};
  },
  describe: () => [{ ns: 'llm-minimax', value: {} }],
  mutate: async () => {},
};

const ctx = {
  logger: {
    info: () => {},
    warn: (...args) => events.warnings.push(args),
    error: (...args) => events.errors.push(args),
  },
  fiber: { entry: { options: { id: 'llm-minimax' } } },
  get: (name) => (name === 'settings' ? settings : name === 'webServer' ? webServer : undefined),
  inject: (names, callback) => {
    // Cordis hands the callback a child context whose properties are the
    // injected services; mirror that shape.
    const child = { ...ctx };
    if (names.includes('webServer')) child.webServer = webServer;
    if (names.includes('settings')) child.settings = settings;
    callback(child);
    return () => {};
  },
  effect: (factory) => {
    const disposer = factory();
    return typeof disposer === 'function' ? disposer : () => {};
  },
  llm: {
    registerAdapter(providerIds, adapter) {
      events.adapters.push({ providerIds, adapter });
      return () => {};
    },
    registerConfigurableProviders(entries) {
      events.directories.push(entries);
      return { replace() {} };
    },
  },
};

apply(ctx, config);

// The provider path is async (peers are ESM); give it room to settle.
const deadline = Date.now() + 15_000;
while (Date.now() < deadline && events.adapters.length === 0 && events.errors.length === 0) {
  await new Promise((resolve) => setTimeout(resolve, 100));
}

assert.deepEqual(events.errors, [], 'apply() must not log errors');
assert.deepEqual(events.warnings, [], 'apply() must not log warnings');
assert.deepEqual(events.adapters.map((entry) => entry.providerIds), [['minimax-code']], 'the route id must be its own, not pi-ai catalog "minimax"');
assert.equal(events.directories.length, 1, 'the provider must be declared to the configurable directory');
assert.equal(events.directories[0][0].provider, 'minimax-code');
assert.equal(events.directories[0][0].settingsNs, 'llm-minimax');
assert.deepEqual(events.settings, [{ auto: false }], 'the settings policy must opt out of the auto form');
assert.ok(routes.length >= 7, `expected the card routes to register, got ${routes.length}`);
assert.ok(routes.includes('/plugins/dsh-minimax-connect/panel'));
assert.ok(routes.includes('/plugins/dsh-minimax-connect/__save'));

await writeFile(join(SCRATCH, 'result.json'), JSON.stringify(events.routes));
console.log('host-apply: OK', { provider: events.adapters[0].providerIds[0], routes: routes.length });
await rm(SCRATCH, { recursive: true, force: true });
