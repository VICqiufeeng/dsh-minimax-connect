# dsh-minimax-connect

Use the **MiniMax Code (Mavis)** subscription already signed in on this machine as a model provider in [DeepSeek Harness](https://github.com/deepseek-ai), with a dedicated Settings page for **points balance / daily check-in / model roster / usage**.

Points-based account: no API key, it spends the MiniMax Code subscription's credits.

> **MiniMax Code does not need to be running.** The plugin performs the OAuth renewal itself; the desktop client can stay closed.
> See [Credential self-renewal](#credential-self-renewal).

中文说明见 [README.md](README.md)。

---

## This fork: DSH 0.2.1-rc.2

Upstream 0.1.0 targets the 0.2.0 line. On `DSH Desktop Beta 2.0.18-beta.1 / kernel 0.2.1-rc.2` three things broke; this fork fixes them and ships regression tests:

| Symptom | Cause | Fix |
|---|---|---|
| `Image request width must be a positive integer.` | A 0.2.x adapter derives each image target from `profile.requestImagePixelBudget` / `requestImageMaxBytes`; unset → `target.width === undefined` | Declare `IMAGE_BUDGET` and wire the 0.2.x `resolveImageAccess` hook (`resolveImageAttachmentAccess(attachments, mapHostPath, ref)`) |
| Thinking levels do not match the wanted ladder | No `thinkingLevelMap` on the model descriptor, so pi-ai uses its default ladder | Declare `xhigh` / `max` explicitly (every other level pinned to `null`) with `compat.forceAdaptiveThinking`; `off` must stay `null` because the gateway rejects `thinking.type="disabled"` |
| `host settings service has no installSection API` | 0.2.1 has no `installSection` | Use `settings.configure({ auto: false })`; the card keeps using its own `/plugins/...` routes |
| Occasional `401 {"error":"invalid access token"}` | The header getter renewed as a side effect, and the gateway invalidates the previous access token the moment a refresh rotates it — so the request that triggered the renewal sent the token it had just killed (measured: the failing turn opened 234 ms after the renewal answered) | The renewal moved into the adapter's awaited pre-flight hook, the getter became a pure read, and `withAuthRetry` renews and replays a turn the provider refused |
| `configurable provider "minimax" is already declared` | llm-pi-ai declares every catalog provider, `minimax` included | Route id is now **`minimax-code`**, so the Models page points at this plugin rather than the API-key route |

The picker group is **MiniMax Code**; the reasoning ladder is **xhigh / max** (default `max`). With no level selected the request carries no thinking block at all, which is the provider's own default — the same thing the first-party client's `default` does.

The dependency declaration is aligned with 0.2.1-rc.2 as well: every `@deepseek-ai/dsh-*` peer sits in the wide `>=0.2.0-rc.0 <0.3` range (deliberately **not** narrowed to `^0.2.1-rc.2`, so later 0.2.x kernels keep working), and `@earendil-works/pi-ai` moved from `>=0.85.0 <1.0.0` to `>=0.85.0 <2.0.0` — the 0.2.1-rc.2 kernel ships pi-ai 1.x itself (`dsh-llm-pi-ai@0.2.1-rc.2` requires `^1.1.0`). The 0.2.x adapter also declares `auth` (credential store + ambient auth context) as required, and the plugin now passes it explicitly; the runtime behaviour is unchanged.

```bash
node test/rc2-fixes.mjs    # ladder, image target, adapter wiring
node test/host-apply.mjs   # apply(): route id, configurable directory, settings policy, no warnings
node test/auth-retry.mjs    # 401 detection and the renew-and-replay path
node test/peer-ranges.mjs   # peer ranges: admit 0.2.1-rc.2, stay wide, admit the kernel's pi-ai
```

---

## Why no proxy is needed

MiniMax Code's inference endpoint **already speaks the Anthropic Messages protocol**, and DSH's `pi-ai` supports that protocol natively. Requests therefore go straight to the official endpoint — no intermediary process, no client hooking.

MiniMax says so itself in `~/.minimax/config.yaml`:

```yaml
provider:
  minimax:
    npm: '@ai-sdk/anthropic'
    options:
      baseURL: https://agent.minimax.cn/mavis/api/v1/llm/v1
```

## Measured contract (real responses, not guesses)

| Purpose | Method and path | Notes |
|---|---|---|
| Chat | `POST {llm}/v1/messages` | Anthropic Messages; streams `thinking_delta` + `text_delta` |
| Model roster | — | `GET {llm}/v1/models` answers **503 `direct_route_not_configured`**; the roster is parsed from the local `config.yaml` instead |
| Renewal | `POST https://account.minimax.cn/oauth2/token` | `grant_type=refresh_token`, see below |
| Credits | `GET {cloud}/credit/details` | `details[]` carries `granted_amount` / `remaining_amount` / `consumed_amount` |
| Check-in panel | `GET {cloud}/signin/status?timezone_id=Asia/Shanghai` | **`timezone_id` is required**; without it: `1406010011 invalid timezone_id` |
| Check-in | `POST {cloud}/signin/claim?timezone_id=Asia/Shanghai`, body `{}` | The empty body matches the first-party client; **`timezone_id` is required here too** |

where:

```
{llm}   = https://agent.minimax.cn/mavis/api/v1/llm
{cloud} = https://agent.minimax.cn/minimax-cloud/api/v1
```

**The two bases differ on purpose**: the Anthropic SDK appends `/v1/messages` itself, so `{llm}` has **no** trailing `/v1`, while the cloud routes **do** carry `/v1`.

## Authentication

Reads `~/.minimax/auth/prod/cn/mcode-public/auth.json`, takes `records[*].accessToken` (starts with `mmoat_`), and sends it as **`Authorization: Bearer`**.

> ⚠️ **Anthropic's `x-api-key` does not work here**: measured `401 {"code":401,"message":"token is required"}`.

Record keys are `` `${service}\0${account}` `` — the separator is a **literal NUL character** — where `account` = `base64url(sha256(authHome + "\0" + "mcode-public"))`.

## Credential self-renewal

The access token lives **one hour**. MiniMax Code renews it roughly hourly and writes the result back to the same file — and nothing else ever did. With the desktop app closed, the plugin went stale the moment the token expired: measured `401 invalid access token` on the first request after expiry, with a perfectly good `refreshToken` sitting unread in the record.

This plugin performs the same grant itself:

```
POST https://account.minimax.cn/oauth2/token
     grant_type=refresh_token
     refresh_token=<mmort_…>
     client_id=mcode-public
     scope=agent.default
     audience=agent-backend
  -> { access_token, refresh_token, token_type, expires_in, scope }
```

Behaviour:

- **Renews 5 minutes before expiry**, so no stream ever opens on a dying token. Besides on-demand triggering there is a 60-second sweep.
- **`refresh_token` is single-use and rotates on every grant**, so the old value dies the instant the call answers and the new pair must be on disk before the new access token is used. The write is an **atomic replace** (temp file + rename) so the desktop client never observes a half-written record.
- **Coexists with the first-party client.** The client serialises its own renewal with a file lock (`proper-lockfile`, `auth.lock` → an `auth.lock.lock` directory, `stale: 30_000`). The same on-disk convention is reused here: `mkdir` to claim, locks older than 30 seconds reclaimed as stale, and the file is re-read immediately before the write so a **newer generation is adopted rather than clobbered**. Both sides renew in turn without evicting each other; verified in both directions.
- **Both files must advance together.** The client's `MCodeOAuthCore.readUsableCredential` refuses the pair unless `credential.generation === state.generation`; a mismatch reads as "signed out". The new generation is `max(state.generation, credential.generation) + 1` — using only the credential's own counter can write a value **below** `auth-state.json` and lock the account out of its own fresh token.
- **Failures never throw**; they come back as `{ ok: false, reason, fatal? }` and the caller keeps serving the token already on disk. `fatal` marks one permanent answer only, `invalid_grant` (the refresh token itself is gone) — the single case that needs a fresh sign-in in MiniMax Code.

The settings card shows the current state: *self-renewal enabled (5 min before expiry), MiniMax Code not required* / *renewing…* / *renewal paused, retrying after HH:MM:SS* / *no refreshToken on the credential, sign in again in MiniMax Code*.

### End-to-end proof

`test/renew-e2e.mjs` moves only `expiresAtMs` into the renewal window (**neither token is touched**, so a grant that never happens costs nothing), calls the plugin's own shipped `renewCredential`, then hits the real model endpoint with the new token:

```bash
node test/renew-e2e.mjs ~/.minimax/auth/prod/cn/mcode-public/auth.json
```

Measured with **zero MiniMax Code processes running**: grant in 273 ms, generation +1, both files equal, `loginEpoch` preserved, `refreshToken` rotated, and the new token answers **HTTP 200** `{"text":"ok","base_resp":{"status_code":0}}` from `/v1/messages`.

## Install

```bash
dsh plugin --profile desktop add "github:VICqiufeeng/dsh-minimax-connect"
```

1. Installs under the profile's `node_modules`; `dsh.profile.bundles` gains the entry automatically.
2. **Restart DSH** to take effect.
3. The plugin writes no user patch layer (it never touches `cordis.patch.yml`), so uninstalling means removing it from `dependencies` and `dsh.profile.bundles` — nothing else is left behind.

If pnpm's supply-chain gate reports `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`, append `--config.minimumReleaseAge=0`.

## UI

**Settings → MiniMax** (the `settings.section` slot, order 460), in four blocks:

- **Points + check-in + account** — general points balance, the 7-day check-in panel, account info and renewal state.
- **Model roster** — per-model enable / image input / context window (200K or 1M).
- **Save row** — persisted to the plugin's own settings namespace `llm-minimax`.

The same card also appears in the **plugin manager page** (sidebar "Plugins" icon → installed → `dsh-minimax-connect`), because both `plugins.bundle.config` and `plugins.row.config` are registered.

A self-contained, build-free HTML panel is available at `GET /plugins/dsh-minimax-connect/panel`.

## Routes (loopback only)

| Route | Purpose |
|---|---|
| `GET /plugins/dsh-minimax-connect/status` | Aggregate snapshot (used by the card), includes `selfRenewal` |
| `GET /plugins/dsh-minimax-connect/usage` | Raw credit-details response |
| `GET /plugins/dsh-minimax-connect/checkin` | Check-in status |
| `GET /plugins/dsh-minimax-connect/signin` | Raw 7-day check-in panel response |
| `POST /plugins/dsh-minimax-connect/signin/claim` | Perform the claim |
| `GET /plugins/dsh-minimax-connect/models` | Current model roster |
| `POST /plugins/dsh-minimax-connect/__save` | Write back enabled models / image flags / context window |
| `GET /plugins/dsh-minimax-connect/panel` | Self-contained HTML panel (no build step) |

## Configuration

Overridable `Config` (schemastery) fields:

| Field | Default |
|---|---|
| `baseUrl` | `https://agent.minimax.cn/mavis/api/v1/llm` |
| `cloudBaseUrl` | `https://agent.minimax.cn/minimax-cloud/api/v1` |
| `authFile` | `~/.minimax/auth/prod/cn/mcode-public/auth.json` |
| `configFile` | `~/.minimax/config.yaml` |
| `cacheMs` | `15000` |
| `enabledModelIds` / `imageOverrides` / `useMaximumContextWindow` | written by the settings page |
| the `*Route` fields | see the table above |

## Models

The roster comes from `whitelist` + `model_order` in the local `~/.minimax/config.yaml`; four ship by default:

| Model | Context | Image | Reasoning |
|---|---|---|---|
| `MiniMax-M3` | 512K / 1M | ✅ | switchable |
| `MiniMax-M3.1-Flash-Preview` | 512K / 1M | ✅ | forced on |
| `MiniMax-M2.7` | 200K | ❌ | forced on |
| `MiniMax-M2.7-highspeed` | 200K | ❌ | forced on |

## Known limitations

- **Points are not converted to cost**: every model descriptor's `cost` is 0. There is no published per-token price under a points scheme; 0 beats an invented number.
- **Depends on non-public client interfaces**: MiniMax may move these endpoints. All of them are listed in the comment block at the top of `lib/index.js` for easy comparison.
- **Image input** goes through the host's durable attachment service. Older hosts that do not provide it answer `UNSUPPORTED_CONTENT`; the plugin adapts to both store shapes.
- Only tested on **Windows with the CN build**. The region and `buildEnv` are hardcoded in `defaultAuthFile()`; other regions need that one function changed.

## Design notes

Every "why is it written this way" spot carries a comment. A few worth reading:

- The `credential renewal` section header: why the plugin had to take over renewal at all.
- `mirrorAuthState` / `nextGeneration`: why the two files' generations must agree, and the off-by-one that locks you out of your own token.
- `withAuthLock`: why `proper-lockfile`'s on-disk convention is reproduced instead of depending on the package.
- `adaptAttachmentStore`: the two shapes of the host attachment store.

## License

MIT
