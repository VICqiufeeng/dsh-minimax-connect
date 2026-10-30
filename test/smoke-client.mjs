/**
 * Drive the client half's `apply()` against a stub host.
 *
 * `lib/client.js` is not an ES module — it is a bare `__ModuleLoader__.load`
 * envelope — so it is evaluated in a VM context with a stub `window`, and the
 * captured factory is then called with a stub `require`. What this proves is
 * the part that regressed on the 0.2 line: every slot is seated under the field
 * its kind actually requires (`id` for the list slot, `key` for the three keyed
 * ones), the settings namespace handed to `configForms` is the Loader row id,
 * and no slot the build does not declare is registered.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

let envelope;
const sandbox = {
  window: { __ModuleLoader__: { load(spec) { envelope = spec; } } },
  console,
};
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: 'lib/client.js' });

assert.equal(envelope.id, 'dsh-minimax-connect');

const React = {
  useState: (initial) => [initial, () => {}],
  useCallback: (fn) => fn,
  useEffect: () => {},
  createElement: () => null,
};
const jsxRuntime = { jsx: () => null, jsxs: () => null, Fragment: 'Fragment' };

const registered = [];
const formNamespaces = [];
const effects = [];

const ctx = {
  effect(fn, label) {
    effects.push(label);
    const dispose = fn();
    return typeof dispose === 'function' ? dispose : () => {};
  },
  locale: {
    register: () => () => {},
    bind: (ns) => (key) => `${ns}:${key}`,
  },
  configForms: {
    get(ns) {
      formNamespaces.push(ns);
      return { namespace: ns, set: async () => true };
    },
  },
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

const exportsObject = envelope.factory((id) => (id === 'react' ? React : jsxRuntime));
exportsObject.apply(ctx);

console.log('--- registered slots');
for (const { options } of registered) {
  const cell = options.id !== undefined ? `id=${options.id}` : `key=${options.key}`;
  console.log(` ${options.name}  ${cell}  locale=${options.locale}`);
}

const byName = new Map(registered.map((r) => [r.options.name, r.options]));

console.log('--- kind-correct cell fields');
assert.equal(byName.get('settings.section').id, 'minimax-connect', 'list slot takes id');
assert.equal(byName.get('settings.section').key, undefined);
assert.equal(byName.get('plugins.bundle.config').key, 'dsh-minimax-connect', 'keyed slot takes key');
assert.equal(byName.get('plugins.bundle.config').id, undefined);
assert.equal(byName.get('plugins.row.config').key, 'dsh-minimax-connect#llm-minimax', 'row key is <package>#<row id>');
assert.equal(byName.get('settings.models.provider-card').key, 'llm-minimax', 'provider card keyed by settingsNs');
console.log(' settings.section             id=minimax-connect');
console.log(' plugins.bundle.config        key=dsh-minimax-connect');
console.log(' plugins.row.config           key=dsh-minimax-connect#llm-minimax');
console.log(' settings.models.provider-card key=llm-minimax');

console.log('--- removed slot stays removed');
assert.equal(byName.has('settings.plugin.item'), false, 'settings.plugin.item does not exist on 0.2');

console.log('--- settings namespace');
assert.deepEqual(formNamespaces, ['llm-minimax'], 'configForms must be asked for the Loader row id');
console.log(' configForms.get ->', JSON.stringify(formNamespaces));

console.log('--- locale + inject face');
assert.equal(byName.get('settings.section').locale, 'settings.minimax-connect');
const face = byName.get('settings.section').inject();
assert.deepEqual(Object.keys(face).sort(), ['form', 't']);
assert.equal(face.form.namespace, 'llm-minimax');
console.log(' face keys:', JSON.stringify(Object.keys(face).sort()), '| form.namespace:', face.form.namespace);

console.log('--- exports');
// The array comes out of the VM realm, so its prototype differs from this
// realm's Array.prototype; compare the values, not the prototype chain.
assert.equal(JSON.stringify(Array.from(exportsObject.inject)), JSON.stringify(['slots', 'locale', 'configForms']));
assert.equal(exportsObject.name, 'dsh-minimax-connect-client');
console.log(' inject:', JSON.stringify(Array.from(exportsObject.inject)));

console.log('\nALL OK');
