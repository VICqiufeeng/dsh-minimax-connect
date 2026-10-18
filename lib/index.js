/**
 * DSH Connect MiniMax — host half.
 *
 * Turns the MiniMax Code (Mavis) desktop subscription already signed in on this
 * machine into a DSH model provider. The account is points-based, so this half
 * also exposes the points balance, the 7-day check-in panel, and a claim action.
 *
 * Verified against the live service (all measured, not guessed):
 *   POST https://agent.minimax.cn/mavis/api/v1/llm/v1/messages   -> Anthropic
 *        Messages protocol; 200 with content[]/usage{input_tokens,...}.
 *        `GET .../models` answers 503 `direct_route_not_configured`, so the
 *        model roster is read from the local config.yaml instead.
 *   GET  https://agent.minimax.cn/minimax-cloud/api/v1/credit/details
 *        -> {details:[{granted_amount,remaining_amount,consumed_amount,...}]}
 *   GET  .../signin/status?timezone_id=Asia/Shanghai   (the param is REQUIRED;
 *        without it the API answers 1406010011 "invalid timezone_id")
 *   POST .../signin/claim  body {}  -> the claim; sending an empty body is what
 *        the first-party client does (read out of its app.asar).
 *
 * @module dsh-minimax-connect
 */

import fs from 'node:fs';
import path from 'node:path';
import z from '@deepseek-ai/schemastery';
import { hostOptions, profileDefaults } from './host-compat.js';
import { writeJsonAtomic, withAuthLock, fetchTextWithDeadline } from './auth-io.js';

/**
 * Peers are ESM-only and use import-only `exports` maps, so `require()` and
 * `require.resolve()` both fail on them (ERR_REQUIRE_ESM /
 * ERR_PACKAGE_PATH_NOT_EXPORTED). They are therefore loaded with a bare
 * `import()`, which resolves against this file's own location — the plugin
 * directory — and that is the same chain the host uses.
 *
 * A host missing one of them degrades to "provider not registered" with a
 * reason instead of failing at module load.
 */
const PEERS = {
  piAi: ['@earendil-works/pi-ai', 'createProvider'],
  anthropic: ['@earendil-works/pi-ai/api/anthropic-messages.lazy', 'anthropicMessagesApi'],
  adapter: ['@deepseek-ai/dsh-llm-pi-ai', 'PiAiAdapter'],
};

let peersPromise;
function loadPeers() {
  if (peersPromise === undefined) {
    peersPromise = (async () => {
      const out = { errors: [] };
      for (const [key, [spec, exportName]] of Object.entries(PEERS)) {
        try {
          const mod = await import(spec);
          out[key] = mod?.[exportName];
          if (out[key] === undefined) out.errors.push(`${spec} has no export ${exportName}`);
        } catch (error) {
          out[key] = undefined;
          out.errors.push(`${spec}: ${error.code ?? String(error.message).split('\n')[0]}`);
        }
      }
      return out;
    })();
  }
  return peersPromise;
}

export const name = 'minimax-connect';

/**
 * The model registry must exist before a provider can register, so `llm` is a
 * hard dependency: without it `ctx.llm` is undefined and the provider never
 * reaches the model picker.
 */
export const inject = ['llm'];

/**
 * The Anthropic SDK posts to `<baseUrl>/v1/messages`, so the base is the Mavis
 * root WITHOUT the trailing `/v1` — measured: `/mavis/api/v1/llm` yields that
 * exact path and returns 200, while `/mavis/api/v1/llm/v1` answers 503
 * `direct_route_not_configured`. The read-only cloud routes below DO carry
 * `/v1`, so the two bases are deliberately different.
 */
const DEFAULT_BASE = 'https://agent.minimax.cn/mavis/api/v1/llm';
const CLOUD_BASE = 'https://agent.minimax.cn/minimax-cloud/api/v1';
const PROVIDER_ID = 'minimax';

/**
 * Mark a schema node volatile.
 *
 * The host gates every settings write on `schema.meta.volatile` — an
 * undeclared field is refused with `Config field "X" is not volatile`, and the
 * card's switches die with that error.
 *
 * `Schema.prototype.volatile()` exists from schemastery 3.18.4 (the copy the
 * Desktop runtime ships at `resources/app/dsh/node_modules`), but the copy a
 * profile plugin reaches through the shared-layer junction is 3.18.1, which has
 * no such method. Calling it unguarded therefore throws at module load with
 * `volatile is not a function`. This sets the flag the host actually reads, so
 * the plugin works against either copy.
 */
function makeVolatile(schema) {
  if (typeof schema?.volatile === 'function') return schema.volatile();
  schema.meta.volatile = true;
  return schema;
}

/**
 * The user-configurable half of the settings document.
 *
 * Semantics are opt-OUT for the allow-lists, matching the sibling plugins: a
 * missing key means "offered", and only an explicit `false` disables. That way
 * a newly published MiniMax model appears without a settings migration.
 */
const ENABLED_MODEL_IDS_FIELD = makeVolatile(
  z.dict(z.boolean()).default({})
    .description('Per-model switch; a missing key is offered, only an explicit false disables'),
);
const IMAGE_OVERRIDES_FIELD = makeVolatile(
  z.dict(z.union([z.const('auto'), z.const('on'), z.const('off')])).default({})
    .description('Per-model image-input mode; auto follows the model catalog'),
);
const USE_MAXIMUM_CONTEXT_WINDOW_FIELD = makeVolatile(
  z.boolean().default(false)
    .description('Advertise the widest offered context window instead of the default'),
);

export const Config = z.object({
  baseUrl: z.string().default(DEFAULT_BASE),
  cloudBaseUrl: z.string().default(CLOUD_BASE),
  /** Tokens are read from this file; it is the MiniMax Code credential store. */
  authFile: z.string(),
  /** Model roster source: the desktop client's own provider config. */
  configFile: z.string(),
  debugPort: z.number().default(9333),
  statusRoute: z.string().default('/plugins/dsh-minimax-connect/status'),
  usageRoute: z.string().default('/plugins/dsh-minimax-connect/usage'),
  checkinRoute: z.string().default('/plugins/dsh-minimax-connect/checkin'),
  signinStatusRoute: z.string().default('/plugins/dsh-minimax-connect/signin'),
  claimRoute: z.string().default('/plugins/dsh-minimax-connect/signin/claim'),
  panelRoute: z.string().default('/plugins/dsh-minimax-connect/panel'),
  modelsRoute: z.string().default('/plugins/dsh-minimax-connect/models'),
  saveRoute: z.string().default('/plugins/dsh-minimax-connect/__save'),
  cacheMs: z.number().default(15_000),
  enabledModelIds: ENABLED_MODEL_IDS_FIELD,
  imageOverrides: IMAGE_OVERRIDES_FIELD,
  useMaximumContextWindow: USE_MAXIMUM_CONTEXT_WINDOW_FIELD,
});

/**
 * The fields a save may write, and the merge rule each uses.
 * `whole` replaces the field outright (the card always posts its complete value).
 */
const SAVE_FIELDS = {
  enabledModelIds: 'whole',
  imageOverrides: 'whole',
  useMaximumContextWindow: 'whole',
};

/** Namespace fallback when the host exposes no Loader entry id. */
const FALLBACK_NS = 'dsh-minimax-connect';

/**
 * The namespace the host actually serves this plugin under.
 *
 * On the 0.2 line the settings service derives it from the Loader entry
 * (`ns: entry.options.id`, our row id `llm-minimax`); a host that mounts the
 * plugin without a Loader entry serves the plugin namespace instead.
 */
function settingsNamespaceOf(ctx, fallback) {
  const id = ctx?.fiber?.entry?.options?.id;
  return typeof id === 'string' && id !== '' ? id : fallback;
}

/** Unwrap a volatile reference (`{ get() }`) into its value. */
function unwrapVolatile(value) {
  if (value === null || typeof value !== 'object') return value;
  if (typeof value.get === 'function') {
    try { return value.get(); } catch { return undefined; }
  }
  return value;
}

/** The settings row this plugin owns, matched exactly (never by substring). */
function findSettingsRow(rows, candidates) {
  for (const ns of candidates) {
    const row = rows.find((entry) => String(entry.ns) === ns);
    if (row !== undefined) return row;
  }
  return undefined;
}

// ---------------------------------------------------------------- credentials

/**
 * Where MiniMax Code keeps its OAuth records. The file lives under
 * `auth/prod/<region>/mcode-public/auth.json`; the token is scoped
 * `agent-backend` and is a plain Bearer value.
 */
function defaultAuthFile() {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
  return path.join(home, '.minimax', 'auth', 'prod', 'cn', 'mcode-public', 'auth.json');
}

function defaultConfigFile() {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
  return path.join(home, '.minimax', 'config.yaml');
}

function credentialPath(authFile) {
  const file = path.resolve(authFile || defaultAuthFile());
  try { return fs.realpathSync(file); }
  catch { return file; }
}

/**
 * Read the stored token. Returns `{ ok, token, expiresAtMs, reason }` and never
 * throws: a machine without MiniMax Code signed in must degrade to "not signed
 * in", not crash the loader.
 */
function readCredential(authFile) {
  const file = credentialPath(authFile);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    return { ok: false, reason: `unreadable: ${error.code ?? error.message}`, token: undefined };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'credential file is not JSON', token: undefined };
  }
  const records = parsed?.records ?? {};
  const first = Object.values(records)[0];
  const token = first?.accessToken;
  if (typeof token !== 'string' || token.length === 0) {
    return { ok: false, reason: 'no accessToken record', token: undefined };
  }
  let state;
  try { state = credentialState(file, first); }
  catch (error) { return { ok: false, reason: `credential state unavailable: ${error.message}`, token: undefined }; }
  if (state.reason) return { ok: false, reason: state.reason, token: undefined };
  return {
    ok: true,
    token,
    tokenType: typeof first.tokenType === 'string' ? first.tokenType : 'Bearer',
    expiresAtMs: typeof first.expiresAtMs === 'number' ? first.expiresAtMs : undefined,
    refreshToken: typeof first.refreshToken === 'string' ? first.refreshToken : undefined,
    needsStateRepair: state.needsRepair,
    reason: undefined,
  };
}

// --------------------------------------------------------- credential renewal

/**
 * The OAuth record is renewed here, not only by the desktop client.
 *
 * MiniMax Code renews it roughly hourly and writes the result back to the same
 * file, and nothing else ever did — so the plugin went stale the moment the
 * desktop app was closed. Measured: HTTP 401 `invalid access token` on the
 * first request after expiry, with a perfectly good refreshToken sitting
 * unread in the record. The grant is therefore performed by this plugin as
 * well, against the same endpoint the first-party client uses:
 *
 *   POST https://account.minimax.cn/oauth2/token
 *        grant_type=refresh_token & refresh_token & client_id & scope & audience
 *        -> {access_token, refresh_token, token_type, expires_in, scope}
 *
 * `refresh_token` is single-use and rotates on every grant, so the old value
 * dies the instant the call answers and the new pair has to be stored before
 * the new access token is used. The write is an atomic replace (temp file then
 * rename) so the desktop client never observes a half-written record.
 *
 * The client serialises its own renewal with a file lock. The same race is
 * handled here by re-reading the file immediately before the write and
 * adopting any newer generation rather than clobbering it — same outcome, with
 * no lock to leak if this process dies mid-renewal.
 */
const OAUTH_TOKEN_ENDPOINT = 'https://account.minimax.cn/oauth2/token';
const OAUTH_CLIENT_ID = 'mcode-public';
const OAUTH_SCOPE = 'agent.default';
const OAUTH_AUDIENCE = 'agent-backend';

/** Renew this long before expiry, so a stream never opens on a dying token. */
const RENEW_MARGIN_MS = 5 * 60_000;
/** After a refused grant, wait this long before touching the endpoint again. */
const RENEW_BACKOFF_MS = 5 * 60_000;

/** Contention is not the endpoint's fault, so it parks for far less time. */
const RENEW_LOCK_RETRY_MS = 30_000;
/** Only callers using the same credential file may share a renewal/backoff. */
const renewalStates = new Map();
function renewalState(authFile) {
  const key = credentialPath(authFile);
  if (!renewalStates.has(key)) renewalStates.set(key, {
    blockedUntil: 0, blockedToken: undefined, inFlight: null, log: () => {},
  });
  return renewalStates.get(key);
}

function parkRenewal(state, ms, token) {
  state.blockedUntil = Date.now() + ms;
  state.blockedToken = token;
}

function unparkRenewal(state) {
  state.blockedUntil = 0;
  state.blockedToken = undefined;
}

/**
 * True while a previous failure still parks renewals — and false, with the park
 * lifted, as soon as the credential on disk is no longer the one that failed.
 */
function renewalParked(credential, state) {
  if (state.blockedUntil === 0) return false;
  if (Date.now() >= state.blockedUntil) { unparkRenewal(state); return false; }
  if (credential?.refreshToken !== state.blockedToken) { unparkRenewal(state); return false; }
  return true;
}

/**
 * The whole stored record rather than just the token, because a renewal has to
 * rewrite it. `undefined` for anything unreadable or unparsable, which the
 * callers treat exactly as {@link readCredential} treats a missing login.
 */
function readCredentialRecord(authFile) {
  const file = credentialPath(authFile);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
  const records = parsed?.records ?? {};
  const key = Object.keys(records)[0];
  if (key === undefined) return undefined;
  return { file, parsed, key, record: records[key] };
}

/**
 * True when the credential has no usable expiry or expires within the margin.
 * A record without `expiresAtMs` is treated as long-lived: refusing to try it
 * would break every older auth file for no reason.
 */
function expiresWithin(credential, marginMs) {
  if (typeof credential?.expiresAtMs !== 'number') return false;
  return credential.expiresAtMs - Date.now() <= marginMs;
}

/** The client's namespace keeps `auth.lock` next to `auth.json`. */
function authLockPath(authFile) {
  return path.join(path.dirname(authFile || defaultAuthFile()), 'auth.lock');
}

/** A missing companion supports legacy credentials; other read errors matter. */
function readAuthState(authFile) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(path.dirname(authFile), 'auth-state.json'), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
  let state;
  try { state = JSON.parse(raw); }
  catch { throw new Error('invalid auth-state.json'); }
  if (!state || typeof state !== 'object' || Array.isArray(state)
    || !Number.isSafeInteger(state.generation) || state.generation < 0) throw new Error('invalid auth-state.json generation');
  return state;
}

function readAuthStateGeneration(authFile) {
  return readAuthState(authFile)?.generation ?? 0;
}

function credentialState(authFile, record) {
  const state = readAuthState(authFile);
  if (!state) return { needsRepair: false };
  const generation = Number.isSafeInteger(record.generation) ? record.generation : 0;
  // Never resurrect an explicit sign-out or replace a newer client's state.
  if (state.status !== 'authenticated') return { reason: 'MiniMax Code is signed out' };
  if (state.generation > generation) return { reason: 'credential superseded by newer MiniMax Code state' };
  return { needsRepair: state.generation !== generation || state.expiresAtMs !== record.expiresAtMs };
}

/**
 * Keep `auth-state.json` in step with the record just written.
 *
 * This is not advisory. `MCodeOAuthCore.readUsableCredential` refuses the pair
 * unless `credential.generation === state.generation`, so a token written into
 * `auth.json` without the matching companion bump reads back as "signed out"
 * and sends the user to a fresh sign-in. Both files therefore carry the same
 * generation, taken from {@link nextGeneration}.
 */
function mirrorAuthState(authFile, record) {
  const stateFile = path.join(path.dirname(authFile), 'auth-state.json');
  const state = readAuthState(authFile);
  if (!state) return;
  writeJsonAtomic(stateFile, { ...state, status: 'authenticated', generation: record.generation, expiresAtMs: record.expiresAtMs });
}

/**
 * The generation for a replacement credential.
 *
 * The client computes `max(state.generation, credential.generation) + 1` and
 * refuses any pair whose two files disagree, so a renewal that used only the
 * credential's own counter could land *below* the companion file and lock the
 * account out of its own fresh token.
 */
function nextGeneration(authFile, record) {
  const fromState = readAuthStateGeneration(authFile);
  const fromRecord = typeof record?.generation === 'number' && Number.isSafeInteger(record.generation) ? record.generation : 0;
  return Math.max(fromState, fromRecord) + 1;
}

/**
 * Exchange the stored refresh token for a new pair.
 *
 * Never throws: every failure comes back as `{ ok: false, reason, fatal? }` so
 * a caller can keep serving the token already on disk. `fatal` marks the one
 * permanent answer, `invalid_grant`, where the refresh token itself is gone and
 * only a fresh sign-in in MiniMax Code can bring the provider back.
 */
async function renewCredential(authFile, { timeoutMs } = {}) {
  const initial = readCredentialRecord(authFile);
  if (initial === undefined) return { ok: false, reason: 'no credential record on disk' };
  /**
   * Read, grant and write all happen inside the client's own lock, because the
   * refresh token is single-use: a grant whose result is not stored before the
   * next grant is a token the service reads as replayed, and a replay revokes
   * the entire token family (measured — it costs the user a fresh sign-in).
   * The record is re-read *inside* the lock as well: whoever held it before us
   * may already have rotated, in which case that newer pair is adopted rather
   * than spent.
   */
  try {
    return await withAuthLock(authLockPath(initial.file), async ({ signal, assertOwned }) => {
      const current = readCredentialRecord(initial.file);
      if (current === undefined) return { ok: false, reason: 'credential record vanished while waiting for the lock' };
      const previous = current.record ?? {};
      let state;
      try { state = credentialState(current.file, previous); }
      catch (error) { return { ok: false, reason: `credential state unavailable: ${error.message}` }; }
      if (state.reason) return { ok: false, reason: state.reason };
      if (typeof previous.expiresAtMs === 'number' && previous.expiresAtMs - Date.now() > RENEW_MARGIN_MS) {
        if (state.needsRepair) {
          try { assertOwned(); mirrorAuthState(current.file, previous); }
          catch (error) { return { ok: false, repairPending: true, reason: `credential saved; companion state repair failed: ${error.message}` }; }
        }
        return { ok: true, adopted: true, expiresAtMs: previous.expiresAtMs, generation: previous.generation };
      }
      if (typeof previous.refreshToken !== 'string' || previous.refreshToken.length === 0) {
        return { ok: false, reason: 'record carries no refreshToken', fatal: true };
      }
      let response, text;
      try {
        ({ response, text } = await fetchTextWithDeadline(OAUTH_TOKEN_ENDPOINT, {
          method: 'POST',
          headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: previous.refreshToken,
            client_id: OAUTH_CLIENT_ID,
            scope: OAUTH_SCOPE,
            audience: OAUTH_AUDIENCE,
          }),
        }, signal, timeoutMs));
      } catch (error) {
        return { ok: false, reason: `endpoint unreachable: ${error.cause?.code ?? error.message}` };
      }
      assertOwned();
      let grant;
      try { grant = JSON.parse(text); } catch { grant = undefined; }
      if (!response.ok || typeof grant?.access_token !== 'string' || grant.access_token.length === 0) {
        const fatal = grant?.error === 'invalid_grant';
        const code = typeof grant?.error === 'string' && /^[a-z_]+$/.test(grant.error) ? ` ${grant.error}` : '';
        return { ok: false, reason: `grant refused: HTTP ${response.status}${code}`, fatal };
      }
      const expiresIn = Number(grant.expires_in);
      const record = {
        ...previous,
        accessToken: grant.access_token,
        refreshToken: typeof grant.refresh_token === 'string' ? grant.refresh_token : previous.refreshToken,
        tokenType: 'Bearer',
        clientId: OAUTH_CLIENT_ID,
        scopes: [OAUTH_SCOPE],
        audience: OAUTH_AUDIENCE,
        expiresAtMs: Date.now() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600) * 1000,
        generation: nextGeneration(current.file, previous),
      };
      const payload = { ...current.parsed };
      payload.records = { ...(payload.records ?? {}), [current.key]: record };
      try {
        assertOwned();
        writeJsonAtomic(current.file, payload);
      } catch (error) {
        return { ok: false, reason: `renewed but could not be stored: ${error.message}` };
      }
      try { mirrorAuthState(current.file, record); }
      catch (error) {
        // The server has rotated the token: retain the new credential and
        // repair its companion under the lock, without another OAuth grant.
        return { ok: false, repairPending: true, reason: `credential saved; companion state repair failed: ${error.message}` };
      }
      return { ok: true, expiresAtMs: record.expiresAtMs, generation: record.generation };
    });
  } catch (error) {
    return { ok: false, reason: `could not take the credential lock: ${error.message}`, contended: true };
  }
}

/**
 * Renew once.
 *
 * Concurrent callers await the same exchange, and a refused grant parks the
 * next attempt behind {@link RENEW_BACKOFF_MS} instead of re-posting a dead
 * refresh token on every single request.
 */
function ensureRenewal(authFile) {
  const state = renewalState(authFile);
  if (state.inFlight !== null) return state.inFlight;
  const attempt = renewCredential(authFile).then(
    (result) => {
      state.inFlight = null;
      const token = readCredential(authFile)?.refreshToken;
      if (result.ok) unparkRenewal(state);
      else {
        parkRenewal(state, result.contended || result.repairPending ? RENEW_LOCK_RETRY_MS : RENEW_BACKOFF_MS, token);
        if (result.fatal) state.log(`credential renewal impossible — ${result.reason}; sign in again in MiniMax Code`);
        else state.log(`credential renewal failed — ${result.reason}`);
      }
      return result;
    },
    (error) => {
      state.inFlight = null;
      parkRenewal(state, RENEW_BACKOFF_MS, readCredential(authFile)?.refreshToken);
      return { ok: false, reason: String(error?.message ?? error) };
    },
  );
  state.inFlight = attempt;
  return attempt;
}

/**
 * A credential valid for at least {@link RENEW_MARGIN_MS}, renewing first when
 * the stored one is not.
 *
 * A failed renewal falls back to whatever is on disk: a stale token still beats
 * an unregistered provider while the endpoint is unreachable, and the next call
 * retries once the backoff expires.
 */
async function freshCredential(authFile) {
  const stored = readCredential(authFile);
  if (!stored.ok) return stored;
  if (!expiresWithin(stored, RENEW_MARGIN_MS) && !stored.needsStateRepair) return stored;
  if (renewalParked(stored, renewalState(authFile))) return stored;
  await ensureRenewal(authFile);
  return readCredential(authFile);
}

// ------------------------------------------------------------------- models

/**
 * Parse the model roster from the desktop client's config.yaml.
 *
 * A tiny hand-rolled reader instead of a YAML dependency: the file is machine
 * written and we only need `provider.minimax.models.<id>` plus that entry's
 * `name`, `limit.context` and `limit.output`. Anything unparsable falls back to
 * the four ids measured on this machine.
 */
const FALLBACK_MODELS = [
  { id: 'MiniMax-M3.1-Flash-Preview', name: 'M3.1 Flash Preview', context: 512_000, contextMax: 1_000_000, maxTokens: 128_000, reasoning: true, vision: true },
  { id: 'MiniMax-M3', name: 'M3', context: 512_000, contextMax: 1_000_000, maxTokens: 128_000, reasoning: true, vision: true },
  { id: 'MiniMax-M2.7-highspeed', name: 'M2.7 highspeed', context: 200_000, contextMax: 200_000, maxTokens: 128_000, reasoning: true, vision: false },
  { id: 'MiniMax-M2.7', name: 'M2.7', context: 200_000, contextMax: 200_000, maxTokens: 128_000, reasoning: true, vision: false },
];

function parseModels(configFile) {
  let text;
  try {
    text = fs.readFileSync(configFile || defaultConfigFile(), 'utf8');
  } catch {
    return { models: FALLBACK_MODELS, source: 'fallback (config.yaml unreadable)' };
  }
  // indent-sensitive scan: model keys sit at 6 spaces under `models:`
  const lines = text.split(/\r?\n/);
  const out = [];
  let inProvider = false;
  let inMiniMax = false;
  let inModels = false;
  let current = null;
  let inContextOptions = false;
  for (const line of lines) {
    if (/^provider:\s*$/.test(line)) { inProvider = true; inMiniMax = false; inModels = false; continue; }
    if (/^\S/.test(line)) { inProvider = false; inMiniMax = false; inModels = false; }
    if (!inProvider) continue;
    if (/^ {2}minimax:\s*$/.test(line)) { inMiniMax = true; inModels = false; continue; }
    if (/^ {2}\S/.test(line)) { inMiniMax = false; inModels = false; }
    if (!inMiniMax) continue;
    if (/^\s{4}models:\s*$/.test(line)) { inModels = true; continue; }
    if (!inModels) continue;
    if (/^\s{4}[a-zA-Z]/.test(line)) { inModels = false; continue; }
    const keyMatch = /^ {6}([A-Za-z0-9._-]+):\s*$/.exec(line);
    if (keyMatch) {
      current = { id: keyMatch[1], name: keyMatch[1], context: 200_000, maxTokens: 128_000, reasoning: true, vision: false };
      out.push(current);
      inContextOptions = false;
      continue;
    }
    if (current === null) continue;
    const nm = /^\s{8}name:\s*(.+?)\s*$/.exec(line);
    if (nm) { current.name = nm[1].replace(/^['"]|['"]$/g, ''); continue; }
    // `limit:` sits at indent 8 and its keys at 10 (measured), so the matchers
    // below are anchored on the KEY rather than a fixed depth.
    const cx = /^\s{8,12}context:\s*(\d+)\s*$/.exec(line);
    if (cx) { current.context = Number(cx[1]); continue; }
    const ot = /^\s{8,12}output:\s*(\d+)\s*$/.exec(line);
    if (ot) { current.maxTokens = Number(ot[1]); continue; }
    if (/^\s{12}- image\s*$/.test(line)) { current.vision = true; continue; }
    // `contextWindowOptions:` is the widest window the plan offers; the second
    // value is the "higher_usage" tier, which is what the max-context switch picks.
    if (/^\s{8,12}contextWindowOptions:\s*$/.test(line)) { inContextOptions = true; continue; }
    if (inContextOptions) {
      const opt = /^\s{10,14}-\s*(\d+)\s*$/.exec(line);
      if (opt) { current.contextMax = Math.max(current.contextMax ?? 0, Number(opt[1])); continue; }
      if (!/^\s*$/.test(line)) inContextOptions = false;
    }
  }
  if (out.length === 0) return { models: FALLBACK_MODELS, source: 'fallback (no models parsed)' };
  return { models: out.map(m => ({ ...m, contextMax: Math.max(m.context, m.contextMax ?? m.context) })), source: 'config.yaml' };
}

/**
 * One pi-ai model descriptor for the Anthropic Messages API, honouring the
 * user's switches.
 *
 * @param prefs - the resolved preferences; `enabledIds`, `imageModes`,
 *   `preferMaximumContext`. Judged per call so a settings save takes effect on
 *   the next model build without re-registering the provider.
 */
function toPiModel(m, baseUrl, prefs = {}) {
  const imageMode = prefs.imageModes?.[m.id] ?? 'auto';
  const wantsImage = imageMode === 'on' || (imageMode === 'auto' && m.vision === true);
  const width = prefs.preferMaximumContext === true && m.contextMax ? m.contextMax : m.context;
  return {
    id: m.id,
    name: m.name,
    api: 'anthropic-messages',
    provider: PROVIDER_ID,
    baseUrl,
    reasoning: m.reasoning !== false,
    input: wantsImage ? ['text', 'image'] : ['text'],
    // Points-based plan: no per-token price is published, so cost stays at 0
    // rather than inventing a number the panel would then display as truth.
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: width,
    maxTokens: m.maxTokens,
    /** Carried for the card only; pi-ai ignores unknown descriptor fields. */
    imageMode,
  };
}

/**
 * Keep the models the user left enabled.
 *
 * Opt-out: an id with no entry is offered, and only an explicit `false` removes
 * it. An empty allow-list therefore means "everything", not "nothing" — which
 * is what keeps a freshly published model visible.
 */
function filterByEnabled(models, enabledIds) {
  if (enabledIds === null || typeof enabledIds !== 'object') return models;
  return models.filter((m) => enabledIds[m.id] !== false);
}

// ---------------------------------------------------------------------- http

async function callJson(url, credential, init = {}) {
  const headers = {
    authorization: `${credential.tokenType ?? 'Bearer'} ${credential.token}`,
    'content-type': 'application/json',
    accept: 'application/json',
    ...(init.headers ?? {}),
  };
  const response = await fetch(url, { ...init, headers });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 400) }; }
  return { status: response.status, body };
}

const TZ = 'Asia/Shanghai';

// --------------------------------------------------------------------- panel

/**
 * Snapshot for the settings card: sign-in state, points, and the model roster.
 * Read-only; the claim is a separate POST route.
 */
async function collectSnapshot(resolved, roster) {
  const credential = await freshCredential(resolved.authFile);
  const renewal = renewalState(resolved.authFile);
  const out = {
    signedIn: credential.ok,
    reason: credential.reason,
    expiresAtMs: credential.expiresAtMs,
    // `selfRenewal` tells the card whether this plugin can keep the sign-in
    // alive on its own, i.e. whether MiniMax Code still has to be running.
    selfRenewal: {
      marginMs: RENEW_MARGIN_MS,
      backoffMs: RENEW_BACKOFF_MS,
      blocked: Date.now() < renewal.blockedUntil && renewal.blockedToken === credential.refreshToken,
      blockedUntil: renewal.blockedUntil || null,
      inFlight: renewal.inFlight !== null,
      stateRepairPending: credential.needsStateRepair === true,
      hasRefreshToken: typeof credential.refreshToken === 'string' && credential.refreshToken.length > 0,
    },
    baseUrl: resolved.baseUrl,
    models: roster.models,
    modelsSource: roster.source,
    points: null,
    signin: null,
    errors: [],
  };
  if (!credential.ok) return out;

  try {
    const r = await callJson(`${resolved.cloudBaseUrl}/credit/details`, credential);
    if (r.status === 200 && r.body?.base_resp?.status_code === 0) {
      const rows = Array.isArray(r.body.details) ? r.body.details : [];
      let remaining = 0;
      let granted = 0;
      let consumed = 0;
      let expireAtMs;
      for (const row of rows) {
        remaining += Number(row.remaining_amount ?? 0) || 0;
        granted += Number(row.granted_amount ?? 0) || 0;
        consumed += Number(row.consumed_amount ?? 0) || 0;
        if (typeof row.expire_at_ms === 'number' && (expireAtMs === undefined || row.expire_at_ms < expireAtMs)) {
          expireAtMs = row.expire_at_ms;
        }
      }
      out.points = { remaining, granted, consumed, expireAtMs, rows: rows.length };
    } else {
      out.errors.push(`credit/details -> HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
    }
  } catch (error) {
    out.errors.push(`credit/details -> ${error.cause?.code ?? error.message}`);
  }

  try {
    const r = await callJson(`${resolved.cloudBaseUrl}/signin/status?timezone_id=${encodeURIComponent(TZ)}`, credential);
    if (r.status === 200 && r.body?.base_resp?.status_code === 0) {
      const days = Array.isArray(r.body.data?.days) ? r.body.data.days : [];
      const today = days.find((d) => d.is_today === true);
      out.signin = {
        scene: r.body.data?.scene,
        days: days.map((d) => ({ day: d.day_no, points: d.points, bonus: d.bonus_points, status: d.status, today: d.is_today === true })),
        // status 3 = claimed (measured: day 1 came back with status 3 and is_today),
        // 1 = claimable.
        claimedToday: today?.status === 3,
        claimableToday: today?.status === 1,
        todayPoints: today?.points ?? 0,
      };
    } else {
      out.errors.push(`signin/status -> HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
    }
  } catch (error) {
    out.errors.push(`signin/status -> ${error.cause?.code ?? error.message}`);
  }

  return out;
}

/**
 * Claim the daily check-in.
 *
 * The empty body matches the first-party client, but the `timezone_id` query
 * parameter is required on this route too: the POST rejects with 1406010011
 * "invalid timezone_id" without it (measured).
 */
async function claimCheckin(resolved) {
  const credential = await freshCredential(resolved.authFile);
  if (!credential.ok) return { ok: false, error: `not signed in: ${credential.reason}` };
  const url = `${resolved.cloudBaseUrl}/signin/claim?timezone_id=${encodeURIComponent(TZ)}`;
  try {
    const r = await callJson(url, credential, { method: 'POST', body: '{}' });
    const code = r.body?.base_resp?.status_code;
    if (r.status === 200 && code === 0) return { ok: true, data: r.body.data ?? null };
    return { ok: false, error: r.body?.base_resp?.status_msg ?? `HTTP ${r.status}`, code };
  } catch (error) {
    return { ok: false, error: String(error.cause?.code ?? error.message) };
  }
}

// ------------------------------------------------------------------ adapter

/**
 * Build the PiAiAdapter over the parsed models. One provider id (`minimax`)
 * carries the whole roster, matching how the desktop client presents them.
 *
 * `readPrefs` is called per model build rather than captured once, so a settings
 * save changes the roster on the next read without re-registering the provider.
 * The filter and the switch therefore cannot drift apart.
 */
async function buildAdapter(resolved, roster, readPrefs, ctx) {
  const p = await loadPeers();
  // Each slot already holds the exported function itself, not the module.
  if (typeof p.piAi !== 'function' || typeof p.anthropic !== 'function' || typeof p.adapter !== 'function') {
    return { adapter: null, error: `peer packages unavailable: ${p.errors.join('; ') || 'unknown'}` };
  }
  const createProvider = p.piAi;
  const anthropicMessagesApi = p.anthropic;
  const Adapter = p.adapter;

  const buildModels = () => {
    const prefs = readPrefs?.() ?? {};
    return filterByEnabled(roster.models, prefs.enabledIds).map((m) => toPiModel(m, resolved.baseUrl, prefs));
  };
  const models = buildModels();
  const provider = {
    ...createProvider({
      id: PROVIDER_ID,
      name: 'MiniMax Code',
      auth: {
        apiKey: {
          name: 'MiniMax Code credential',
          resolve: async () => {
            // Waits for a renewal when the stored token is about to expire, so
            // the provider keeps answering with MiniMax Code closed.
            const credential = await freshCredential(resolved.authFile);
            if (!credential.ok) return undefined;
            return { auth: { headers: { Authorization: `${credential.tokenType ?? 'Bearer'} ${credential.token}` } }, source: 'MiniMax Code sign-in' };
          },
        },
      },
      models,
      api: anthropicMessagesApi(),
    }),
    // Read fresh on every call so a switch flip reaches the model picker.
    getModels: () => buildModels(),
  };

  const profiles = new Map([[PROVIDER_ID, {
    provider: PROVIDER_ID,
    displayName: 'MiniMax Code',
    ...profileDefaults(),
    streamIdleTimeoutMs: 180_000,
    configuredMaxTokens: new Map(),
    modelErrors: new Map(),
    piProvider: provider,
  }]]);

  const adapter = new Adapter({
    profiles: () => profiles,
    // Credentials ride on the provider's own resolve(); the adapter-level hook
    // stays inert so there is exactly one place the token is read.
    resolveApiKey: async () => undefined,
    ...hostOptions(ctx),
  });
  return { adapter, error: undefined, models };
}

// --------------------------------------------------------------------- apply

function isLoopback(address) {
  if (typeof address !== 'string' || address.length === 0) return false;
  const normalised = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
  return normalised === '::1' || normalised === '127.0.0.1' || normalised.startsWith('127.');
}

function send(response, status, body, contentType) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  response.writeHead(status, {
    'content-type': `${contentType}; charset=utf-8`,
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  response.end(payload);
}

/**
 * Diagnostics handle.
 *
 * The host only ever calls {@link apply}, but the renewal path is worth
 * reaching from a one-off script: it runs solely while the stored token sits
 * inside {@link RENEW_MARGIN_MS} of expiry, which is a state that cannot be
 * arranged on demand and is exactly the path that decides whether MiniMax Code
 * still has to be running. Exporting the internals keeps that verifiable
 * without standing up a host. Inert otherwise — nothing here runs at load.
 */
export const __diagnostics = {
  buildAdapter,
  parseModels,
  renewCredential,
  freshCredential,
  readCredential,
  readCredentialRecord,
  nextGeneration,
  expiresWithin,
  mirrorAuthState,
  defaultAuthFile,
  RENEW_MARGIN_MS,
  OAUTH_TOKEN_ENDPOINT,
  OAUTH_CLIENT_ID,
  OAUTH_SCOPE,
  OAUTH_AUDIENCE,
};

export function apply(ctx, config) {
  const resolved = {
    baseUrl: config.baseUrl ?? DEFAULT_BASE,
    cloudBaseUrl: config.cloudBaseUrl ?? CLOUD_BASE,
    authFile: config.authFile || defaultAuthFile(),
    configFile: config.configFile || defaultConfigFile(),
    statusRoute: config.statusRoute ?? '/plugins/dsh-minimax-connect/status',
    usageRoute: config.usageRoute ?? '/plugins/dsh-minimax-connect/usage',
    checkinRoute: config.checkinRoute ?? '/plugins/dsh-minimax-connect/checkin',
    signinStatusRoute: config.signinStatusRoute ?? '/plugins/dsh-minimax-connect/signin',
    claimRoute: config.claimRoute ?? '/plugins/dsh-minimax-connect/signin/claim',
    panelRoute: config.panelRoute ?? '/plugins/dsh-minimax-connect/panel',
    modelsRoute: config.modelsRoute ?? '/plugins/dsh-minimax-connect/models',
    saveRoute: config.saveRoute ?? '/plugins/dsh-minimax-connect/__save',
    cacheMs: config.cacheMs ?? 15_000,
  };
  const log = (m) => ctx.logger?.info?.(`minimax-connect: ${m}`);
  renewalState(resolved.authFile).log = log;

  /**
   * The settings namespace the host serves this plugin under, resolved once
   * from the Loader entry id (see {@link settingsNamespaceOf}).
   */
  const settingsNs = settingsNamespaceOf(ctx, FALLBACK_NS);

  /**
   * The live settings document, read through `config`'s own volatile fields.
   *
   * `config` is the Loader-provided configuration object, whose volatile fields
   * expose `{ get() }`. Reading it per call is what makes a save visible to the
   * next model build without a restart.
   */
  const readPreferences = () => ({
    enabledIds: unwrapVolatile(config.enabledModelIds) ?? {},
    imageModes: unwrapVolatile(config.imageOverrides) ?? {},
    preferMaximumContext: unwrapVolatile(config.useMaximumContextWindow) === true,
  });

  // ---- provider registration (best effort; the card still works without it)
  const roster = parseModels(resolved.configFile);
  let releaseAdapter;
  let releaseDirectory;
  let adapterHandle;
  let disposed = false;
  // The adapter build is async (peers are ESM), so it runs detached: a slow or
  // failing peer must never delay the routes the card needs, and the settings
  // surface stays available either way.
  loadPeers()
    .then(async (peers) => {
      if (disposed) return;
      if (typeof peers.piAi !== 'function') {
        ctx.logger?.warn?.(`minimax-connect: provider not registered — ${peers.errors.join('; ') || 'pi-ai unavailable'}`);
        return;
      }
      const built = await buildAdapter(resolved, roster, readPreferences, ctx);
      // The host can unload or hot-reload this fiber while peer setup is
      // pending. Never register an adapter or picker entry for a dead fiber.
      if (disposed) return;
      if (built.adapter === null) {
        ctx.logger?.warn?.(`minimax-connect: provider not registered — ${built.error}`);
        return;
      }
      adapterHandle = built.adapter;
      try {
        releaseAdapter = ctx.llm.registerAdapter([PROVIDER_ID], built.adapter);
        const active = readPreferences();
        log(`provider "${PROVIDER_ID}" registered with ${filterByEnabled(roster.models, active.enabledIds).length}/${roster.models.length} models (from ${roster.source})`);
      } catch (error) {
        ctx.logger?.error?.('minimax-connect: registerAdapter failed', error);
      }
      /**
       * Declare the route to the settings/model surface.
       *
       * `registerAdapter` alone only makes the provider routable — it does NOT
       * put it in the model picker. The picker is built from the llm service's
       * configurable-provider directory, so without this call the provider
       * answers requests but appears nowhere in the UI (measured: exactly the
       * "models are missing from the selector" symptom).
       *
       * `settingsNs` must be a namespace a section is actually installed into
       * (`registerConfigurableProviders` merely *addresses* it); `settingsPath`
       * is deliberately empty because this plugin serves its own settings
       * section, so there is no sub-schema for the host to walk.
       */
      try {
        releaseDirectory = ctx.llm.registerConfigurableProviders([{
          provider: PROVIDER_ID,
          displayName: 'MiniMax Code',
          settingsNs,
          settingsPath: [],
          declared: false,
        }]);
      } catch (error) {
        ctx.logger?.error?.('minimax-connect: registerConfigurableProviders failed; the provider stays routable but will not appear in the model picker', error);
      }
    })
    .catch((error) => ctx.logger?.error?.('minimax-connect: provider setup failed', error));
  ctx.effect(() => () => {
    disposed = true;
    try { releaseDirectory?.(); } catch { /* disposed twice is harmless */ }
    try { releaseAdapter?.(); } catch { /* disposed twice is harmless */ }
  }, 'minimax-connect: adapter lifecycle');

  /**
   * Proactive renewal.
   *
   * MiniMax Code expires this record hourly, and a turn that opens on a token
   * with seconds left dies mid-stream. Polling once a minute keeps the stored
   * credential comfortably ahead of that whether or not any request happens to
   * be in flight, and it is the reason this plugin survives the desktop app
   * being closed. The timer is unref'd so it can never hold the host open, and
   * it is torn down with the plugin.
   */
  ctx.effect(() => {
    const timer = setInterval(() => {
      const credential = readCredential(resolved.authFile);
      if (!credential.ok) return;
      if (!expiresWithin(credential, RENEW_MARGIN_MS) && !credential.needsStateRepair) return;
      if (renewalParked(credential, renewalState(resolved.authFile))) return;
      void ensureRenewal(resolved.authFile);
    }, 60_000);
    timer?.unref?.();
    return () => clearInterval(timer);
  }, 'minimax-connect: credential renewal');

  /** Tell the host the roster moved, so the picker re-reads it. */
  const refreshPicker = () => {
    try {
      adapterHandle?.invalidate?.();
      ctx.emit?.('llm/adapters-updated');
    } catch (error) {
      ctx.logger?.warn?.('minimax-connect: could not signal the model picker', error);
    }
  };

  // ---- status cache (check-in mutates the balance, so it is invalidated)
  let cache = { at: 0, value: null };
  const withLiveModels = value => ({ ...value, models: roster.models, modelsSource: roster.source });
  const snapshot = async () => {
    const now = Date.now();
    if (cache.value !== null && now - cache.at < resolved.cacheMs) return withLiveModels(cache.value);
    const value = await collectSnapshot(resolved, roster);
    cache = { at: now, value };
    return withLiveModels(value);
  };
  const invalidate = () => { cache = { at: 0, value: null }; };

  // ---- routes
  ctx.inject(['webServer'], (webCtx) => {
    const guard = (method) => (request, response) => {
      if (request.method !== method) { send(response, 405, { error: `${method} only` }, 'application/json'); return false; }
      if (!isLoopback(request.socket?.remoteAddress)) { send(response, 403, { error: 'loopback only' }, 'application/json'); return false; }
      const connection = webCtx.get?.('connection');
      if (typeof connection?.admit !== 'function') { send(response, 503, { error: 'DSH connection service unavailable' }, 'application/json'); return false; }
      const admission = connection.admit(request);
      if (admission.rejection) { send(response, admission.rejection, { error: 'DSH authentication required' }, 'application/json'); return false; }
      if (admission.peer?.principal?.kind !== 'owner') { send(response, 403, { error: 'DSH owner required' }, 'application/json'); return false; }
      return true;
    };

    ctx.effect(() => webCtx.webServer.register({
      kind: 'exact', path: resolved.statusRoute,
      handler: async (request, response) => {
        if (!guard('GET')(request, response)) return;
        try { send(response, 200, await snapshot(), 'application/json'); }
        catch (error) { send(response, 500, { error: error.message }, 'application/json'); }
      },
    }), `minimax-connect: GET ${resolved.statusRoute}`);

    ctx.effect(() => webCtx.webServer.register({
      kind: 'exact', path: resolved.usageRoute,
      handler: async (request, response) => {
        if (!guard('GET')(request, response)) return;
        const credential = await freshCredential(resolved.authFile);
        if (!credential.ok) { send(response, 200, { signedIn: false, reason: credential.reason }, 'application/json'); return; }
        try {
          const r = await callJson(`${resolved.cloudBaseUrl}/credit/details`, credential);
          send(response, 200, { signedIn: true, ...r.body }, 'application/json');
        } catch (error) { send(response, 502, { error: String(error.cause?.code ?? error.message) }, 'application/json'); }
      },
    }), `minimax-connect: GET ${resolved.usageRoute}`);

    ctx.effect(() => webCtx.webServer.register({
      kind: 'exact', path: resolved.signinStatusRoute,
      handler: async (request, response) => {
        if (!guard('GET')(request, response)) return;
        const credential = await freshCredential(resolved.authFile);
        if (!credential.ok) { send(response, 200, { signedIn: false, reason: credential.reason }, 'application/json'); return; }
        try {
          const r = await callJson(`${resolved.cloudBaseUrl}/signin/status?timezone_id=${encodeURIComponent(TZ)}`, credential);
          send(response, 200, { signedIn: true, ...r.body }, 'application/json');
        } catch (error) { send(response, 502, { error: String(error.cause?.code ?? error.message) }, 'application/json'); }
      },
    }), `minimax-connect: GET ${resolved.signinStatusRoute}`);

    ctx.effect(() => webCtx.webServer.register({
      kind: 'exact', path: resolved.claimRoute,
      handler: async (request, response) => {
        if (!guard('POST')(request, response)) return;
        try {
          const result = await claimCheckin(resolved);
          invalidate();
          send(response, result.ok ? 200 : 502, result, 'application/json');
        } catch (error) { send(response, 500, { error: error.message }, 'application/json'); }
      },
    }), `minimax-connect: POST ${resolved.claimRoute}`);

    ctx.effect(() => webCtx.webServer.register({
      kind: 'exact', path: resolved.panelRoute,
      handler: async (request, response) => {
        if (!guard('GET')(request, response)) return;
        send(response, 200, renderPanel(resolved), 'text/html');
      },
    }), `minimax-connect: GET ${resolved.panelRoute}`);

    /**
     * The model rows the card renders, with the user's saved choices applied.
     * Read from the host rather than the settings document: the roster is live
     * catalog state, and the catalogue is local, so `?refresh=1` simply re-reads
     * config.yaml and picks up models MiniMax added to the desktop client.
     */
    ctx.effect(() => webCtx.webServer.register({
      kind: 'exact', path: resolved.modelsRoute,
      handler: async (request, response) => {
        if (!guard('GET')(request, response)) return;
        try {
          const refresh = new URL(request.url ?? '/', 'http://localhost').searchParams.get('refresh') === '1';
          if (refresh) {
            Object.assign(roster, parseModels(resolved.configFile));
            invalidate();
            refreshPicker();
          }
          const fresh = roster;
          const prefs = readPreferences();
          send(response, 200, {
            source: fresh.source,
            models: fresh.models.map((m) => ({
              id: m.id,
              name: m.name,
              context: m.context,
              contextMax: m.contextMax ?? m.context,
              maxTokens: m.maxTokens,
              vision: m.vision === true,
              enabled: prefs.enabledIds[m.id] !== false,
              imageMode: prefs.imageModes[m.id] ?? 'auto',
            })),
            preferMaximumContext: prefs.preferMaximumContext,
            activeCount: filterByEnabled(fresh.models, prefs.enabledIds).length,
            totalCount: fresh.models.length,
          }, 'application/json');
        } catch (error) { send(response, 500, { error: error.message }, 'application/json'); }
      },
    }), `minimax-connect: GET ${resolved.modelsRoute}`);

    /**
     * The authoritative settings write.
     *
     * Registered under `webServer` ALONE (never `inject(['webServer','settings'])`)
     * so the route exists whether or not a settings service is served: a
     * service-absent 503 is then a real, readable answer instead of a 404 the
     * card would mistake for "no such route".
     *
     * `settings.mutate()` resolving is not evidence the value landed on the 0.2
     * line, so the document is re-read and deep-compared before reporting
     * success.
     */
    ctx.effect(() => webCtx.webServer.register({
      kind: 'exact', path: resolved.saveRoute,
      handler: async (request, response) => {
        if (!guard('POST')(request, response)) return;
        let body = '';
        try {
          for await (const chunk of request) body += chunk;
        } catch { /* fall through to the empty-body branch */ }
        let posted;
        try { posted = JSON.parse(body || '{}'); } catch { send(response, 400, { error: 'body must be JSON' }, 'application/json'); return; }

        const field = posted?.field;
        if (typeof field !== 'string' || !Object.hasOwn(SAVE_FIELDS, field)) {
          send(response, 400, { error: `field must be one of ${Object.keys(SAVE_FIELDS).join(', ')}` }, 'application/json');
          return;
        }
        const settings = webCtx.get?.('settings');
        if (settings === undefined || settings === null) {
          send(response, 503, { error: 'settings service unavailable to this fiber' }, 'application/json');
          return;
        }
        try {
          const rows = settings.describe();
          const row = findSettingsRow(rows, [settingsNs, FALLBACK_NS]);
          if (row === undefined) {
            send(response, 503, { error: `${settingsNs}/${FALLBACK_NS} namespace missing from describe(); known: ${rows.map((e) => String(e.ns)).join(', ')}` }, 'application/json');
            return;
          }
          const ns = String(row.ns);
          await settings.mutate(ns, [{ op: 'set', path: [field], value: posted.value }], void 0);
          const readBack = unwrapVolatile(settings.describe().find((e) => String(e.ns) === row.ns)?.value?.[field]);
          if (JSON.stringify(readBack) !== JSON.stringify(posted.value)) {
            send(response, 200, { ok: false, errorName: 'read-back-mismatch', error: 'settings.mutate returned but the value did not land', value: posted.value, readBack }, 'application/json');
            return;
          }
          refreshPicker();
          send(response, 200, { ok: true, value: readBack }, 'application/json');
        } catch (error) {
          send(response, 500, { ok: false, errorName: error?.name ?? 'unknown', error: String(error?.message ?? error) }, 'application/json');
        }
      },
    }), `minimax-connect: POST ${resolved.saveRoute}`);
  });

  // ---- settings section so the card has a served namespace
  ctx.inject(['settings'], (settingsCtx) => {
    const settings = settingsCtx.settings;
    if (settings === undefined || typeof settings.installSection !== 'function') {
      ctx.logger?.warn?.('minimax-connect: host settings service has no installSection API');
      return;
    }
    // The section is what gives the card a served namespace to write through;
    // the fields themselves live in Config (all volatile).
    settings.installSection(ctx, settingsNs, z.object({}), config, {
      setSource() { return config; },
      onChange() { refreshPicker(); },
    });
  });
}

/** Self-contained panel: no build step, no framework. */
function renderPanel(resolved) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>MiniMax Code</title><style>
body{font:14px/1.6 system-ui,sans-serif;margin:0;padding:18px;color:#e8e8ea;background:#1d1e22}
h1{font-size:16px;margin:0 0 12px}
.grid{display:flex;gap:12px;flex-wrap:wrap}
.card{flex:1 1 220px;border:1px solid #33353c;border-radius:10px;padding:14px;background:#24262b}
.big{font-size:30px;font-weight:600}
.muted{color:#9aa0a6;font-size:12px}
button{margin-top:10px;padding:8px 14px;border-radius:8px;border:0;background:#3b6ef6;color:#fff;cursor:pointer}
button[disabled]{background:#3a3d45;color:#8b8f96;cursor:default}
table{border-collapse:collapse;margin-top:8px;font-size:12px}
td,th{border:1px solid #33353c;padding:4px 8px;text-align:left}
.err{color:#ff8a80;font-size:12px}
</style></head><body>
<h1>MiniMax Code</h1>
<div id="root" class="grid"></div>
<script>
const S=${JSON.stringify(resolved.statusRoute)}, C=${JSON.stringify(resolved.claimRoute)};
const get=(u)=>fetch(u,{headers:{accept:'application/json'}}).then(r=>r.json());
function esc(s){return String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}
async function paint(){
  const root=document.getElementById('root');
  let d;
  try{ d=await get(S); }catch(e){ root.innerHTML='<div class="card err">读取失败：'+esc(e.message)+'</div>'; return; }
  const parts=[];
  const p=d.points;
  parts.push('<div class="card"><div class="muted">积分余额</div><div class="big">'+(p?p.remaining.toFixed(2):'—')+'</div>'+
    (p?'<div class="muted">已用 '+p.consumed.toFixed(2)+' / 授予 '+p.granted.toFixed(2)+'</div>':'')+'</div>');
  const s=d.signin;
  const btn=s&&s.claimableToday&&!s.claimedToday
    ? '<button id="ck">立即签到（+'+s.todayPoints+'）</button>'
    : '<button disabled>'+(s&&s.claimedToday?'今日已签到':'暂不可签')+'</button>';
  parts.push('<div class="card"><div class="muted">每日签到</div><div class="big">'+(s?(s.claimedToday?'已领':'待领'):'—')+'</div>'+btn+'</div>');
  parts.push('<div class="card"><div class="muted">账号</div><div>'+(d.signedIn?'已登录':'未登录')+'</div>'+
    '<div class="muted">'+(d.expiresAtMs?('token 到期 '+new Date(d.expiresAtMs).toLocaleString()):'')+'</div>'+
    (function(){ const r=d.selfRenewal; if(!r) return '';
      if(!r.hasRefreshToken) return '<div class="err">缺少 refreshToken，需在 MiniMax Code 中重新登录</div>';
      if(r.blocked) return '<div class="err">自动续期暂停，'+new Date(r.blockedUntil).toLocaleTimeString()+' 后重试</div>';
      return '<div class="muted">自动续期已启用（'+Math.round(r.marginMs/60000)+' 分钟前续期，无需打开 MiniMax Code）</div>'; })()+'</div>');
  root.innerHTML=parts.join('');
  const t=document.createElement('table');
  t.innerHTML='<tr><th>模型</th><th>上下文</th><th>输出</th><th>图像</th></tr>'+
    (d.models||[]).map(m=>'<tr><td>'+esc(m.name)+'</td><td>'+m.context+'</td><td>'+m.maxTokens+'</td><td>'+(m.vision?'✓':'')+'</td></tr>').join('');
  const wrap=document.createElement('div'); wrap.className='card';
  wrap.appendChild(t); wrap.insertAdjacentHTML('afterbegin','<div class="muted">模型（'+esc(d.modelsSource||'')+'）</div>');
  root.appendChild(wrap);
  if(d.errors&&d.errors.length){ const e=document.createElement('div'); e.className='card';
    e.innerHTML='<div class="err">'+d.errors.map(esc).join('<br>')+'</div>'; root.appendChild(e); }
  const ck=document.getElementById('ck');
  if(ck) ck.onclick=async()=>{ ck.disabled=true; ck.textContent='签到中…';
    const r=await fetch(C,{method:'POST'}).then(x=>x.json()).catch(e=>({ok:false,error:e.message}));
    ck.textContent=r.ok?'已签到':('失败：'+(r.error||'')); setTimeout(paint,900); };
}
paint();
setInterval(paint,30000);
</script></body></html>`;
}
