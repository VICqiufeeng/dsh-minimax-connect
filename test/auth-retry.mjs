/**
 * The 401 self-healing path, in isolation.
 *
 * Measured failure this covers (2026-10-20): the Mavis gateway invalidates the
 * previous access token the moment a refresh rotates it, so a turn that opened
 * just before the rotation was refused with `401 {"error":"invalid access
 * token"}` — while the plugin's own renewal had just written a perfectly good
 * credential to disk.
 *
 * The fix has two halves, and this test pins the observable one:
 *   - the renewal happens in the awaited pre-flight, before the request reads
 *     its headers, so the turn opens on the token that is live *after* the
 *     rotation;
 *   - a turn that was already streaming when a rotation lands is renewed and
 *     sent again (`withAuthRetry`).
 *
 *   node test/auth-retry.mjs
 */
import assert from 'node:assert/strict';
import { cp, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = '/Applications/DSH Desktop Beta.app/Contents/Resources/app/node_modules';
const REPO = new URL('..', import.meta.url).pathname;

const SCRATCH = join(tmpdir(), 'dsh-minimax-connect-auth');
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

const { __diagnostics } = await import(`file://${join(SCRATCH, 'lib', 'index.js')}`);
const { isAuthFailure, withAuthRetry } = __diagnostics;

// ---- detection ------------------------------------------------------------
assert.equal(isAuthFailure({ kind: 'error', failure: { message: '401 {"error":"invalid access token"}', code: 'AUTH' } }), true);
assert.equal(isAuthFailure({ kind: 'error', failure: { message: '401 unauthorized', code: 'PI_AI_ERROR' } }), true);
assert.equal(isAuthFailure({ kind: 'error', failure: { message: '500 upstream exploded', code: 'SERVER' } }), false);
assert.equal(isAuthFailure({ kind: 'stop' }), false);
assert.equal(isAuthFailure(undefined), false);

// ---- replay ---------------------------------------------------------------
const authFinish = {
  type: 'finish',
  reason: { kind: 'error', failure: { message: '401 {"error":"invalid access token"}', code: 'AUTH' } },
};

let attempts = 0;
let renewals = 0;
const chunks = [];
for await (const chunk of withAuthRetry(
  async function* makeStream() {
    attempts += 1;
    if (attempts === 1) {
      yield { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } };
      yield authFinish;
      return;
    }
    yield { type: 'text-delta', text: 'ok' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  },
  async () => { renewals += 1; return true; },
)) {
  chunks.push(chunk);
}

assert.equal(attempts, 2, 'the turn must be sent again after the 401');
assert.equal(renewals, 1, 'the credential must be renewed once');
assert.equal(chunks.length, 2, 'only the replayed attempt is reported');
assert.equal(chunks[0].type, 'text-delta');
assert.equal(chunks[1].reason.kind, 'stop');

// ---- a second refusal is reported, not retried forever -------------------
let attempts2 = 0;
let renewals2 = 0;
const chunks2 = [];
for await (const chunk of withAuthRetry(
  async function* makeStream() {
    attempts2 += 1;
    yield authFinish;
  },
  async () => { renewals2 += 1; return true; },
)) {
  chunks2.push(chunk);
}
assert.equal(attempts2, 2, 'the replay is bounded to one attempt');
assert.equal(renewals2, 1);
assert.equal(chunks2.length, 1);
assert.equal(chunks2[0].reason.kind, 'error');
assert.equal(chunks2[0].reason.failure.code, 'AUTH');

// ---- a renewal that cannot fix it reports the original failure -----------
let attempts3 = 0;
const chunks3 = [];
for await (const chunk of withAuthRetry(
  async function* makeStream() {
    attempts3 += 1;
    yield authFinish;
  },
  async () => false,
)) {
  chunks3.push(chunk);
}
assert.equal(attempts3, 1, 'a failed renewal must not replay the turn');
assert.equal(chunks3[0].reason.failure.code, 'AUTH');

await rm(SCRATCH, { recursive: true, force: true });
console.log('auth-retry: OK', { attempts, renewals });
