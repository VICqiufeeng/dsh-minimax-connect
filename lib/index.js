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
  /**
   * Image access resolver from the host's own llm package. A 0.2.x adapter
   * expects the model-visible read-only path for every request image, so the
   * tool layer can describe a preview it can also point at.
   */
  imageAccess: ['@deepseek-ai/dsh-llm', 'resolveImageAttachmentAccess'],
  /**
   * The credential store and the ambient auth context the 0.2.x adapter asks
   * for (`PiAiAdapterOptions.auth`).
   *
   * They are loaded as peers rather than imported statically, so a pi-ai build
   * that does not export them degrades to "no auth injection" instead of
   * failing the module load.
   */
  credentialStore: ['@earendil-works/pi-ai', 'InMemoryCredentialStore'],
  authContext: ['@earendil-works/pi-ai', 'defaultProviderAuthContext'],
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

/**
 * Route id of the provider this plugin owns.
 *
 * `minimax` is taken: llm-pi-ai declares every provider its installed pi-ai
 * catalog ships as a *configurable* provider on activation, `minimax` among
 * them, so `registerConfigurableProviders` answered
 * `configurable provider "minimax" is already declared` and the Models settings
 * page kept pointing at the API-key route instead of this one. A distinct id
 * also keeps a saved selection unambiguous: `minimax` = API key + official
 * endpoint, `minimax-code` = the Mavis sign-in on this machine.
 */
const PROVIDER_ID = 'minimax-code';

/**
 * The thinking ladder this route offers: `xhigh` and `max`, spelled as
 * Anthropic adaptive-thinking effort values, which the Mavis gateway accepts
 * verbatim (measured: effort xhigh / max both answer 200).
 *
 * Every other level is pinned to `null`, which is pi-ai's "unsupported":
 *   - `off` must not be offered, because the gateway rejects
 *     `thinking: {type:"disabled"}` with `model requires adaptive thinking`;
 *   - the remaining levels are simply not wanted on this route.
 * A `null` entry is also what keeps the request free of a thinking block when
 * no level is selected — the request then falls through to the provider's own
 * default, which is what the first-party client's `default` does.
 */
const THINKING_LEVEL_MAP = Object.freeze({
  off: null,
  minimal: null,
  low: null,
  medium: null,
  high: null,
  xhigh: 'xhigh',
  max: 'max',
});

/** Adaptive thinking is the only mode the Mavis gateway accepts (measured). */
const ANTHROPIC_COMPAT = Object.freeze({ forceAdaptiveThinking: true });

/**
 * Request-image budgets, mirroring the llm-pi-ai route defaults: 2048×2048
 * pixels per image, 1 MiB encoded, 20 MiB accumulated per request.
 *
 * A 0.2.x adapter derives every image target from the first two
 * (`requestImageTarget` → `requestImageDimensions`). Omitting them made the
 * target width `undefined`, and the attachment service answers that with
 * `Image request width must be a positive integer.` — the exact failure this
 * fork fixes.
 */
const IMAGE_BUDGET = Object.freeze({
  requestImagePixelBudget: 4_194_304,
  requestImageMaxBytes: 1_048_576,
  maxRequestImageBytes: 20_971_520,
});

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

/**
 * Read the stored token. Returns `{ ok, token, expiresAtMs, reason }` and never
 * throws: a machine without MiniMax Code signed in must degrade to "not signed
 * in", not crash the loader.
 */
function readCredential(authFile) {
  const file = authFile || defaultAuthFile();
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    return { ok: false, reason: `unreadable: ${error.code ?? error.message}`, token: undefined };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { ok: false, reason: `not JSON: ${error.message}`, token: undefined };
  }
  const records = parsed?.records ?? {};
  const first = Object.values(records)[0];
  const token = first?.accessToken;
  if (typeof token !== 'string' || token.length === 0) {
    return { ok: false, reason: 'no accessToken record', token: undefined };
  }
  return {
    ok: true,
    token,
    tokenType: typeof first.tokenType === 'string' ? first.tokenType : 'Bearer',
    expiresAtMs: typeof first.expiresAtMs === 'number' ? first.expiresAtMs : undefined,
    refreshToken: typeof first.refreshToken === 'string' ? first.refreshToken : undefined,
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

/** Wall-clock deadline for the current backoff window; 0 means "free to try". */
let renewBlockedUntil = 0;
/**
 * The refresh token the current backoff belongs to.
 *
 * A different token means the user signed in again in MiniMax Code, which is
 * the one condition the backoff must not survive: the provider has to come back
 * the moment a usable credential exists, not when a timer happens to expire.
 */
let renewBlockedToken;
/** Contention is not the endpoint's fault, so it parks for far less time. */
const RENEW_LOCK_RETRY_MS = 30_000;
/** In-flight grant, so concurrent requests share a single token exchange. */
let renewalInFlight = null;
/** Set by {@link apply}; module-level helpers have no `ctx` of their own. */
let hostLog = () => {};

function parkRenewal(ms, token) {
  renewBlockedUntil = Date.now() + ms;
  renewBlockedToken = token;
}

function unparkRenewal() {
  renewBlockedUntil = 0;
  renewBlockedToken = undefined;
}

/**
 * True while a previous failure still parks renewals — and false, with the park
 * lifted, as soon as the credential on disk is no longer the one that failed.
 */
function renewalParked(credential) {
  if (renewBlockedUntil === 0) return false;
  if (Date.now() >= renewBlockedUntil) { unparkRenewal(); return false; }
  if (credential?.refreshToken !== renewBlockedToken) { unparkRenewal(); return false; }
  return true;
}

/**
 * The whole stored record rather than just the token, because a renewal has to
 * rewrite it. `undefined` for anything unreadable or unparsable, which the
 * callers treat exactly as {@link readCredential} treats a missing login.
 */
function readCredentialRecord(authFile) {
  const file = authFile || defaultAuthFile();
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

function writeJsonAtomic(file, value) {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, file);
}

/**
 * The cross-process lock the MiniMax Code client itself takes, reproduced.
 *
 * Both processes renew the *same* single-use refresh token, so they have to
 * serialise: two renewals racing on one token make the service treat the second
 * as a replay and revoke the whole token family — measured, and it costs the
 * user a fresh sign-in. The first-party client guards this with
 * `proper-lockfile` on `<namespaceHome>/auth.lock`; that module is not
 * resolvable from a plugin, so the same on-disk convention is rebuilt here:
 * the lock is a directory named `<lockPath>.lock`, `mkdir` is the atomic
 * acquisition, and a directory older than {@link AUTH_LOCK_STALE_MS} is
 * abandoned by its owner and reclaimed. That stale window matches the client's
 * own (`staleMs: 30_000`), so neither side steals a lock the other still holds.
 */
const AUTH_LOCK_STALE_MS = 30_000;
/** Give up rather than block a request forever behind a wedged holder. */
const AUTH_LOCK_WAIT_MS = 20_000;
const AUTH_LOCK_POLL_MS = 60;

/** The client's namespace keeps `auth.lock` next to `auth.json`. */
function authLockPath(authFile) {
  return path.join(path.dirname(authFile || defaultAuthFile()), 'auth.lock');
}

function delay(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

async function withAuthLock(lockPath, operation) {
  const directory = `${lockPath}.lock`;
  const deadline = Date.now() + AUTH_LOCK_WAIT_MS;
  let held = false;
  while (!held) {
    try {
      fs.mkdirSync(directory);
      held = true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let ageMs = 0;
      try {
        ageMs = Date.now() - fs.statSync(directory).mtimeMs;
      } catch {
        continue; // Released between the mkdir and the stat: try again at once.
      }
      if (ageMs > AUTH_LOCK_STALE_MS) {
        try { fs.rmdirSync(directory); } catch { /* somebody else reclaimed it first */ }
        continue;
      }
      if (Date.now() > deadline) throw new Error(`held by another process for ${Math.round(ageMs)}ms`);
      await delay(AUTH_LOCK_POLL_MS);
    }
  }
  try {
    return await operation();
  } finally {
    try { fs.rmdirSync(directory); } catch { /* already reclaimed as stale */ }
  }
}

/** The generation `auth-state.json` currently advertises, or 0 when there is none. */
function readAuthStateGeneration(authFile) {
  try {
    const state = JSON.parse(fs.readFileSync(path.join(path.dirname(authFile), 'auth-state.json'), 'utf8'));
    return typeof state?.generation === 'number' && Number.isSafeInteger(state.generation) && state.generation >= 0 ? state.generation : 0;
  } catch {
    return 0;
  }
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
  try {
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    writeJsonAtomic(stateFile, { ...state, status: 'authenticated', generation: record.generation, expiresAtMs: record.expiresAtMs });
  } catch {
    /* no companion file, or nothing of ours to rewrite */
  }
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
async function renewCredential(authFile) {
  const initial = readCredentialRecord(authFile);
  if (initial === undefined) return { ok: false, reason: 'no credential record on disk' };
  if (typeof initial.record?.refreshToken !== 'string' || initial.record.refreshToken.length === 0) {
    return { ok: false, reason: 'record carries no refreshToken', fatal: true };
  }
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
    return await withAuthLock(authLockPath(initial.file), async () => {
      const current = readCredentialRecord(initial.file);
      if (current === undefined) return { ok: false, reason: 'credential record vanished while waiting for the lock' };
      const previous = current.record ?? {};
      if (typeof previous.expiresAtMs === 'number' && previous.expiresAtMs - Date.now() > RENEW_MARGIN_MS) {
        return { ok: true, adopted: true, expiresAtMs: previous.expiresAtMs, generation: previous.generation };
      }
      let response;
      try {
        response = await fetch(OAUTH_TOKEN_ENDPOINT, {
          method: 'POST',
          headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: previous.refreshToken,
            client_id: OAUTH_CLIENT_ID,
            scope: OAUTH_SCOPE,
            audience: OAUTH_AUDIENCE,
          }),
        });
      } catch (error) {
        return { ok: false, reason: `endpoint unreachable: ${error.cause?.code ?? error.message}` };
      }
      const text = await response.text();
      let grant;
      try { grant = JSON.parse(text); } catch { grant = undefined; }
      if (!response.ok || typeof grant?.access_token !== 'string') {
        const fatal = grant?.error === 'invalid_grant';
        return { ok: false, reason: `grant refused: HTTP ${response.status} ${text.slice(0, 200)}`, fatal };
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
        writeJsonAtomic(current.file, payload);
      } catch (error) {
        return { ok: false, reason: `renewed but could not be stored: ${error.message}` };
      }
      mirrorAuthState(current.file, record);
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
  if (renewalInFlight !== null) return renewalInFlight;
  const attempt = renewCredential(authFile).then(
    (result) => {
      renewalInFlight = null;
      const token = readCredential(authFile)?.refreshToken;
      if (result.ok) unparkRenewal();
      else {
        parkRenewal(result.contended ? RENEW_LOCK_RETRY_MS : RENEW_BACKOFF_MS, token);
        if (result.fatal) hostLog(`credential renewal impossible — ${result.reason}; sign in again in MiniMax Code`);
        else hostLog(`credential renewal failed — ${result.reason}`);
      }
      return result;
    },
    (error) => {
      renewalInFlight = null;
      parkRenewal(RENEW_BACKOFF_MS, readCredential(authFile)?.refreshToken);
      return { ok: false, reason: String(error?.message ?? error) };
    },
  );
  renewalInFlight = attempt;
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
  if (!expiresWithin(stored, RENEW_MARGIN_MS)) return stored;
  if (renewalParked(stored)) return stored;
  const result = await ensureRenewal(authFile);
  if (!result.ok) return stored;
  const renewed = readCredential(authFile);
  return renewed.ok ? renewed : stored;
}

// ------------------------------------------------------------ auth retry

/**
 * Whether one terminal chunk reports a credential refusal.
 *
 * pi-ai delivers a failed request as a `finish` chunk whose reason carries the
 * provider's message; llm-pi-ai classifies a 401/403 as the code `AUTH` and
 * puts the raw body in the message (`401 {"error":"invalid access token"}`).
 *
 * @param reason - the `finish` chunk's reason.
 * @returns true when the turn failed because the credential was refused.
 */
function isAuthFailure(reason) {
  const failure = reason?.failure;
  if (failure === undefined || failure === null) return false;
  if (failure.code === 'AUTH') return true;
  const message = String(failure.message ?? '');
  return /\b(?:401|403)\b/.test(message) || /invalid access token/i.test(message);
}

/**
 * Send one request, and send it again when the provider refused the
 * credential.
 *
 * A refresh rotates the access token and the gateway invalidates the previous
 * one immediately, so a request that grabbed its token a moment before the
 * rotation can be refused with `401 invalid access token` even though a
 * perfectly good credential is on disk. Renewing and replaying the turn turns
 * that failure into a normal turn.
 *
 * The replay is bounded to one attempt: a second refusal means the credential
 * itself is gone (the grant said `invalid_grant`), which only a fresh sign-in
 * in MiniMax Code can fix.
 *
 * @param makeStream - produces one attempt's chunk stream.
 * @param renew - renews the credential; answers false when it could not.
 * @returns the chunk stream of the attempt that counts.
 */
async function* withAuthRetry(makeStream, renew) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const chunks = [];
    let failure;
    for await (const chunk of makeStream()) {
      if (failure === undefined && chunk?.type === 'finish' && isAuthFailure(chunk.reason)) {
        failure = chunk.reason.failure;
        continue;
      }
      // Anything after the terminal failure belongs to the abandoned attempt.
      if (failure !== undefined) continue;
      chunks.push(chunk);
    }
    if (failure === undefined) {
      yield* chunks;
      return;
    }
    if (attempt === 0 && await renew()) continue;
    yield { type: 'finish', reason: { kind: 'error', failure } };
    return;
  }
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
  let inModels = false;
  let current = null;
  let inContextOptions = false;
  for (const line of lines) {
    if (/^\s{4}models:\s*$/.test(line)) { inModels = true; continue; }
    if (!inModels) continue;
    if (/^\s{4}[a-zA-Z]/.test(line)) { inModels = false; continue; }
    const keyMatch = /^ {6}([A-Za-z0-9._-]+):\s*$/.exec(line);
    if (keyMatch) {
      current = { id: keyMatch[1], name: keyMatch[1], context: 200_000, contextMax: 200_000, maxTokens: 128_000, reasoning: true, vision: false };
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
    if (cx) { current.context = Number(cx[1]); current.contextMax = Math.max(current.contextMax, current.context); continue; }
    const ot = /^\s{8,12}output:\s*(\d+)\s*$/.exec(line);
    if (ot) { current.maxTokens = Number(ot[1]); continue; }
    if (/^\s{12}- image\s*$/.test(line)) { current.vision = true; continue; }
    // `contextWindowOptions:` is the widest window the plan offers; the second
    // value is the "higher_usage" tier, which is what the max-context switch picks.
    if (/^\s{8,12}contextWindowOptions:\s*$/.test(line)) { inContextOptions = true; continue; }
    if (inContextOptions) {
      const opt = /^\s{10,14}-\s*(\d+)\s*$/.exec(line);
      if (opt) { current.contextMax = Math.max(current.contextMax, Number(opt[1])); continue; }
      if (!/^\s*$/.test(line)) inContextOptions = false;
    }
  }
  if (out.length === 0) return { models: FALLBACK_MODELS, source: 'fallback (no models parsed)' };
  return { models: out, source: 'config.yaml' };
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
  const reasoning = m.reasoning !== false;
  return {
    id: m.id,
    name: m.name,
    api: 'anthropic-messages',
    provider: PROVIDER_ID,
    baseUrl,
    reasoning,
    // The picker's ladder comes from pi-ai's supported-level scan, so an
    // explicit map is what makes low/medium/high/xhigh/max selectable — and
    // what keeps `off` (a request the gateway rejects) off the list.
    ...reasoning ? { thinkingLevelMap: THINKING_LEVEL_MAP, compat: ANTHROPIC_COMPAT } : {},
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
async function collectSnapshot(resolved) {
  const credential = await freshCredential(resolved.authFile);
  const roster = parseModels(resolved.configFile);
  const out = {
    signedIn: credential.ok,
    reason: credential.reason,
    expiresAtMs: credential.expiresAtMs,
    // `selfRenewal` tells the card whether this plugin can keep the sign-in
    // alive on its own, i.e. whether MiniMax Code still has to be running.
    selfRenewal: {
      marginMs: RENEW_MARGIN_MS,
      backoffMs: RENEW_BACKOFF_MS,
      blocked: Date.now() < renewBlockedUntil && renewBlockedToken === credential.refreshToken,
      blockedUntil: renewBlockedUntil || null,
      inFlight: renewalInFlight !== null,
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
 * Translate pi-ai's request-image policy into the attachment store's target.
 *
 * pi-ai 0.1.x asks for a request image with `{ maxPixels, maxBytes }`, while the
 * 0.2.x `@deepseek-ai/dsh-attachment-local` this host serves validates
 * `{ width, height, maxBytes }` and answers the older shape with
 * `INVALID_ATTACHMENT_REF` ("Image request width must be a positive integer").
 * A square box of the same pixel budget carries the intent across: the store
 * fits the image inside it with the aspect ratio kept and never enlarges, so
 * the result stays inside `maxPixels`. An explicit box on the policy wins over
 * the derived one, so a caller that already speaks the newer contract is left
 * alone.
 */
function toImageRequestTarget(policy) {
  const maxPixels = Number(policy?.maxPixels);
  if (!Number.isFinite(maxPixels) || maxPixels <= 0) return policy;
  const side = Math.max(1, Math.floor(Math.sqrt(maxPixels)));
  const width = Number(policy?.width);
  const height = Number(policy?.height);
  const maxBytes = Number(policy?.maxBytes);
  return {
    width: Number.isSafeInteger(width) && width > 0 ? width : side,
    height: Number.isSafeInteger(height) && height > 0 ? height : side,
    ...(Number.isFinite(maxBytes) && maxBytes > 0 ? { maxBytes } : {}),
  };
}

/**
 * The one rejection a mismatched contract produces, in both directions: each
 * store version validates the fields it knows and names the first one missing
 * from the other's shape.
 */
function rejectsOtherShape(error) {
  return error?.code === 'INVALID_ATTACHMENT_REF'
    && /Image request (width|height|maxPixels) must be a positive integer/.test(String(error?.message ?? ''));
}

/**
 * The facade is built once per store: `resolveAttachments` runs on every
 * stream, and pi-ai has to keep seeing the same object across those calls.
 */
const adaptedStores = new WeakMap();

/**
 * Hand pi-ai a store whose request-image calls survive either contract shape.
 *
 * Everything else is forwarded untouched, so the facade cannot quietly strip a
 * member some later pi-ai build reaches for. The shape a store speaks is
 * learned from its first answer and then reused, so the losing form is paid for
 * at most once instead of on every image.
 */
function adaptAttachmentStore(store) {
  if (store === null || store === undefined || typeof store.readImageRequest !== 'function') return store;
  const cached = adaptedStores.get(store);
  if (cached !== undefined) return cached;
  let shape;
  const readImageRequest = async (ref, policy, signal) => {
    if (typeof policy?.maxPixels !== 'number') return store.readImageRequest(ref, policy, signal);
    if (shape === 'legacy') return store.readImageRequest(ref, policy, signal);
    const target = toImageRequestTarget(policy);
    if (shape === 'target') return store.readImageRequest(ref, target, signal);
    try {
      const version = await store.readImageRequest(ref, target, signal);
      shape = 'target';
      return version;
    } catch (error) {
      // A genuine failure throws here as well, and the retry repeats it, so
      // nothing is masked — only the argument form differs.
      if (!rejectsOtherShape(error)) throw error;
      shape = 'legacy';
      return store.readImageRequest(ref, policy, signal);
    }
  };
  const facade = new Proxy(store, {
    get(target, property) {
      if (property === 'readImageRequest') return readImageRequest;
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  adaptedStores.set(store, facade);
  return facade;
}

/**
 * Build the PiAiAdapter over the parsed models. One provider id
 * (`minimax-code`) carries the whole roster, matching how the desktop client
 * presents them.
 *
 * `readPrefs` is called per model build rather than captured once, so a settings
 * save changes the roster on the next read without re-registering the provider.
 * The filter and the switch therefore cannot drift apart.
 *
 * @param resolveAttachments - host attachment service accessor, read per call.
 * @param mapHostPath - host path → model-visible path mapper (`ctx.fs`), used by
 *   the image-access hook the 0.2.x adapter expects.
 */
async function buildAdapter(resolved, roster, readPrefs, resolveAttachments, mapHostPath) {
  const p = await loadPeers();
  // Each slot already holds the exported function itself, not the module.
  if (typeof p.piAi !== 'function' || typeof p.anthropic !== 'function' || typeof p.adapter !== 'function') {
    return { adapter: null, error: `peer packages unavailable: ${p.errors.join('; ') || 'unknown'}` };
  }
  const createProvider = p.piAi;
  const anthropicMessagesApi = p.anthropic;
  const Adapter = p.adapter;
  const resolveImageAttachmentAccess = p.imageAccess;

  /**
   * The auth injection the 0.2.x adapter declares as required.
   *
   * `PiAiAdapterOptions.auth` carries the credential store and the ambient
   * auth context the pi-ai collection resolves the route's auth against. Left
   * out, the collection falls back to pi-ai's own in-memory defaults — which
   * is what this route has always run on, so passing them explicitly changes
   * nothing at runtime, but it does satisfy the contract the kernel declares
   * (and keeps the plugin honest if a later pi-ai changes those defaults).
   *
   * The route's own credential never travels through this store: it rides on
   * the provider's `auth.apiKey.resolve` and on the route headers.
   */
  const auth = typeof p.credentialStore === 'function' && typeof p.authContext === 'function'
    ? { credentials: new p.credentialStore(), authContext: p.authContext() }
    : undefined;

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
    streamIdleTimeoutMs: 180_000,
    /**
     * Default effort for a fresh selection. The route offers `xhigh` and `max`
     * only, so a model mounted without a default would fall back to the first
     * offered level (`xhigh`); `max` is the depth the first-party client itself
     * ships selected, so that is what a new selection starts on.
     */
    reasoning: 'max',
    /** Image targets for the 0.2.x adapter; see {@link IMAGE_BUDGET}. */
    ...IMAGE_BUDGET,
    configuredMaxTokens: new Map(),
    modelErrors: new Map(),
    piProvider: provider,
  }]]);

  /**
   * The adapter merges `profile.headers` into every request
   * (`dsh-llm-pi-ai`: `headers: requestHeaders(profile.headers)`), and that read
   * happens per stream rather than once at registration. A getter is therefore
   * used instead of a snapshot, so a token renewed after startup is picked up
   * without tearing the provider down.
   *
   * MiniMax wants `Authorization: Bearer`, not Anthropic's `x-api-key` — sending
   * the key through `apiKey` produced "401 token is required" (measured).
   */
  Object.defineProperty(profiles.get(PROVIDER_ID), 'headers', {
    enumerable: true,
    get() {
      const credential = readCredential(resolved.authFile);
      if (!credential.ok) return {};
      /**
       * The token on disk, verbatim — and nothing else.
       *
       * This getter used to kick off a renewal as a side effect. That is not
       * safe: the Mavis gateway invalidates the previous access token the
       * moment a refresh rotates it, so a renewal started here can kill the
       * token another request is already streaming with. Measured 2026-10-20:
       * a turn that opened 234 ms after the renewal answered died with
       * `401 {"error":"invalid access token"}` — the renewal had rotated the
       * token out from under the very request that triggered it.
       *
       * The renewal now happens where it can be awaited: the adapter's
       * pre-flight hook below runs before this getter is read, so a turn opens
       * on the token that is live *after* the rotation. The timer in `apply`
       * keeps the record fresh while nothing is in flight, and a request that
       * was already streaming when a rotation lands is retried by
       * {@link withAuthRetry}.
       */
      return { Authorization: `${credential.tokenType ?? 'Bearer'} ${credential.token}` };
    },
  });

  /**
   * Renew and replay one request that the provider refused with a credential
   * error.
   *
   * A 401 from the Mavis gateway means "the token you sent is no longer the
   * live one": it expired, or a refresh rotated it. Both are recoverable, so
   * the turn is sent again with the renewed credential instead of failing the
   * session.
   *
   * The failure arrives as a terminal `finish` chunk (pi-ai never throws
   * mid-stream — see `toStreamChunks` in llm-pi-ai), so the chunks of the
   * failed attempt are dropped rather than replayed: a 401 costs nothing, and
   * its usage counters describe a request the provider never ran.
   */
  class RetryingAdapter extends Adapter {
    async *streamWithSnapshot(options, snapshot) {
      yield* withAuthRetry(
        () => super.streamWithSnapshot(options, snapshot),
        async () => {
          const result = await ensureRenewal(resolved.authFile);
          if (result.ok) hostLog('credential renewed after a 401; the request is sent again');
          return result.ok;
        },
      );
    }
  }

  const adapter = new RetryingAdapter({
    profiles: () => profiles,
    /** The auth injection the 0.2.x adapter declares as required. */
    ...(auth === undefined ? {} : { auth }),
    /**
     * Pre-flight: the credential is renewed here — before the request headers
     * are read — so a turn never opens on a token that is about to expire, and
     * never opens on the token a rotation has just invalidated. The hook still
     * answers `undefined`: the token itself rides on the provider's own
     * `resolve` and on the route headers, because the gateway wants
     * `Authorization: Bearer`, not Anthropic's `x-api-key`.
     */
    resolveApiKey: async () => {
      await freshCredential(resolved.authFile);
      return undefined;
    },
    /**
     * Required by pi-ai the moment a message carries an image: without it the
     * adapter throws `pi-ai image input requires the durable attachment service`
     * (UNSUPPORTED_CONTENT) before the request ever leaves. The host's other
     * pi-ai routes all wire the same hook (`resolveAttachments: () =>
     * ctx.get("attachments")`).
     *
     * The store is passed through `adaptAttachmentStore` because the versions
     * on the two sides of this hook disagree on the request-image argument:
     * this plugin's pi-ai is 0.1.x (npm-global tree) while the host serves
     * attachment-local 0.2.x (app tree). Wiring the raw store made the plugin
     * trade one UNSUPPORTED_CONTENT for another failure one call deeper.
     */
    resolveAttachments: () => adaptAttachmentStore(resolveAttachments?.()),
    /**
     * The 0.2.x companion hook: give the adapter a model-visible read-only path
     * for each request image. It is the same two-step wiring the host's own
     * llm-pi-ai routes use (`resolveImageAttachmentAccess(attachments,
     * mapHostPath, ref)`), and without it the image block reaches the model with
     * no preview path at all.
     */
    ...typeof resolveImageAttachmentAccess === 'function' && typeof mapHostPath === 'function'
      ? { resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(attachments, mapHostPath, ref) }
      : {},
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
  renewCredential,
  freshCredential,
  readCredential,
  readCredentialRecord,
  nextGeneration,
  expiresWithin,
  mirrorAuthState,
  defaultAuthFile,
  /** Model descriptor builder, so the thinking ladder and image flags are testable. */
  toPiModel,
  parseModels,
  /** Auth-refusal detection and the renew-and-replay wrapper. */
  isAuthFailure,
  withAuthRetry,
  PROVIDER_ID,
  THINKING_LEVEL_MAP,
  /** Route-level image budgets handed to the 0.2.x adapter (test fixture). */
  IMAGE_BUDGET,
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
  hostLog = log;

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
  // The adapter build is async (peers are ESM), so it runs detached: a slow or
  // failing peer must never delay the routes the card needs, and the settings
  // surface stays available either way.
  loadPeers()
    .then(async (peers) => {
      if (typeof peers.piAi !== 'function') {
        ctx.logger?.warn?.(`minimax-connect: provider not registered — ${peers.errors.join('; ') || 'pi-ai unavailable'}`);
        return;
      }
      const built = await buildAdapter(
        resolved,
        roster,
        readPreferences,
        () => ctx.get('attachments'),
        (hostPath) => ctx.get('fs')?.processPathFromHostPath(hostPath),
      );
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
      if (!expiresWithin(credential, RENEW_MARGIN_MS)) return;
      if (renewalParked(credential)) return;
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
  const snapshot = async () => {
    const now = Date.now();
    if (cache.value !== null && now - cache.at < resolved.cacheMs) return cache.value;
    const value = await collectSnapshot(resolved);
    cache = { at: now, value };
    return value;
  };
  const invalidate = () => { cache = { at: 0, value: null }; };

  // ---- routes
  ctx.inject(['webServer'], (webCtx) => {
    const guard = (method) => (request, response) => {
      if (request.method !== method) { send(response, 405, { error: `${method} only` }, 'application/json'); return false; }
      if (!isLoopback(request.socket?.remoteAddress)) { send(response, 403, { error: 'loopback only' }, 'application/json'); return false; }
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
          const fresh = String(request.url ?? '').includes('refresh=1')
            ? parseModels(resolved.configFile)
            : roster;
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

  // ---- settings presentation
  //
  // 0.2.0-era hosts had `settings.installSection(...)`; the 0.2.1 service does
  // not (it answers `undefined`), which only produced a warning and left the
  // auto-generated form visible next to the hand-written card. The 0.2.x API is
  // `settings.configure(presentation)`: `auto: false` says this plugin serves
  // its own page, while the namespace the card writes through is the Loader
  // entry's own row (`describe()` already serves `llm-minimax`).
  ctx.inject(['settings'], (settingsCtx) => {
    const settings = settingsCtx.settings;
    if (settings === undefined || typeof settings.configure !== 'function') return;
    ctx.effect(
      () => settings.configure({ auto: false }, ctx.fiber),
      'minimax-connect: settings presentation policy',
    );
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
