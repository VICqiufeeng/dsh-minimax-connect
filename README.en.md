# MiniMax Code for DSH 0.2.1-rc.2

[中文](README.md)

Compatibility build `0.1.0-dsh021rc2.3`, based on upstream commit `8c927d79d1ac09b384b48fd350783ec8cdb9e01e`. Original author: VICqiufeeng. MIT licensed; see LICENSE.

The plugin reuses the domestic MiniMax Code account signed in on the machine running DSH. It provides an Anthropic Messages model adapter, a points/check-in panel and model preferences. No separate proxy process is required.

## Compatibility and installation

This build targets **DSH 0.2.1-rc.2 only**, on Node `^22.19.0 || >=24.0.0`. It uses the host's pi-ai 1.x and updated host/client interfaces. It does not support DSH 0.2.0-rc.2.

Sign in to domestic MiniMax Code on the host first. The default credential is `~/.minimax/auth/prod/cn/mcode-public/auth.json`; no credentials are included in this repository or its package.

Using the upgraded host CLI and the actual service's DSH_HOME:

```sh
dsh plugin --profile web add /absolute/path/dsh-minimax-connect-0.1.0-dsh021rc2.3.tgz
```

The CLI adds the dependency only. On first installation, append `"dsh-minimax-connect"` to `dsh.profile.bundles` in that profile's package.json, keeping its other entries. Restart DSH and refresh the browser. Existing enabled installations do not need another bundle entry.

A standalone profile should use `nodeLinker: hoisted` and `autoInstallPeers: false` in pnpm-workspace.yaml so the plugin reuses its host's peer packages. Preserve an existing profile's configuration. Client-only packages are provided by the browser host. Compatibility of other installed plugins requires separate verification.

## Behavior and safeguards

- Reads only `provider.minimax.models` from MiniMax Code's `~/.minimax/config.yaml`, excluding custom providers. When the file is unavailable or cannot be parsed, the UI labels the bundled four-model fallback. This is not a server-side account model discovery API.
- The settings card, status response and real adapter share one model catalog. Refresh updates it and notifies the picker. Maximum context derives from the declared base window and explicit expansion options.
- Credentials are resolved at request time. The SDK cannot overwrite MiniMax credentials or fall back to an unrelated provider's environment key.
- Every plugin HTTP route requires the DSH Connection service's authenticated **owner**, including its Host/Origin checks, as well as the existing loopback restriction. A missing Connection service denies access; loopback alone does not authenticate a request.
- OAuth uses the MiniMax-compatible `auth.lock.lock` directory protocol through proper-lockfile 4.1.2, with a 30-second stale lease and 5-second heartbeat. Lock waits are bounded to approximately 20 seconds. The 15-second renewal deadline covers both headers and response-body reading.
- Lost ownership aborts pending work and prevents the former holder from writing credentials, releasing a replacement lock or updating its heartbeat. Temporary credential files are created exclusively with private permissions and cleaned up on failure.
- Renewal and backoff are scoped to the real credential file, including symbolic aliases. If the credential rotates but companion-state persistence fails, the new token is retained and the failure is reported. Subsequent recovery repairs the companion under the lock without spending another refresh token. Explicit sign-out and a newer companion state do not revive an older credential.
- OAuth failure diagnostics and malformed-file errors do not echo raw response or credential contents.
- Unloading during asynchronous initialization cannot leave a provider or picker directory registered afterward.

## Validation

On 2026-10-18, **32/32 tests passed** against the actual DSH 0.2.1-rc.2 host SDK, Node 24.18.1, Cordis 4.0.5, Schemastery 3.18.5 and pi-ai 1.3.0. Run `npm test` from the installed plugin directory with that host available. Tests use temporary fake credentials, local SSE servers and mocked OAuth; the old manual script that changed real account expiry has been removed.

Coverage includes real-adapter text/tool streaming, usage, credential isolation, model refresh and context limits, unload races, file permissions and failed writes, cross-process heartbeat, stale/replaced locks, body/header timeouts, independent accounts, interrupted companion writes, sign-out, symlinks, sanitized diagnostics and all route guards. Windows separately checks atomic creation/replacement, lock ownership/release and failed-write cleanup; Unix mode assertions run on Linux, while Windows access is governed by ACLs.

The isolated Web checks use a local fake upstream and account to exercise model refresh, status and owner authentication. The earlier `.1` iteration also completed a real MiniMax M3 Web chat, model enable/save/restore and points-panel checks. This iteration does not force rotation of real credentials, retest every real model or verify real image recognition.
