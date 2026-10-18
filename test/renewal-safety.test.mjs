import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { __diagnostics as d } from '../lib/index.js';
import { withAuthLock, writeJsonAtomic, AUTH_REQUEST_TIMEOUT_MS, AUTH_LOCK_STALE_MS } from '../lib/auth-io.js';

const run = promisify(execFile);
function fixture() {
  const directory = fs.mkdtempSync(join(tmpdir(), 'minimax-renewal-safety-'));
  const authFile = join(directory, 'auth.json');
  const stateFile = join(directory, 'auth-state.json');
  fs.writeFileSync(authFile, JSON.stringify({ records: { fixture: {
    accessToken: 'fixture-expired', refreshToken: 'fixture-refresh', expiresAtMs: 1, generation: 1,
  } } }), { mode: 0o600 });
  fs.writeFileSync(stateFile, JSON.stringify({ status: 'authenticated', generation: 1 }), { mode: 0o600 });
  return { directory, authFile, stateFile, cleanup: () => fs.rmSync(directory, { recursive: true, force: true }) };
}
const grant = () => new Response(JSON.stringify({ access_token: 'fixture-renewed', refresh_token: 'fixture-rotated', expires_in: 3600 }));

test('renewal preserves private credential permissions and matching generations', async () => {
  const f = fixture();
  const fetch = globalThis.fetch;
  const umask = process.umask(0o022);
  globalThis.fetch = async () => grant();
  try {
    assert.equal((await d.renewCredential(f.authFile)).ok, true);
    const auth = JSON.parse(fs.readFileSync(f.authFile)).records.fixture;
    const state = JSON.parse(fs.readFileSync(f.stateFile));
    assert.equal(auth.generation, 2);
    assert.equal(state.generation, auth.generation);
    if (process.platform !== 'win32') {
      for (const file of [f.authFile, f.stateFile]) assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    }
    assert.deepEqual(fs.readdirSync(f.directory).sort(), ['auth-state.json', 'auth.json']);
  } finally { globalThis.fetch = fetch; process.umask(umask); f.cleanup(); }
});

test('an unsuccessful atomic replacement cleans up its private temp file', () => {
  const f = fixture();
  const target = join(f.directory, 'existing-directory');
  fs.mkdirSync(target);
  try {
    assert.throws(() => writeJsonAtomic(target, { fixture: true }));
    assert.equal(fs.statSync(target).isDirectory(), true);
    assert.equal(fs.readdirSync(f.directory).some(name => name.endsWith('.tmp')), false);
    assert.equal(JSON.parse(fs.readFileSync(f.authFile)).records.fixture.accessToken, 'fixture-expired');
  } finally { f.cleanup(); }
});

test('concurrent renewals exchange a refresh token only once and adopt the rotated record', async () => {
  const f = fixture();
  const fetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => { requests++; await delay(80); return grant(); };
  try {
    const results = await Promise.all([d.renewCredential(f.authFile), d.renewCredential(f.authFile)]);
    assert.equal(requests, 1);
    assert.ok(results.every(result => result.ok));
    assert.equal(results.filter(result => result.adopted).length, 1);
  } finally { globalThis.fetch = fetch; f.cleanup(); }
});

test('the heartbeat prevents a separate MiniMax-style process from stealing a slow holder', { timeout: 10_000 }, async () => {
  const f = fixture();
  const lock = join(f.directory, 'auth.lock');
  let unlock, ready;
  const gate = new Promise(resolve => { unlock = resolve; });
  const started = new Promise(resolve => { ready = resolve; });
  const holder = withAuthLock(lock, async () => { ready(); await gate; }, { staleMs: 3000, updateMs: 1000 });
  try {
    await started;
    const before = fs.statSync(`${lock}.lock`).mtimeMs;
    await delay(3300);
    assert.ok(fs.statSync(`${lock}.lock`).mtimeMs > before, 'live holder must renew the lease');
    const code = `import lockfile from ${JSON.stringify(import.meta.resolve('proper-lockfile'))};
      try { const release=await lockfile.lock(${JSON.stringify(lock)}, {realpath:false, stale:3000, retries:0});
        await release(); console.log('stolen'); }
      catch(error) { if(error.code!=='ELOCKED') throw error; console.log('blocked'); }`;
    const child = await run(process.execPath, ['--input-type=module', '-e', code]);
    assert.equal(child.stdout.trim(), 'blocked');
  } finally { unlock(); await holder; f.cleanup(); }
});

test('an abandoned MiniMax-style lock is reclaimed', async () => {
  const f = fixture();
  const lock = join(f.directory, 'auth.lock');
  fs.mkdirSync(`${lock}.lock`);
  const abandoned = new Date(Date.now() - AUTH_LOCK_STALE_MS - 1000);
  fs.utimesSync(`${lock}.lock`, abandoned, abandoned);
  try {
    assert.equal(await withAuthLock(lock, async ({ assertOwned }) => { assertOwned(); return 'acquired'; }), 'acquired');
    assert.equal(fs.existsSync(`${lock}.lock`), false);
  } finally { f.cleanup(); }
});

test('a replaced lock cannot overwrite credentials or be removed by the former holder', async () => {
  const f = fixture();
  const fetch = globalThis.fetch;
  const lock = join(f.directory, 'auth.lock.lock');
  let releaseGrant, ready;
  const started = new Promise(resolve => { ready = resolve; });
  globalThis.fetch = async () => { ready(); return new Promise(resolve => { releaseGrant = resolve; }); };
  try {
    const renewal = d.renewCredential(f.authFile);
    await started;
    fs.renameSync(lock, `${lock}.former`);
    fs.mkdirSync(lock);
    releaseGrant(grant());
    const result = await renewal;
    assert.equal(result.ok, false);
    assert.match(result.reason, /ownership lost/);
    assert.equal(JSON.parse(fs.readFileSync(f.authFile)).records.fixture.accessToken, 'fixture-expired');
    assert.equal(fs.existsSync(lock), true, 'replacement lock belongs to another process');
  } finally { globalThis.fetch = fetch; f.cleanup(); }
});

test('a compromised heartbeat aborts the pending operation without removing the new owner', { timeout: 5000 }, async () => {
  const f = fixture();
  const lock = join(f.directory, 'auth.lock');
  let ready;
  const started = new Promise(resolve => { ready = resolve; });
  const holding = withAuthLock(lock, ({ signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    ready();
  }), { updateMs: 1000 });
  // Attach a rejection handler before intentionally compromising the lease.
  const rejected = assert.rejects(holding, { code: 'ECOMPROMISED' });
  try {
    await started;
    fs.renameSync(`${lock}.lock`, `${lock}.former`);
    fs.mkdirSync(`${lock}.lock`);
    const differentMtime = new Date(Date.now() - 5000);
    fs.utimesSync(`${lock}.lock`, differentMtime, differentMtime);
    await rejected;
    assert.equal(fs.existsSync(`${lock}.lock`), true);
  } finally { f.cleanup(); }
});

test('a replacement with the same timestamp cannot receive the former owners heartbeat', { timeout: 5000 }, async () => {
  const f = fixture(); const lock = join(f.directory, 'auth.lock');
  let ready; const started = new Promise(resolve => { ready = resolve; });
  const holding = withAuthLock(lock, ({ signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true }); ready();
  }), { updateMs: 1000 });
  const rejected = assert.rejects(holding, { code: 'ECOMPROMISED' });
  try {
    await started;
    const old = fs.statSync(`${lock}.lock`).mtime;
    fs.renameSync(`${lock}.lock`, `${lock}.former`); fs.mkdirSync(`${lock}.lock`);
    fs.utimesSync(`${lock}.lock`, old, old);
    const before = fs.statSync(`${lock}.lock`).mtimeMs;
    await rejected;
    assert.equal(fs.statSync(`${lock}.lock`).mtimeMs, before);
  } finally { f.cleanup(); }
});

for (const phase of ['headers', 'body']) {
  test(`renewal deadline aborts a stalled ${phase} and releases its lock`, async () => {
    const f = fixture();
    const fetch = globalThis.fetch;
    let signal;
    const stalled = () => new Promise((resolve, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    globalThis.fetch = async (url, init) => {
      signal = init.signal;
      return phase === 'headers' ? stalled() : { text: stalled };
    };
    try {
      assert.ok(AUTH_REQUEST_TIMEOUT_MS < AUTH_LOCK_STALE_MS);
      const result = await d.renewCredential(f.authFile, { timeoutMs: 50 });
      assert.equal(result.ok, false);
      assert.equal(signal.aborted, true);
      assert.match(result.reason, /timed out/);
      assert.equal(fs.existsSync(join(f.directory, 'auth.lock.lock')), false);
      assert.equal(JSON.parse(fs.readFileSync(f.authFile)).records.fixture.accessToken, 'fixture-expired');
      assert.equal(JSON.parse(fs.readFileSync(f.stateFile)).generation, 1);
    } finally { globalThis.fetch = fetch; f.cleanup(); }
  });
}

test('different credential files renew independently while same-file callers share a grant', { timeout: 5000 }, async () => {
  const a = fixture(), b = fixture();
  const fetch = globalThis.fetch;
  let release, ready;
  const started = new Promise(resolve => { ready = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const record = JSON.parse(fs.readFileSync(b.authFile));
  record.records.fixture.refreshToken = 'fixture-refresh-b';
  fs.writeFileSync(b.authFile, JSON.stringify(record));
  const requests = [];
  globalThis.fetch = async (url, init) => {
    const token = init.body.get('refresh_token'); requests.push(token);
    if (token === 'fixture-refresh') { ready(); await gate; }
    return new Response(JSON.stringify({ access_token: `renewed-${token}`, refresh_token: `next-${token}`, expires_in: 3600 }));
  };
  try {
    const first = d.freshCredential(a.authFile); await started;
    const same = d.freshCredential(a.authFile);
    const other = await d.freshCredential(b.authFile);
    assert.equal(other.token, 'renewed-fixture-refresh-b');
    assert.ok(other.expiresAtMs > Date.now());
    release();
    const results = await Promise.all([first, same]);
    assert.ok(results.every(result => result.token === 'renewed-fixture-refresh'));
    assert.deepEqual(requests.sort(), ['fixture-refresh', 'fixture-refresh-b']);
  } finally { release(); globalThis.fetch = fetch; a.cleanup(); b.cleanup(); }
});

test('partial state write reports failure, retains the rotated token and repairs without another grant', async () => {
  const f = fixture();
  const fetch = globalThis.fetch, rename = fs.renameSync;
  let grants = 0;
  globalThis.fetch = async () => { grants++; return grant(); };
  fs.renameSync = (from, to) => {
    if (to === f.stateFile) throw Object.assign(new Error('fixture companion failure'), { code: 'EIO' });
    return rename(from, to);
  };
  try {
    const result = await d.renewCredential(f.authFile);
    assert.equal(result.ok, false);
    assert.equal(result.repairPending, true);
    assert.equal(JSON.parse(fs.readFileSync(f.authFile)).records.fixture.accessToken, 'fixture-renewed');
    assert.equal(JSON.parse(fs.readFileSync(f.stateFile)).generation, 1);
    assert.equal(d.readCredential(f.authFile).needsStateRepair, true);
    fs.renameSync = rename;
    const recovered = await d.freshCredential(f.authFile);
    assert.equal(recovered.ok, true);
    assert.equal(recovered.needsStateRepair, false);
    assert.equal(JSON.parse(fs.readFileSync(f.stateFile)).generation, 2);
    assert.equal(grants, 1, 'a repair must not spend the new refresh token');
    assert.equal(fs.readdirSync(f.directory).some(name => name.endsWith('.tmp')), false);
  } finally { fs.renameSync = rename; globalThis.fetch = fetch; f.cleanup(); }
});

test('a valid credential without a refresh token can repair its older authenticated companion', async () => {
  const f = fixture(); const fetch = globalThis.fetch;
  const data = JSON.parse(fs.readFileSync(f.authFile));
  data.records.fixture = { accessToken: 'fixture-valid', expiresAtMs: Date.now() + 3_600_000, generation: 2 };
  fs.writeFileSync(f.authFile, JSON.stringify(data));
  globalThis.fetch = async () => { throw new Error('must not request an OAuth grant'); };
  try {
    const result = await d.freshCredential(f.authFile);
    assert.equal(result.ok, true); assert.equal(result.needsStateRepair, false);
    assert.equal(JSON.parse(fs.readFileSync(f.stateFile)).generation, 2);
  } finally { globalThis.fetch = fetch; f.cleanup(); }
});

for (const scenario of ['signed-out', 'newer-state', 'invalid-json']) {
  test(`the plugin does not revive credentials with ${scenario}`, async () => {
    const f = fixture(); const fetch = globalThis.fetch; let requests = 0;
    if (scenario === 'invalid-json') fs.writeFileSync(f.stateFile, '{');
    else fs.writeFileSync(f.stateFile, JSON.stringify({ status: scenario === 'signed-out' ? 'signed_out' : 'authenticated', generation: 2 }));
    globalThis.fetch = async () => { requests++; return grant(); };
    try {
      assert.equal((await d.freshCredential(f.authFile)).ok, false);
      assert.equal((await d.renewCredential(f.authFile)).ok, false);
      assert.equal(requests, 0);
      assert.equal(JSON.parse(fs.readFileSync(f.authFile)).records.fixture.accessToken, 'fixture-expired');
    } finally { globalThis.fetch = fetch; f.cleanup(); }
  });
}

test('OAuth errors cannot echo credentials or raw server bodies into diagnostics', async () => {
  const f = fixture(); const fetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'fixture-private-value' }), { status: 400 });
  try {
    const result = await d.renewCredential(f.authFile);
    assert.equal(result.fatal, true);
    assert.match(result.reason, /invalid_grant/);
    assert.equal(result.reason.includes('fixture-private-value'), false);
  } finally { globalThis.fetch = fetch; f.cleanup(); }
});

test('symbolic credential aliases share the real namespace lock and preserve the alias', { skip: process.platform === 'win32' }, async () => {
  const f = fixture(); const fetch = globalThis.fetch;
  const aliasDirectory = join(f.directory, 'alias'); fs.mkdirSync(aliasDirectory);
  const alias = join(aliasDirectory, 'auth.json'); fs.symlinkSync(f.authFile, alias);
  let grants = 0;
  globalThis.fetch = async () => { grants++; await delay(30); return grant(); };
  try {
    const results = await Promise.all([d.freshCredential(alias), d.freshCredential(f.authFile)]);
    assert.ok(results.every(result => result.token === 'fixture-renewed'));
    assert.equal(grants, 1);
    assert.equal(fs.lstatSync(alias).isSymbolicLink(), true);
    assert.equal(JSON.parse(fs.readFileSync(f.stateFile)).generation, 2);
    assert.equal(fs.existsSync(join(aliasDirectory, 'auth-state.json')), false);
  } finally { globalThis.fetch = fetch; f.cleanup(); }
});

test('malformed credential JSON does not expose its contents in the status reason', () => {
  const f = fixture();
  try {
    fs.writeFileSync(f.authFile, 'fixture-private-credential-content');
    const result = d.readCredential(f.authFile);
    assert.equal(result.ok, false);
    assert.equal(result.reason.includes('fixture-private'), false);
  } finally { f.cleanup(); }
});
