/**
 * Seat the client half on the *real* 0.2 SlotCore instead of a stub.
 *
 * The stub smoke test proves the shape of what we pass; this proves the core
 * accepts it. SlotCore rejects a cell field that does not match the slot kind
 * (`keyed` needs `key`, `list` needs `id`), so running the actual `register`
 * against the actual specs is the difference between "we pass `key`" and "the
 * 0.2 line takes `key`".
 *
 * Run with:  node test/smoke-slots-real.mjs
 *
 * This one reads the unpacked 0.2.1-rc.2 slot package from `.apicheck/`, which
 * is the scratch tree the upgrade was verified against and is not shipped, so
 * the script is a development check rather than part of the package.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const SLOTS_PACKAGE = new URL(
  '../.apicheck/extracted/deepseek-ai-dsh-client-ui-slots-0.2.1-rc.2/package/lib/index.js',
  import.meta.url,
);

if (!fs.existsSync(SLOTS_PACKAGE)) {
  console.log('SKIP: the unpacked 0.2.1-rc.2 slot package is not in .apicheck/.');
  console.log('      Run `npm pack @deepseek-ai/dsh-client-ui-slots@0.2.1-rc.2` and unpack it there,');
  console.log('      or rely on test/smoke-client.mjs, which needs no peers.');
  process.exit(0);
}

const { SlotCore } = await import(SLOTS_PACKAGE);

// The kinds as the four shipped slot tables declare them.
const SPECS = {
  'settings.section': { kind: 'list', scope: 'root' },
  'plugins.bundle.config': { kind: 'keyed', scope: 'root' },
  'plugins.row.config': { kind: 'keyed', scope: 'root' },
  'settings.models.provider-card': { kind: 'keyed', scope: 'root' },
};

const core = new SlotCore();
// A real host declares slots through a parent entry's children table. That
// table is not reachable from here, so install the specs directly — the check
// under test is the per-kind cell validation inside register(), not declaration.
// `record()` is the core's own accessor: it creates the record with an empty
// entry array, which is exactly the state a declared-but-unoccupied slot has.
for (const [name, spec] of Object.entries(SPECS)) {
  core.record(name).spec = spec;
}

// --- capture what lib/client.js registers -------------------------------
const source = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
let envelope;
const sandbox = { window: { __ModuleLoader__: { load(spec) { envelope = spec; } } }, console };
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: 'lib/client.js' });

const registered = [];
const ctx = {
  effect(fn) {
    const dispose = fn();
    return typeof dispose === 'function' ? dispose : () => {};
  },
  locale: { register: () => () => {}, bind: (ns) => (key) => `${ns}:${key}` },
  configForms: { get: (ns) => ({ namespace: ns, set: async () => true }) },
  slots: {
    inject(slot, callback) {
      callback();
      return () => {};
    },
    register(options, component) {
      registered.push({ options, component });
      return () => {};
    },
  },
};

const React = {
  useState: (initial) => [initial, () => {}],
  useCallback: (fn) => fn,
  useEffect: () => {},
  createElement: () => null,
};
const jsx = { jsx: () => null, jsxs: () => null, Fragment: 'Fragment' };
envelope.factory((id) => (id === 'react' ? React : jsx)).apply(ctx);

// --- replay every registration through the real core --------------------
console.log('--- real SlotCore.register');
for (const { options } of registered) {
  // guardedSlots would stamp a priority; do the same so `single` ordering rules
  // are exercised the way the runtime exercises them.
  const stamped = { ...options, priority: 0 };
  core.register(stamped, () => null);
  const kind = SPECS[options.name].kind;
  const cell = kind === 'keyed' ? `key=${options.key}` : `id=${options.id}`;
  console.log(` ok  ${options.name} (${kind})  ${cell}`);
}

console.log('--- entries landed in the core');
for (const name of Object.keys(SPECS)) {
  const entries = core.entries(name);
  assert.equal(entries.length, 1, `${name} should hold exactly one entry`);
  const [entry] = entries;
  const kind = SPECS[name].kind;
  if (kind === 'keyed') assert.ok(entry.options.key !== undefined, `${name} entry must carry key`);
  else assert.ok(entry.options.id !== undefined, `${name} entry must carry id`);
  console.log(` ${name}  entries=${entries.length}  locale=${entry.locale ?? '(none)'}`);
}

console.log('--- nothing registered against an undeclared slot');
for (const { options } of registered) {
  assert.ok(SPECS[options.name] !== undefined, `${options.name} is not in the 0.2 slot table`);
}

console.log('\nALL OK');
