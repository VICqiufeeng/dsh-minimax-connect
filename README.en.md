# dsh-minimax-connect

Use the **MiniMax Code (Mavis)** subscription already signed in on this machine as a model provider in [DeepSeek Harness](https://github.com/deepseek-ai), with a card in Settings for **points balance / daily check-in / subscription quota / model roster**.

Points-based account: no API key, it spends the subscription's credits. The inference endpoint already speaks the Anthropic Messages protocol, so requests go straight to the official endpoint — no proxy process, no client hooking.

> **MiniMax Code does not need to be running.** The plugin performs the OAuth renewal itself.

中文说明见 [README.md](README.md)。

## Compatibility

One implementation, no version switches. Backwards compatible to `@deepseek-ai/dsh` **0.2.1-rc.2**, verified through **0.2.1-rc.5** (current `latest`). Inside this line the `lib/` trees of `dsh-llm` / `dsh-settings` / `dsh-client-ui-slots` / `dsh-llm-pi-ai` are byte-identical, which is why compatibility needs no branches.

`0.2.2-alpha.*` is a different line and is not part of the claim (it currently runs too, but nothing guarantees it).

## Install

```bash
dsh plugin --profile desktop add "github:VICqiufeeng/dsh-minimax-connect"
```

**Restart DSH** afterwards. The plugin does not touch the user patch layer (`cordis.patch.yml`); uninstalling means removing it from `dependencies` and `dsh.profile.bundles`.

## Interface

**Settings → MiniMax**, four blocks:

- **Points + check-in + account** — points balance, 7-day check-in, renewal state.
- **Subscription quota** — plan, subscription type, multiplier, quota balance (total / subscription / free), pending credit, daily login gift, expiry, auto-renewal, upgrade action, workspace, plus "auto-renewed N times".
- **Model roster** — per-model toggle / image input / context window (512K or 1M), with thinking-effort ladder, per-turn attachment cap and reasoning-summary policy under each model; the header line carries the desktop client's own default model / default effort / default context.
- **Save row** — writes to the plugin's own settings namespace `llm-minimax`.

The same card also appears on the plugin-manager pages (bundle and row) and in **Settings → Models** at this provider's card slot. A zero-build HTML panel is available at `GET /plugins/dsh-minimax-connect/panel`.

## Auth and renewal

Reads `records[*].accessToken` (prefix `mmoat_`) from `~/.minimax/auth/prod/cn/mcode-public/auth.json` and sends it as `Authorization: Bearer`. **`x-api-key` does not work** (measured: 401).

The access token lives 1 hour. With the desktop client closed nothing else renews it, so the plugin performs the same grant itself:

- Renews **5 minutes** early, plus a 60-second sweep.
- `refresh_token` rotates on every grant; the new pair is written **atomically** (temp file + rename) so the client never reads a half-written record.
- Reuses the client's on-disk lock convention (`mkdir` claim, 30-second stale reclaim) and re-reads the record before writing, **adopting a newer `generation` instead of clobbering it** — both sides renew in turn without locking each other out.
- Failures never throw: they return `{ ok: false, reason, fatal? }` and the caller keeps using the token on disk. `fatal` marks exactly one permanent failure: `invalid_grant`.

`test/renew-e2e.mjs` only moves `expiresAtMs` into the near-expiry window (**neither token is touched**, so a failed grant costs nothing). Measured with **zero MiniMax Code processes** running: grant 273 ms, generation +1, new token answers `/v1/messages` with 200.

## Measured contract (real responses, not guesses)

| Purpose | Method and path | Notes |
|---|---|---|
| Chat | `POST {llm}/v1/messages` | Anthropic Messages; streams `thinking_delta` + `text_delta` |
| Model roster | `GET {llm}/v1/models` | answers **503 `direct_route_not_configured`** → parsed from the local `config.yaml` instead |
| Renewal | `POST https://account.minimax.cn/oauth2/token` | `grant_type=refresh_token` |
| Points | `GET {cloud}/credit/details` | `details[]` with granted / remaining / consumed |
| Check-in | `GET`/`POST {cloud}/signin/{status,claim}?timezone_id=Asia/Shanghai` | **missing `timezone_id` answers `1406010011`** |
| Subscription | `POST {matrix}/commerce/get_membership_info` | body `{}` |
| Workspace | `POST {matrix}/user/get_user_extra_info` | body `{}` |

Thinking-effort dialect (same endpoint, measured with this machine's credential):

| Model | `thinking.type=disabled` | `output_config.effort` |
|---|---|---|
| `MiniMax-M3.1-Flash` | **400** `requires adaptive thinking` | `default/low/medium/high/xhigh/max` all 200 |
| `MiniMax-M3` | 200 (can be turned off) | `default` **400** `invalid reasoning_effort`; the rest 200 |

So M3.1-Flash's `off` level must be declared `null` (removing it from the selectable ladder); sending `disabled` to turn thinking off is not an option.

```
{llm}    = https://agent.minimax.cn/mavis/api/v1/llm   ← no trailing /v1, the SDK appends it
{cloud}  = https://agent.minimax.cn/minimax-cloud/api/v1
{matrix} = https://agent.minimax.cn/matrix/api/v1
```

## Configuration

| Field | Default |
|---|---|
| `baseUrl` | `https://agent.minimax.cn/mavis/api/v1/llm` |
| `cloudBaseUrl` | `https://agent.minimax.cn/minimax-cloud/api/v1` |
| `matrixBaseUrl` | derived from `cloudBaseUrl` (`/minimax-cloud` → `/matrix`) |
| `authFile` | `~/.minimax/auth/prod/cn/mcode-public/auth.json` |
| `configFile` | `~/.minimax/config.yaml` |
| `cacheMs` | `15000` |

`enabledModelIds` / `imageOverrides` / `useMaximumContextWindow` are written by the Settings page and must be **volatile**, otherwise the settings service refuses the write (`Config field "X" is not volatile`).

## Models

The roster comes from the local `config.yaml`, parsed from the model entries themselves (`limit` / `modalities` / `thinking_config` / `capabilities` / `contextWindowOptions` / `thinking.effortOptions`) — `whitelist` and `model_order` do not decide what exists. Measured on this machine:

| Model | Context | Image | Thinking | Effort ladder | Attachments |
|---|---|---|---|---|---|
| `MiniMax-M3` | 512K / 1M | ✅ | toggleable | — | 9 |
| `MiniMax-M3.1-Flash` | 512K / 1M | ✅ | forced on | default/low/medium/high/xhigh/max | 4 |

**How the effort ladder reaches the host**: a pi-ai model descriptor has exactly one hook for it, `thinkingLevelMap`, so the plugin generates that map (`minimal`→`low`, the rest same-named, `off`→`null`) and sets `compat.forceAdaptiveThinking = true` so requests take the `thinking:{type:'adaptive'}` + `output_config.effort` path. Models with no ladder emit no `thinkingLevelMap` and fall back to pi-ai's native budget branch.

The catalogue also declares `video`; the card shows that but does **not** offer it as a toggle — the payload carries only text and image content blocks (pi-ai's `Model.input` has only those two kinds), and listing it as selectable would promise a capability the transport cannot deliver. When `config.yaml` is unreadable the built-in roster is used, and `/models` reports which source it came from.

## Subscription quota

The only real source is `POST {matrix}/commerce/get_membership_info`. The card shows plan / subscription type / multiplier / quota balance / pending credit / daily login gift / expiry / auto-renewal / renewal cycle / upgrade action / workspace; **fields the API does not return print "not returned by the API" rather than being left blank or filled with 0**.

**Multiplier**: the client bundle ships no plan-catalogue endpoint, so the Go / Explore / Build tiers and their 3× / 12× on the marketing page are static copy the server does not publish. Rather than hard-coding a marketing table, the plugin searches the response recursively (max three levels) for numeric `*multiplier*` / `*multiple*` / `*times*` fields: found means shown, absent means "not returned by the API".

**Included models** are answered with what this account can actually use — the parsed local `config.yaml` roster, not the plan's marketing model table. OpenPlatform's `/backend/account/token_plan/subscriptions` answers 404 / `401 not login` with an agent token (measured), so quota goes through the matrix channel only.

"Stays signed in" is not this card's doing — it comes from the renewal mechanism. The card's **auto-renewed N times** is read from `generation` in `auth-state.json`.

## Routes (all loopback only)

Prefix is `/plugins/dsh-minimax-connect`.

| Route | Purpose |
|---|---|
| `GET /status` | aggregated snapshot, including `selfRenewal` and `membership` |
| `GET /usage`, `GET /signin` | raw points-detail / check-in responses |
| `POST /signin/claim` | perform check-in |
| `GET /models` | current roster (`?refresh=1` re-reads disk), including `desktop` defaults and per-model `efforts` / `maxAttachments` |
| `POST /__save` | write back enabled models / image toggles / context window |
| `GET /panel` | self-contained HTML panel (no build step) |

Saving prefers the host's `configForms` (revision-aware, auto-recovers from conflicts) and falls back to `__save` when the host does not expose that namespace; both write the same config, and a write that did not land reports an error instead of pretending success.

## Known limitations

- **Points are not converted to cost**: there is no published per-token price, so the model descriptors carry `cost` 0.
- **Multiplier prints "not returned by the API" when absent**: the server has no plan-catalogue endpoint.
- **Video input is displayed, not offered**: the catalogue declares it, the transport has no content-block kind for it.
- **Attachment caps are displayed, not enforced**: `max_attachments_count` comes from the client's catalogue; the host validates attachments on its own side.
- **Relies on non-public client endpoints**: MiniMax may change them; the endpoints are collected in a comment at the top of `lib/index.js` for comparison.
- **Image input** goes through the host's durable attachment service (`resolveImageAccess` on the 0.2 line); without it the adapter answers `UNSUPPORTED_CONTENT`.
- Only **Windows + the China (cn) region** was tested; the region path and `buildEnv` are hard-coded in `defaultAuthFile()`.

## Checks

```bash
npm run smoke        # slot / namespace contract
npm run smoke:slots  # feed the registration into a real SlotCore
npm run matrix       # rc.5 down to rc.2, one by one
npm run render       # render the card text from a live /status payload
npm run render:models # render the roster from the real config.yaml, then check the pi-ai descriptors
```

`matrix` loads **each version's own** `SlotCore`, feeds the plugin's real registration into it, and runs a negative control — the 0.1.0 style of passing `id` to a keyed slot must be rejected; if the control is not rejected the whole column is testing air, and the script reports HARNESS BROKEN.

The host binds a different loopback port on every launch, so `render` scans LISTENING loopback ports itself and probes `/status` on each, keeping the one that answers with `signedIn` plus `models` (other listeners on the box reply 401). Pass a URL as the first argument to point it somewhere explicit.

Host-side checks have to run inside an **installed profile copy**: a bare checkout has no peer dependencies and the `import` dies with `ERR_MODULE_NOT_FOUND`.

## License

MIT
