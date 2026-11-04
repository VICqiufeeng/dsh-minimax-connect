/**
 * Render the model list from the real `config.yaml`, without a running host.
 *
 * `test/render-card.mjs` needs a live `/status`, so it can only see facts the
 * *installed* host half already publishes. This one closes the other gap: it
 * parses the config on disk with the host half's own parser, builds the payload
 * the route would return, and walks the client's element tree — so the new
 * columns can be checked before the app is restarted.
 *
 * `lib/index.js` imports its peers bare, so this only resolves from a directory
 * whose `node_modules` reaches them (an installed copy). From the bare checkout
 * it fails with ERR_MODULE_NOT_FOUND before anything renders.
 *
 * Run with:  node test/render-models.mjs [configPath]
 */
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const { __diagnostics: D } = await import('../lib/index.js');
const configPath = process.argv[2] ?? D.defaultConfigFile();
const clientPath = fileURLToPath(new URL('../lib/client.js', import.meta.url));

/* ------------------------------------------------- payload, built the way /models builds it */
const parsed = D.parseModels(configPath);
if (parsed.models.length === 0) throw new Error(`no models parsed from ${configPath}`);
const status = { source: parsed.source, models: parsed.models, desktop: parsed.desktop };

/* ------------------------------------------------------------------ React stand-in */
let states = [];
let cursor = 0;
let effects = [];
let dirty = false;

const React = {
  createElement: (type, props, ...children) => ({
    type,
    props: { ...(props ?? {}), children: children.length > 1 ? children : children[0] },
  }),
  useState(init) {
    const index = cursor;
    cursor += 1;
    if (states.length <= index) states[index] = typeof init === 'function' ? init() : init;
    return [states[index], (next) => { states[index] = typeof next === 'function' ? next(states[index]) : next; dirty = true; }];
  },
  useEffect(fn) { effects.push(fn); },
  useLayoutEffect(fn) { effects.push(fn); },
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useRef: (value) => ({ current: value }),
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  Fragment: Symbol('Fragment'),
};
const jsxRuntime = { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }), Fragment: React.Fragment };

/* ------------------------------------------------------------- load the client half */
const source = fs.readFileSync(clientPath, 'utf8');
let envelope;
const sandbox = {
  window: { __ModuleLoader__: { load(spec) { envelope = spec; } } },
  console,
  setTimeout,
  clearTimeout,
  fetch: async (url) => {
    const href = String(url);
    const payload = href.includes('/models')
      ? { source: status.source, models: status.models, desktop: status.desktop }
      : status;
    return { ok: true, status: 200, text: async () => JSON.stringify(payload), json: async () => payload };
  },
  document: {
    createElement: () => ({ setAttribute() {}, appendChild() {}, dataset: {} }),
    head: { appendChild() {} },
    querySelector: () => null,
  },
};
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: 'lib/client.js' });
if (envelope === undefined) throw new Error('client.js never called window.__ModuleLoader__.load');

const module_ = envelope.factory((specifier) => {
  if (specifier === 'react') return React;
  if (specifier === 'react/jsx-runtime') return jsxRuntime;
  throw new Error(`unexpected client dependency: ${specifier}`);
});

/* --------------------------------------------------------------- run the plugin apply */
const registered = [];
const ctx = {
  effect(fn) { const disposer = fn(); return typeof disposer === 'function' ? disposer : () => {}; },
  locale: { register: () => () => {}, bind: () => (key) => key },
  configForms: {
    get: (namespace) => ({
      namespace,
      getSnapshot: () => ({ status: 'ready', value: {}, base: {}, user: {}, revision: 0, writable: true }),
      subscribe: () => () => {},
      set: async () => true,
    }),
  },
  slots: { inject(_slot, callback) { return callback(); }, register(options, component) { registered.push({ options, component }); return () => {}; } },
  get() { return undefined; },
};
module_.apply(ctx);

const seat = registered.find((entry) => entry.options.name === 'settings.section');
if (seat === undefined) throw new Error('the card was never registered on settings.section');

/* --------------------------------------------- drive the card through its own effects */
async function renderComponent(component, props) {
  let tree;
  for (let pass = 0; pass < 12; pass += 1) {
    cursor = 0;
    effects = [];
    dirty = false;
    tree = component(props);
    for (const effect of effects) {
      try { effect(); } catch { /* the card's own effect guards its failures */ }
    }
    await new Promise((resolve) => setImmediate(resolve));
    if (!dirty) break;
  }
  return tree;
}

const card = await renderComponent(seat.component, { t: (key) => key });

/* ------------------------------------------------------------------ walk the element tree */
function textOf(node) {
  if (node === null || node === undefined || node === false || node === true) return [];
  if (typeof node === 'string' || typeof node === 'number') return [String(node)];
  if (Array.isArray(node)) return node.flatMap(textOf);
  if (typeof node === 'object' && 'props' in node) return textOf(node.props.children);
  return [];
}

function findByComponentName(node, name, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out;
  if (Array.isArray(node)) { node.forEach((child) => findByComponentName(child, name, out)); return out; }
  if (typeof node.type === 'function' && node.type.name === name) out.push(node);
  if (node.props && 'children' in node.props) findByComponentName(node.props.children, name, out);
  return out;
}

const lists = findByComponentName(card, 'ModelList');
if (lists.length === 0) {
  console.log('the card renders no <ModelList> block.');
  console.log('card text:', textOf(card).join(' | ').slice(0, 400));
  process.exit(1);
}

const rows = status.models;
const tree = lists[0].type({
  rows,
  draft: {
    enabled: Object.fromEntries(rows.map((model) => [model.id, true])),
    image: Object.fromEntries(rows.map((model) => [model.id, 'auto'])),
    maxCtx: false,
  },
  setDraft: () => {},
  activeCount: rows.length,
  totalCount: rows.length,
  source: status.source,
  desktop: status.desktop,
  onRefresh: () => {},
  refreshing: false,
});

const lines = textOf(tree).map((line) => line.trim()).filter((line) => line !== '');
console.log(`--- model list, parsed from ${configPath} (source: ${status.source}) ---`);
for (const line of lines) console.log('  ' + line);

/* ------------------------------------------------------------------------- assertions */
const joined = lines.join('\n');
const checks = [];
const ladder = rows.find((model) => Array.isArray(model.efforts) && model.efforts.length > 0);
if (ladder) checks.push(['思考档位', ladder.efforts.filter((x) => x !== 'default').join('/')]);
const attach = rows.find((model) => model.maxAttachments > 0);
if (attach) checks.push(['单轮附件上限', String(attach.maxAttachments)]);
const summary = rows.find((model) => model.reasoningSummary);
if (summary) checks.push(['思考摘要', summary.reasoningSummary]);
if (status.desktop?.defaultModel) {
  const id = String(status.desktop.defaultModel).split('/').pop();
  checks.push(['桌面端默认模型', rows.find((model) => model.id === id)?.name ?? id]);
}

console.log('');
const missing = checks.filter(([label, value]) => !joined.includes(label) || !joined.includes(value));
if (missing.length > 0) {
  console.log(`MISSING: ${missing.map(([label, value]) => `${label}=${value}`).join(', ')}`);
  process.exit(1);
}
console.log(`OK — model list renders ${lines.length} lines from the real config, with ${checks.length} upgraded facts.`);

/* ---------------------------------------------- the descriptor the host hands to pi-ai */
const descriptors = rows.map((model) => D.toPiModel(model, 'https://agent.minimax.cn/mavis/api/v1/llm', {}));
console.log('');
console.log('--- pi descriptors (what DSH turns into a reasoning picker) ---');
for (const pi of descriptors) {
  console.log(`  ${pi.id}: input=${pi.input.join('+')} ctx=${pi.contextWindow} max=${pi.maxTokens}` +
    ` thinkingLevelMap=${pi.thinkingLevelMap ? JSON.stringify(pi.thinkingLevelMap) : '—'}` +
    ` forceAdaptiveThinking=${pi.compat?.forceAdaptiveThinking === true}`);
}
const mapped = descriptors.filter((pi) => pi.thinkingLevelMap !== undefined);
if (mapped.length === 0) {
  console.log('no descriptor carries a thinkingLevelMap — the effort ladder would not reach the host.');
  process.exit(1);
}
for (const pi of mapped) {
  if (pi.compat?.forceAdaptiveThinking !== true) {
    console.log(`${pi.id} carries a thinkingLevelMap without forceAdaptiveThinking — pi-ai would take the budget branch.`);
    process.exit(1);
  }
}
console.log(`OK — ${mapped.length} descriptor(s) publish a ladder, all paired with forceAdaptiveThinking.`);
