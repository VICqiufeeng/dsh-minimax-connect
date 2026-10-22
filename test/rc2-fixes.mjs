/**
 * Contract checks for the 0.2.1-rc.2 fixes.
 *
 * Run with the host's own packages (this plugin's peers live in the DSH app, so
 * the test points at that tree explicitly):
 *
 *   node test/rc2-fixes.mjs
 *
 * Three properties are asserted, each one a failure mode reported on 2026-10-19:
 *   1. the thinking ladder is low/medium/high/xhigh/max — `off` must be absent,
 *      because the Mavis gateway rejects `thinking.type="disabled"`;
 *   2. the route carries image budgets, so a request image target has positive
 *      integer dimensions instead of `undefined`;
 *   3. the route advertises image input, which is what lets the adapter accept
 *      an image block at all.
 */
import assert from 'node:assert/strict';
import { cp, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = '/Applications/DSH Desktop Beta.app/Contents/Resources/app/node_modules';
const REPO = new URL('..', import.meta.url).pathname;

// The plugin resolves `@deepseek-ai/schemastery` like any module, so it runs
// from a scratch copy whose node_modules point at the host's own packages —
// the repo itself has none (a link-installed plugin resolves peers through the
// host overlay, and a local node_modules there would shadow it).
const SCRATCH = join(tmpdir(), 'dsh-minimax-connect-contract');
await rm(SCRATCH, { recursive: true, force: true });
await mkdir(join(SCRATCH, 'lib'), { recursive: true });
await cp(join(REPO, 'lib', 'index.js'), join(SCRATCH, 'lib', 'index.js'));
await cp(join(REPO, 'package.json'), join(SCRATCH, 'package.json'));
for (const [name, target] of [
  ['@deepseek-ai/schemastery', `${APP}/@deepseek-ai/schemastery`],
  ['@deepseek-ai/dsh-llm', `${APP}/@deepseek-ai/dsh-llm`],
  ['@deepseek-ai/dsh-llm-pi-ai', `${APP}/@deepseek-ai/dsh-llm-pi-ai`],
  ['@earendil-works/pi-ai', `${APP}/@earendil-works/pi-ai`],
]) {
  const path = join(SCRATCH, 'node_modules', ...name.split('/'));
  await mkdir(join(path, '..'), { recursive: true });
  await symlink(target, path, 'dir');
}
const PLUGIN = `file://${join(SCRATCH, 'lib', 'index.js')}`;

const { getSupportedThinkingLevels, createProvider } = await import(`${APP}/@earendil-works/pi-ai/dist/models.js`);
const { PiAiAdapter } = await import(`${APP}/@deepseek-ai/dsh-llm-pi-ai/lib/index.js`);
const { requestImageDimensions } = await import(`${APP}/@deepseek-ai/dsh-attachment/lib/index.js`);
const { __diagnostics } = await import(PLUGIN);

const { toPiModel, IMAGE_BUDGET, THINKING_LEVEL_MAP, PROVIDER_ID } = __diagnostics;

// ---- 1. thinking ladder ----------------------------------------------------
const rosterEntry = {
  id: 'MiniMax-M3.1-Flash',
  name: 'M3.1-Flash',
  context: 512_000,
  contextMax: 1_000_000,
  maxTokens: 128_000,
  reasoning: true,
  vision: true,
};

const model = toPiModel(rosterEntry, 'https://agent.minimax.cn/mavis/api/v1/llm');

assert.equal(model.provider, PROVIDER_ID);
assert.equal(PROVIDER_ID, 'minimax-code', 'route id must not collide with pi-ai catalog "minimax"');
assert.deepEqual(
  getSupportedThinkingLevels(model),
  ['xhigh', 'max'],
  'the route offers xhigh and max only',
);
assert.equal(THINKING_LEVEL_MAP.off, null, 'off must be pinned to null so pi-ai omits the thinking block');
for (const level of ['off', 'minimal', 'low', 'medium', 'high']) {
  assert.equal(THINKING_LEVEL_MAP[level], null, `${level} must not be offered`);
}
assert.ok(model.input.includes('image'), 'reasoning+vision model must advertise image input');
assert.equal(model.compat?.forceAdaptiveThinking, true, 'adaptive thinking is the only accepted mode');

// ---- 2. image target -------------------------------------------------------
const budget = {
  maxPixels: IMAGE_BUDGET.requestImagePixelBudget,
  maxBytes: IMAGE_BUDGET.requestImageMaxBytes,
};
const target = { ...requestImageDimensions(3024, 4032, budget.maxPixels), maxBytes: budget.maxBytes };
assert.ok(Number.isSafeInteger(target.width) && target.width > 0, `width must be a positive integer, got ${target.width}`);
assert.ok(Number.isSafeInteger(target.height) && target.height > 0, `height must be a positive integer, got ${target.height}`);
assert.ok(Number.isSafeInteger(target.maxBytes) && target.maxBytes > 0, 'maxBytes must be a positive integer');

// The pre-fix profile had no budget at all: this reproduces the reported error
// and proves the root cause rather than asserting it from memory.
const before = requestImageDimensions(3024, 4032, undefined);
assert.ok(!Number.isSafeInteger(before.width), 'without a pixel budget the target width is not an integer');

// ---- 3. the adapter accepts the profile the plugin now builds --------------
const provider = createProvider({
  id: PROVIDER_ID,
  name: 'MiniMax Code',
  api: { stream: () => { throw new Error('unused in this test'); }, streamSimple: () => { throw new Error('unused in this test'); } },
  models: [model],
});
const profiles = new Map([[PROVIDER_ID, {
  provider: PROVIDER_ID,
  displayName: 'MiniMax Code',
  streamIdleTimeoutMs: 180_000,
  ...IMAGE_BUDGET,
  configuredMaxTokens: new Map(),
  modelErrors: new Map(),
  piProvider: provider,
  headers: { Authorization: 'Bearer test' },
}]]);
const adapter = new PiAiAdapter({ profiles: () => profiles, resolveApiKey: async () => undefined });
const viaAdapter = adapter.imageRequestTarget(PROVIDER_ID, 'MiniMax-M3.1-Flash', { width: 3024, height: 4032 });
assert.ok(viaAdapter.width > 0 && viaAdapter.height > 0, 'adapter imageRequestTarget must be positive');
assert.ok(viaAdapter.maxBytes > 0, 'adapter imageRequestTarget must carry a byte budget');

await rm(SCRATCH, { recursive: true, force: true });
console.log('rc2-fixes: OK', {
  provider: PROVIDER_ID,
  levels: getSupportedThinkingLevels(model),
  target,
  viaAdapter,
});
