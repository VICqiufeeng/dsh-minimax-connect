# dsh-minimax-connect

Use the **MiniMax Code (Mavis)** subscription already signed in on this machine as a model provider in [DeepSeek Harness](https://github.com/deepseek-ai), with a dedicated Settings page for **points balance / daily check-in / model roster / usage**.

Points-based account: no API key, it spends the MiniMax Code subscription's credits.

> **MiniMax Code does not need to be running.** The plugin performs the OAuth renewal itself; the desktop client can stay closed.
> See [Credential self-renewal](#credential-self-renewal).

中文说明见 [README.md](README.md)。

---

## Compatibility

One implementation, no version switches. The code only leans on what every version in the range shares, so a new release needs no change and an old one needs no change either.

| DSH | Status |
|---|---|
| `@deepseek-ai/dsh` 0.2.1-rc.5 (current `latest`) | ✅ written against this |
| `@deepseek-ai/dsh` 0.2.1-rc.4 | ✅ contract verified |
| `@deepseek-ai/dsh` 0.2.1-rc.3 | ✅ contract verified |
| `@deepseek-ai/dsh` 0.2.1-rc.2 (floor) | ✅ contract verified |

Backwards compatible to `0.2.1-rc.2`. The `lib/` trees of `dsh-llm`, `dsh-settings`, `dsh-client-ui-slots` and `dsh-llm-pi-ai` are **byte-identical** from rc.2 through rc.5, and the `llm-pi-ai` export list matches exactly — there is no API drift inside this line, which is why compatibility needs no branches.

`0.2.2-alpha.2` is a different line (`0.2.2-*`) and is not part of the claim. It currently passes as well, but nothing here guarantees it: maintaining compatibility for a version nobody runs means carrying alpha-only branches for a requirement that does not exist.

The 0.1 line (`0.1.0`) only ran on `0.2.0-rc.*` and leaned on a `settings.installSection` call that never actually took effect — that method does not exist anywhere on the 0.2.1 line. Version 0.2.0 is rewritten against the measured contract of the 0.2.1 line; see [0.2 migration](#02-migration-what-changed).

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
| Membership | `POST {matrix}/commerce/get_membership_info`, body `{}` | Plan name, subscription type, credit balance, renewal, upgrade action |
| Workspace | `POST {matrix}/user/get_user_extra_info`, body `{}` | Personal workspace name, member count, OpenPlatform account group id |

where:

```
{llm}   = https://agent.minimax.cn/mavis/api/v1/llm
{cloud} = https://agent.minimax.cn/minimax-cloud/api/v1
{matrix} = https://agent.minimax.cn/matrix/api/v1
```

**The bases differ on purpose**: the Anthropic SDK appends `/v1/messages` to its `baseURL`, so `{llm}` carries **no** trailing `/v1`; the cloud and matrix routes **do** carry `/v1`. `{matrix}` is derived from `{cloud}` (swap `/minimax-cloud` for `/matrix`), or set `Config.matrixBaseUrl` directly.

## Authentication

Read `~/.minimax/auth/prod/cn/mcode-public/auth.json`, take `records[*].accessToken` (starts with `mmoat_`), and send it as **`Authorization: Bearer`**.

> ⚠️ **Anthropic's `x-api-key` does not work**: measured `401 {"code":401,"message":"token is required"}`.

The record key is `` `${service}\0${account}` `` with a **real NUL** separator, and `account` = `base64url(sha256(authHome + "\0" + "mcode-public"))`.

## Credential self-renewal

The access token lives **one hour**. MiniMax Code renews it roughly hourly and writes the same file back — nothing outside it does, so with the desktop client closed the plugin dies the moment the token expires: measured, the first request afterwards answers `401 invalid access token`, while a perfectly usable `refreshToken` sits unread in the record.

The plugin runs the same grant itself:

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

- **Renews five minutes early**, so no stream opens on a token that is dying. Besides the on-demand path there is a 60-second sweep.
- **`refresh_token` is single-use and rotates on every grant**, so the old value is dead the instant the response lands and the new pair must reach disk before the new access token is used. The write is an **atomic replace** (temp file + rename), so the desktop client never reads a half-written record.
- **Coexists with the official client.** The client serialises its own renewal with a file lock (`proper-lockfile`, `auth.lock` → `auth.lock.lock` directory, `stale: 30_000`). The same on-disk convention is reused here: `mkdir` to claim, locks older than 30 seconds reclaimed as stale, and the file is re-read before writing so a **newer generation is adopted rather than overwritten**. Both sides renew in turn without evicting each other; verified in both directions.
- **Both files must advance together.** The client's `MCodeOAuthCore.readUsableCredential` requires `credential.generation === state.generation` and treats a mismatch as signed out. The next generation is `max(state.generation, credential.generation) + 1` — using the credential's counter alone can write back a value **below** `auth-state.json` and lock the account out of its own new token.
- **Failures do not throw**: they return `{ ok: false, reason, fatal? }` and the caller keeps using the token already on disk. `fatal` marks exactly one permanent failure — `invalid_grant` (the refresh token itself is gone), which only a fresh sign-in in MiniMax Code can recover from.

The card reports the state directly: *self-renewal enabled (5 minutes before expiry), MiniMax Code can stay closed* / *renewing…* / *renewal paused, retrying at HH:MM:SS* / *the credential has no refreshToken, sign in once in MiniMax Code*.

### End-to-end verification

`test/renew-e2e.mjs` only moves `expiresAtMs` to "about to expire" (**neither token is touched**, so a failed grant costs nothing), then calls the plugin's own `renewCredential` and finally hits the real model endpoint with the new token:

```bash
node test/renew-e2e.mjs ~/.minimax/auth/prod/cn/mcode-public/auth.json
```

Verified with **zero MiniMax Code processes running**: grant 273 ms, generation +1, both files on the same generation, `loginEpoch` preserved, `refreshToken` rotated, and the new token answered **HTTP 200** `{"text":"ok","base_resp":{"status_code":0}}` from `/v1/messages`.

### Static self-checks

Four checks run without installing into DSH:

```bash
npm run smoke        # client: which four slots, id vs key, which namespace
npm run smoke:slots  # same, but fed into the real 0.2.1-rc.2 SlotCore to self-validate
npm run matrix       # rc.5 down to rc.2, column by column: slots / settings / llm / adapter
npm run render       # render the card from a live /status payload and print what it shows
```

`smoke` evaluates the `lib/client.js` envelope in a VM and needs no peer packages. `smoke:slots` and `matrix` want the unpacked official packages under `.apicheck/` (a scratch directory from the upgrade work, not in the repo) and print SKIP without them. The host-side `test/smoke-host.mjs` imports peers bare, so it only runs inside an installed copy.

`render` also evaluates `lib/client.js` in a VM, but gives it a React stand-in with enough state machine to survive the card's own `useEffect` fetch, then renders it from the **running DSH's `/status` payload** and prints the subscription block line by line. It defaults to `http://127.0.0.1:61878/plugins/dsh-minimax-connect/status`; pass a different port as an argument:

```bash
node test/render-card.mjs http://127.0.0.1:61878/plugins/dsh-minimax-connect/status
```

`matrix` does not assert its verdict — for each version it loads *that version's own* `SlotCore` and feeds it the plugin's real registrations, while the settings/llm/adapter columns are read out of that version's own class bodies. It then runs a negative control: the 0.1.0 mistake (a keyed slot addressed by `id`) must be rejected. If it is not, the whole slots column is measuring nothing and the script reports HARNESS BROKEN.

## Install

```bash
dsh plugin --profile desktop add "github:VICqiufeeng/dsh-minimax-connect"
```

1. Installed under the profile's `node_modules`; `dsh.profile.bundles` gains the entry automatically.
2. **Restart DSH** to take effect.
3. The plugin writes nothing to the user patch layer (it does not touch `cordis.patch.yml`); uninstalling means removing it from `dependencies` and `dsh.profile.bundles`, leaving nothing behind.

If pnpm's supply-chain gate reports `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION` (rarely triggered for git dependencies), add `--config.minimumReleaseAge=0`.

## Interface

**Settings → MiniMax** (the `settings.section` slot, order 460), three blocks:

- **Points + check-in + account** — general credit balance, the seven-day check-in panel, account details and renewal state.
- **Subscription quota** — plan name, subscription type, usage multiplier, credit balance (total / subscription / free), pending credit, daily login gift, expiry, auto-renewal, upgrade action, workspace, plus *auto-renewed N times* and the models this account can actually use.
- **Model roster** — per-model enable switch / image input / context window (512K or 1M), plus the thinking mode and file-upload capability the catalogue declares.
- **Save row** — persists to the plugin's own settings namespace, `llm-minimax`.

The same card also appears in three more places: the plugin manager's bundle page and row page (`plugins.bundle.config` / `plugins.row.config`), and this provider's card seat under **Settings → Models** (`settings.models.provider-card`).

There is also a self-contained zero-build HTML panel: `GET /plugins/dsh-minimax-connect/panel`.

## Routes (loopback only)

| Route | Purpose |
|---|---|
| `GET /plugins/dsh-minimax-connect/status` | Aggregate snapshot for the panel, including `selfRenewal` |
| `GET /plugins/dsh-minimax-connect/usage` | Raw credit-details response |
| `GET /plugins/dsh-minimax-connect/signin` | Raw seven-day check-in panel response |
| `POST /plugins/dsh-minimax-connect/signin/claim` | Perform the check-in |
| `GET /plugins/dsh-minimax-connect/models` | Current roster (`?refresh=1` re-reads disk) |
| `POST /plugins/dsh-minimax-connect/__save` | Write back enabled models / image switch / context window |
| `GET /plugins/dsh-minimax-connect/panel` | Self-contained HTML panel (no build step) |

Saving has two paths: the card prefers the host's `configForms` (revision-checked, conflict-recovering) and falls back to `__save` when the host does not serve that namespace. Both write the same volatile configuration, and `__save` returns the value it read back — a write that did not land is reported instead of assumed.

## Configuration

Fields `Config` (schemastery) accepts:

| Field | Default |
|---|---|
| `baseUrl` | `https://agent.minimax.cn/mavis/api/v1/llm` |
| `cloudBaseUrl` | `https://agent.minimax.cn/minimax-cloud/api/v1` |
| `authFile` | `~/.minimax/auth/prod/cn/mcode-public/auth.json` |
| `configFile` | `~/.minimax/config.yaml` |
| `cacheMs` | `15000` |
| `enabledModelIds` / `imageOverrides` / `useMaximumContextWindow` | Written by the settings page (all volatile) |
| each `*Route` | See the table above |

The three writable fields are **volatile**: the host's settings service only serves entries that have volatile fields and only accepts writes to them — a non-volatile field answers `Config field "X" is not volatile`.

## Models

The roster comes from the local `~/.minimax/config.yaml`, parsed from the model entries themselves (`limit` / `modalities` / `thinking_config` / `capabilities` / `contextWindowOptions`), not from `whitelist` or `model_order`. Measured on this machine:

| Model | Context | Image | Thinking | File upload |
|---|---|---|---|---|
| `MiniMax-M3` | 512K / 1M | ✅ | switchable | ✅ |
| `MiniMax-M3.1-Flash` | 512K / 1M | ✅ | forced on | ✅ |

The catalogue's `modalities.input` also declares `video`. The card reports that but does **not** offer it: this provider speaks the Anthropic Messages protocol, whose payload carries text and image content blocks only, so listing it as selectable would promise something the transport cannot send.

When `config.yaml` cannot be read, a built-in roster is used and the `/models` `source` field says whether the data came from disk or the fallback.

## Subscription quota and usage multiplier

The plan facts have exactly one real source: `POST {matrix}/commerce/get_membership_info`. Measured on this machine (a free account):

```json
{
  "plan_type": 1,
  "plan_name": "",
  "subscription_type": "none",
  "has_token_plan": false,
  "will_renewal": false,
  "expires_at": 0,
  "total_remains_credit": 0,
  "pending_credit": 0,
  "daily_login_gift_credit_remaining": 0,
  "is_migrated_to_op": true,
  "op_group_id": "2039158281435353669",
  "op_credit_summary": {
    "total_remaining_amount": "820.984",
    "purchased_remaining_amount": "0",
    "free_remaining_amount": "820.984"
  },
  "upgrade_action": "Month",
  "base_resp": { "status_code": 0, "status_msg": "success" }
}
```

The card shows: plan name / subscription type / usage multiplier / credit balance (total, subscription part, free part) / pending credit / daily login gift / expiry / auto-renewal / renewal period / upgradeable / workspace. Fields the API does not return read **"接口未返回"** — never blank, never a fabricated 0.

On the **usage multiplier**: the client package ships no plan catalogue. Go / Explore / Build and their 3× / 12× multipliers are static marketing copy that the server never publishes. So the plugin does not hard-code a marketing table; it scans the response (three levels deep) for numeric `*multiplier*` / `*multiple*` / `*times*` fields, prints what it finds, and prints "接口未返回" when the API has nothing.

**Included models** are answered with the roster this account can actually use — the models parsed from the local `config.yaml` (`MiniMax-M3` and `MiniMax-M3.1-Flash` here) — not with the marketing model list.

OpenPlatform's `/backend/account/token_plan/subscriptions` answers 404 / `401 not login` when called with the agent token (measured), so subscription facts stay on the matrix channel.

Long stretches without signing in are handled by credential self-renewal, not by this card: **auto-renewed N times** comes from `auth-state.json`'s `generation` — 195 renewals on this machine, never a manual re-login.

## Known limitations

- **Credits are not converted to cost**: every model descriptor carries `cost` 0. There is no published per-token price under a points model, and 0 beats an invented number.
- **A missing multiplier reads "接口未返回"**: the plan catalogue (Go / Explore / Build and their multipliers) is static marketing copy with no server-side endpoint; the plugin will not pass off an invented table as API data.
- **Depends on non-public client interfaces**: endpoints may move when MiniMax ships an update; they are collected in the header comment of `lib/index.js` for easy diffing.
- **Image input** goes through the host's durable attachment service. On the 0.2 line `resolveImageAccess` turns an attachment reference into a readable path; without that service the request answers `UNSUPPORTED_CONTENT`.
- Tested on **Windows + the China (cn) region only**. The region path and `buildEnv` are hard-coded in `defaultAuthFile()`; other regions need that one place changed.

## 0.2 migration: what changed

`0.1.0` contained several assumptions that do not hold anywhere on the 0.2.1 line. Item by item:

| 0.1.0 | 0.2.0 | Why |
|---|---|---|
| `settings.installSection(ctx, ns, schema, config, hooks)` | `settings.configure({ auto: false }, ctx.fiber)` | No version on the 0.2.1 line has `installSection`; the namespace is published by the Loader from the row id, and `configure` only turns off the auto-generated form so the same fields do not appear twice |
| `settingsNamespaceOf` fell back to `'dsh-minimax-connect'` | falls back to `'llm-minimax'` | The settings service addresses entries by `entry.options.id` — the patch's row id, not the package name |
| The client used `'settings.minimax-connect'` as both locale id and settings namespace | split into `SETTINGS_NS='llm-minimax'` and `COPY_NS='settings.minimax-connect'` | The former is the settings namespace, the latter only this card's dictionary id; conflating them aims writes at a namespace nothing serves |
| `plugins.bundle.config` / `plugins.row.config` passed `id` | pass `key` | Both slots are keyed on the 0.2 line; omitting `key` throws `keyed slot "..." requires options.key` |
| Registered `settings.plugin.item` | removed | That slot does not exist on the 0.2 line (absent from all four slot tables), so registering it always throws |
| — | added `settings.models.provider-card` (key = `llm-minimax`) | The 0.2 seat for a provider's own card, dispatched by the provider's settingsNs |
| Called `ctx.slots.register` directly with a plugin-chosen `priority` | wrapped in `ctx.effect`, `priority` left to the runtime | Non-chain slots get their priority from the runtime, which overwrites whatever the plugin passed; `ctx.effect` guarantees unregistration on fiber unload |
| `adaptAttachmentStore` bridged `{maxPixels,maxBytes}` / `{width,height,maxBytes}` | removed, replaced by `resolveImageAccess` | The 0.2 adapter no longer calls `readImageRequest`; it calls `imageHostPath` plus a host mapping function |
| The profile omitted the three image budgets | sets `maxRequestImageBytes` / `requestImagePixelBudget` / `requestImageMaxBytes` explicitly | A hand-built profile bypasses `resolveProfiles`' defaults, so `toPiContext` would receive `undefined` |
| `parseModels` read only `name` / `limit` / `- image` | also reads `modalities` / `thinking_config` / `capabilities` / `contextWindowOptionHints` | MiniMax changed the config format; the old parser cannot see the new fields |
| `FALLBACK_MODELS` contained `MiniMax-M3.1-Flash-Preview` | now `MiniMax-M3.1-Flash` | The catalogue renamed it |
| `peerDependencies` said `@earendil-works/pi-ai >=0.85.0 <1.0.0` | `>=1.1.0 <2.0.0` | The 0.2 line's `llm-pi-ai` depends on `^1.1.0` / `^1.3.0` |
| `esc()` escaped `& < > "` | also `'` | The panel has single-quoted attribute values |

Two smaller fixes came along: `checkinRoute` and `debugPort` were dead configuration (declared, never registered or used) and are gone; `kfmt` showed `999.999K` at the 1e6 boundary and now picks the unit by magnitude and keeps one decimal.

## Design notes

Every "why is it written this way" spot in the code carries a comment. A few worth reading:

- The `credential renewal` header: why the plugin has to take renewal over at all.
- `mirrorAuthState` / `nextGeneration`: why the two file generations must agree, and the off-by-one that locks the account out of itself.
- `withAuthLock`: why the on-disk `proper-lockfile` convention is replicated instead of depended on.
- `profiles()`: why it must return a stable reference (`PiAiAdapter.current()` memoises on identity).
- The `headers` getter in `buildProfile`: why the token is read per stream rather than snapshotted at registration.

## License

MIT
