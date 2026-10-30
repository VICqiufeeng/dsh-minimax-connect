/**
 * Render the client card against the live host payload — no browser, no DOM.
 *
 * The client half is a React tree, but nothing in it needs a real renderer to
 * be *checked*: the card is a pure function of the host's `/status` snapshot.
 * So this loads `lib/client.js` exactly the way the app does (through the
 * `__ModuleLoader__` envelope), gives it a React stand-in with enough of a
 * state machine to survive the card's own `useEffect` fetch, and then walks the
 * resulting element tree to read what the user would actually see.
 *
 * Run with:  node test/render-card.mjs [statusUrl]
 */
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const STATUS_URL = process.argv[2] ?? 'http://127.0.0.1:61878/plugins/dsh-minimax-connect/status';
const clientPath = fileURLToPath(new URL('../lib/client.js', import.meta.url));

/* ------------------------------------------------------------------ live host payload */
const response = await fetch(STATUS_URL);
if (!response.ok) throw new Error(`status route answered ${response.status}`);
const status = await response.json();

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
    return [
      states[index],
      (next) => {
        states[index] = typeof next === 'function' ? next(states[index]) : next;
        dirty = true;
      },
    ];
  },
  useEffect(fn) { effects.push(fn); },
  useLayoutEffect(fn) { effects.push(fn); },
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useRef: (value) => ({ current: value }),
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  Fragment: Symbol('Fragment'),
};
const jsxRuntime = {
  jsx: (type, props) => ({ type, props }),
  jsxs: (type, props) => ({ type, props }),
  Fragment: React.Fragment,
};

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
      ? { source: status.modelsSource, models: status.models }
      : status;
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(payload),
      json: async () => payload,
    };
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
  effect(fn) {
    const disposer = fn();
    return typeof disposer === 'function' ? disposer : () => {};
  },
  locale: { register: () => () => {}, bind: () => (key) => key },
  configForms: {
    get: (namespace) => ({
      namespace,
      getSnapshot: () => ({ status: 'ready', value: {}, base: {}, user: {}, revision: 0, writable: true }),
      subscribe: () => () => {},
      set: async () => true,
    }),
  },
  slots: {
    inject(_slot, callback) { return callback(); },
    register(options, component) { registered.push({ options, component }); return () => {}; },
  },
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

const memberships = findByComponentName(card, 'Membership');
if (memberships.length === 0) {
  console.log('the card renders no <Membership> block — the subscription section is missing.');
  console.log('card text:', textOf(card).join(' | ').slice(0, 400));
  process.exitCode = 1;
} else {
  const lines = textOf(memberships[0].type({
    membership: status.membership,
    models: (status.models ?? []).map((model) => ({ id: model.id, name: model.name })),
  })).map((line) => line.trim()).filter((line) => line !== '');

  console.log('--- subscription block, rendered from the live /status payload ---');
  for (const line of lines) console.log('  ' + line);

  const joined = lines.join('\n');
  const must = ['订阅额度', '订阅类型', '倍用量', '额度余额'];
  const missing = must.filter((token) => !joined.includes(token));
  console.log('');
  if (missing.length > 0) {
    console.log(`MISSING rows: ${missing.join(', ')}`);
    process.exitCode = 1;
  } else {
    console.log(`OK — subscription block renders ${lines.length} lines from the live /status payload.`);
    console.log(`     membership.subscriptionType = ${JSON.stringify(status.membership?.subscriptionType)}`);
    console.log(`     membership.multiplier       = ${JSON.stringify(status.membership?.multiplier)} (null => the card prints 接口未返回)`);
    console.log(`     selfRenewal.generation      = ${JSON.stringify(status.selfRenewal?.generation)} (auto-renewals so far)`);
  }
}
