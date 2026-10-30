/**
 * Compatibility, measured against the versions that actually matter.
 *
 * The target is one plugin: written against the newest DSH line, and still
 * running on the older ones. So the matrix runs the newest first — that is the
 * version the code is written for — then walks back to the oldest version this
 * plugin still claims. `alpha.2` is not in the walk: it is a different line
 * (`0.2.2-*`) that nobody here runs, and supporting it would mean carrying
 * alpha-only branches for a version that is not on the machine.
 *
 * Every verdict comes from that version's own package, never from our notes.
 *
 * Run with:  node test/matrix.mjs
 */
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

// Newest first: the version the code is written for, then down to the floor.
const NEWEST = '0.2.1-rc.5';
const FLOOR = '0.2.1-rc.2';
const VERSIONS = ['0.2.1-rc.5', '0.2.1-rc.4', '0.2.1-rc.3', '0.2.1-rc.2'];
const root = new URL('../.apicheck/extracted/', import.meta.url);

const exists = (url) => fs.existsSync(fileURLToPath(url));
const dir = (pkg, version) => new URL(`deepseek-ai-${pkg}-${version}/package/`, root);

if (!exists(root)) {
  console.log('SKIP: .apicheck/extracted/ is not present (scratch tree from the upgrade work).');
  process.exit(0);
}

// The four slots this plugin seats, with the kind each version's table declares.
const SEATS = {
  'settings.section': { kind: 'list', scope: 'root' },
  'plugins.bundle.config': { kind: 'keyed', scope: 'root' },
  'plugins.row.config': { kind: 'keyed', scope: 'root' },
  'settings.models.provider-card': { kind: 'keyed', scope: 'root' },
};

// What the host half calls on the settings service, and what it must not rely on.
const SETTINGS_REQUIRED = ['configure', 'describe', 'mutate'];
const SETTINGS_FORBIDDEN = ['installSection'];

// What the host half calls on the llm service, and the two symbols it imports.
const LLM_REQUIRED = ['registerAdapter', 'registerConfigurableProviders'];
const LLM_EXPORTS = ['resolveImageAttachmentAccess'];
const PI_AI_EXPORTS = ['PiAiAdapter'];

/** Extract one class body from minified-ish source by brace counting. */
function classBody(source, name) {
  // Both shapes the packages use: `var X = class ...` and `return class X extends ...`.
  const head = new RegExp(`(?:var|let|const)\\s+${name}\\s*=\\s*class[^{]*\\{|return\\s+class\\s+${name}\\s+extends[^{]*\\{`).exec(source);
  if (!head) return undefined;
  let depth = 1;
  let i = head.index + head[0].length;
  for (; i < source.length && depth > 0; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') depth -= 1;
  }
  return source.slice(head.index + head[0].length, i - 1);
}

/** A method exists in this class body if its name is followed by `(`. */
const hasMethod = (body, name) => new RegExp(`(^|[^\\w.$])${name}\\s*\\(`, 'm').test(body);

const clientSource = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

/** Evaluate lib/client.js and capture the slots it asks for. */
function captureRegistrations() {
  let envelope;
  const sandbox = { window: { __ModuleLoader__: { load(spec) { envelope = spec; } } }, console };
  vm.createContext(sandbox);
  vm.runInContext(clientSource, sandbox, { filename: 'lib/client.js' });

  const registered = [];
  const ctx = {
    effect(fn) {
      const dispose = fn();
      return typeof dispose === 'function' ? dispose : () => {};
    },
    locale: { register: () => () => {}, bind: (ns) => (key) => `${ns}:${key}` },
    configForms: { get: (ns) => ({ namespace: ns, set: async () => true }) },
    slots: {
      inject(slot, callback) { callback(); return () => {}; },
      register(options) { registered.push(options); return () => {}; },
    },
  };
  const React = {
    useState: (v) => [v, () => {}],
    useCallback: (fn) => fn,
    useEffect: () => {},
    createElement: () => null,
  };
  const jsx = { jsx: () => null, jsxs: () => null, Fragment: 'Fragment' };
  envelope.factory((id) => (id === 'react' ? React : jsx)).apply(ctx);
  return registered;
}

const registrations = captureRegistrations();
const rows = [];

for (const version of VERSIONS) {
  const slotsEntry = new URL('lib/index.js', dir('dsh-client-ui-slots', version));
  const settingsEntry = new URL('lib/index.js', dir('dsh-settings', version));

  const row = { version, slots: 'n/a', settings: 'n/a', llm: 'n/a', adapter: 'n/a', notes: [] };

  // --- slots: does this version's own core accept what we pass? ---
  if (exists(slotsEntry)) {
    const { SlotCore } = await import(slotsEntry);
    const core = new SlotCore();
    let seated = 0;
    for (const [name, spec] of Object.entries(SEATS)) {
      core.record(name).spec = spec;
    }
    for (const options of registrations) {
      try {
        core.register({ ...options, priority: 0 }, () => null);
        seated += 1;
      } catch (error) {
        row.notes.push(`register ${options.name}: ${error.message}`);
      }
    }
    row.slots = `${seated}/${registrations.length}`;
  }

  // --- settings: the methods the host half calls, from that version's own class ---
  // The package imports `yaml` at load time, so it is scanned rather than
  // executed; the class body is what matters, not the whole file.
  if (exists(settingsEntry)) {
    const source = fs.readFileSync(settingsEntry, 'utf8');
    const body = classBody(source, 'SettingsForms') ?? '';
    const missing = SETTINGS_REQUIRED.filter((m) => !hasMethod(body, m));
    const present = SETTINGS_FORBIDDEN.filter((m) => hasMethod(body, m));
    if (missing.length === 0 && present.length === 0) {
      row.settings = 'ok';
    } else {
      row.settings = missing.length ? `missing ${missing.join(',')}` : `has ${present.join(',')}`;
      if (missing.length) row.notes.push(`settings missing: ${missing.join(', ')}`);
      if (present.length) row.notes.push(`settings unexpectedly has: ${present.join(', ')}`);
    }
  }

  // --- llm service: the two registration methods the host half calls ---
  const llmEntry = new URL('lib/index.js', dir('dsh-llm', version));
  if (exists(llmEntry)) {
    const source = fs.readFileSync(llmEntry, 'utf8');
    const body = classBody(source, 'LlmRuntime') ?? '';
    const missing = LLM_REQUIRED.filter((m) => !hasMethod(body, m));
    const exported = LLM_EXPORTS.filter((n) => !new RegExp(`export\\s*\\{[^}]*\\b${n}\\b`).test(source));
    if (missing.length === 0 && exported.length === 0) {
      row.llm = 'ok';
    } else {
      row.llm = missing.length ? `missing ${missing.join(',')}` : `no export ${exported.join(',')}`;
      row.notes.push(`llm: ${row.llm}`);
    }
  }

  // --- pi-ai adapter: the class we construct, and the profile fields it reads ---
  const adapterEntry = new URL('lib/index.js', dir('dsh-llm-pi-ai', version));
  if (exists(adapterEntry)) {
    const source = fs.readFileSync(adapterEntry, 'utf8');
    const exported = PI_AI_EXPORTS.filter((n) => !new RegExp(`export\\s*\\{[^}]*\\b${n}\\b`).test(source));
    const body = classBody(source, 'PiAiAdapter') ?? '';
    // The three image-budget fields and the two map fields our profile carries.
    const fields = ['maxRequestImageBytes', 'requestImagePixelBudget', 'requestImageMaxBytes', 'configuredMaxTokens', 'modelErrors'];
    const absent = fields.filter((f) => !new RegExp(`profile\\.${f}\\b`).test(body));
    if (exported.length === 0 && absent.length === 0) {
      row.adapter = 'ok';
    } else {
      row.adapter = exported.length ? `no export ${exported.join(',')}` : `unread ${absent.join(',')}`;
      row.notes.push(`adapter: ${row.adapter}`);
    }
  }

  rows.push(row);
}

console.log('registrations attempted:', registrations.map((r) => r.name).join(', '));
console.log(`newest target ${NEWEST} → floor ${FLOOR}`);
console.log('');
console.log('version'.padEnd(16), 'slots'.padEnd(7), 'settings'.padEnd(10), 'llm'.padEnd(7), 'adapter');
console.log('-'.repeat(58));
for (const row of rows) {
  console.log(row.version.padEnd(16), row.slots.padEnd(7), row.settings.padEnd(10), row.llm.padEnd(7), row.adapter);
  for (const note of row.notes) console.log('  !', note);
}

const full = registrations.length;
const bad = rows.filter(
  (r) => r.slots !== `${full}/${full}` || r.settings !== 'ok' || r.llm !== 'ok' || r.adapter !== 'ok',
);

// Negative control: prove the slots column can fail. The 0.1.0 code addressed
// the keyed slots with `id`; if that registers cleanly the column is measuring
// nothing and every "4/4" above is worthless.
const { SlotCore } = await import(new URL('lib/index.js', dir('dsh-client-ui-slots', VERSIONS[0])));
const control = new SlotCore();
control.record('plugins.row.config').spec = { kind: 'keyed', scope: 'root' };
let controlCaught = false;
try {
  control.register({ name: 'plugins.row.config', id: 'x#y', priority: 0 }, () => null);
} catch {
  controlCaught = true;
}

console.log('');
if (!controlCaught) {
  console.log('HARNESS BROKEN — a keyed slot accepted `id`, so the slots column proves nothing.');
  process.exitCode = 1;
} else if (bad.length === 0) {
  console.log(`OK — ${full} slots accepted, settings/llm/adapter contracts hold from ${NEWEST} back to ${FLOOR}.`);
  console.log('(negative control: keyed slot addressed by `id` is still rejected, so the column can fail)');
} else {
  console.log(`${bad.length} of ${rows.length} versions disagree.`);
  process.exitCode = 1;
}
