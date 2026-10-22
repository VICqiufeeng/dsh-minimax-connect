# dsh-minimax-connect

把本机 **MiniMax Code（Mavis）** 已登录的订阅接入 [DeepSeek Harness](https://github.com/deepseek-ai)，作为一个模型 provider，并在设置侧边栏给出一个独立页面：**积分余额 / 每日签到 / 模型清单 / 用量**。

积分制账号：不消耗 API key，消耗 MiniMax Code 订阅的积分。

> **不用打开 MiniMax Code。** 插件自己完成 OAuth 续期，桌面客户端可以完全退出。
> 详见 [凭据自续期](#凭据自续期)。

English: [README.en.md](README.en.md)

---

## 本 fork：适配 DSH 0.2.1-rc.2

上游（`VICqiufeeng/dsh-minimax-connect` 0.1.0）是按 0.2.0 写的，在本机
`DSH Desktop Beta 2.0.18-beta.1 / 内核 0.2.1-rc.2` 上实测有三处硬伤，本 fork 全部修掉并加了回归测试：

| 症状 | 根因 | 修复 |
|---|---|---|
| 发图报 `Image request width must be a positive integer.` | 0.2.x 适配器从 `profile.requestImagePixelBudget` / `requestImageMaxBytes` 推导每张图的目标尺寸，插件没声明 → `target.width` 是 `undefined` | 补 `IMAGE_BUDGET`（2048×2048 像素 / 1 MiB 编码 / 20 MiB 累计），并接上 0.2.x 的 `resolveImageAccess`（`resolveImageAttachmentAccess(attachments, mapHostPath, ref)`） |
| 思考强度档位不对 | 模型描述符没给 `thinkingLevelMap`，pi-ai 用默认阶梯 | 显式声明 `xhigh` / `max` 两档（其余档位钉 `null`）并打开 `compat.forceAdaptiveThinking`；`off` 必须钉 `null`——网关实测拒绝 `thinking.type="disabled"`（`model requires adaptive thinking`） |
| 日志 `host settings service has no installSection API` | 0.2.1 的 settings 服务没有 `installSection` | 改用 0.2.x 的 `settings.configure({ auto: false })`（声明"本插件自带页面"），卡片走自己的 `/plugins/...` 路由 |
| 偶发 `401 {"error":"invalid access token"}`（界面提示"本轮运行失败：API 密钥无效"） | 请求头 getter 有"顺手续期"的副作用：网关在 refresh 轮换时**立即作废**上一个 access token，于是触发续期的那个请求自己带着刚被作废的 token 发出去（实测：续期成功 234 ms 后那一轮被拒） | 续期挪到适配器的**可等待前置钩子**（`resolveApiKey`），请求头 getter 变成纯读；再加上 `withAuthRetry`：被 401 拒了就在续期后**重发一次**该轮 |
| 日志 `configurable provider "minimax" is already declared` | llm-pi-ai 会把 pi-ai 目录里所有 provider 声明成可配置项，`minimax` 已被占 | 路由 id 改为 **`minimax-code`**：不再撞名，`设置 → 模型` 里也能正确指向本插件而非 API Key 通道 |

因此模型选择器里的分组是 **MiniMax Code**，推理等级只有 **xhigh / max** 两档（默认 `max`；不选时请求不带 thinking 字段，落到网关自己的默认档，等同官方客户端的 `default`）。

依赖声明也按 0.2.1-rc.2 对齐：内核的 `@deepseek-ai/dsh-*` 全部落在 `>=0.2.0-rc.0 <0.3` 这个宽区间内（**不**收窄成 `^0.2.1-rc.2`，这样后续 0.2.x 依然可用）；`@earendil-works/pi-ai` 原先写成 `>=0.85.0 <1.0.0`，而 0.2.1-rc.2 内核自带的是 pi-ai 1.x（`dsh-llm-pi-ai@0.2.1-rc.2` 依赖 `^1.1.0`），因此放宽成 `>=0.85.0 <2.0.0`。0.2.x 适配器把 `auth`（凭据库 + 环境上下文）列为必填项，插件现在显式传上，运行时行为不变。

回归测试（用宿主自带的包，不需要起宿主）：

```bash
node test/rc2-fixes.mjs    # 思考阶梯、图片目标尺寸、适配器接线
node test/host-apply.mjs   # apply() 全流程：路由 id、可配置目录、settings 策略、无 warning
node test/auth-retry.mjs    # 401 识别与"续期后重发一次"
node test/peer-ranges.mjs   # peer 区间：覆盖 0.2.1-rc.2、保持宽区间、覆盖内核自带的 pi-ai
```

安装（本机开发，`link:` 便于改完重启即生效）：

```bash
pnpm --dir ~/.dsh/profiles/desktop add --ignore-scripts \
  "dsh-minimax-connect@link:/Users/cooper/Documents/Code/dsh-minimax-connect"
```

再把 `dsh-minimax-connect` 放进该 profile `package.json` 的 `dsh.profile.bundles`，重启 DSH 生效。

---

## 为什么不需要"反代"

MiniMax Code 的推理端点**本身就是 Anthropic Messages 协议**，DSH 的 `pi-ai` 原生支持该协议。所以直接把请求打到官方端点即可，不需要中间代理进程，也不需要 hook 客户端。

`~/.minimax/config.yaml` 里 MiniMax 自己就写着：

```yaml
provider:
  minimax:
    npm: '@ai-sdk/anthropic'
    options:
      baseURL: https://agent.minimax.cn/mavis/api/v1/llm/v1
```

## 实测契约（全部为真实响应，非推测）

| 用途 | 方法与路径 | 说明 |
|---|---|---|
| 对话 | `POST {llm}/v1/messages` | Anthropic Messages 协议；流式返回 `thinking_delta` + `text_delta` |
| 模型清单 | — | `GET {llm}/v1/models` 返回 **503 `direct_route_not_configured`**；改从本地 `config.yaml` 静态解析 |
| 续期 | `POST https://account.minimax.cn/oauth2/token` | `grant_type=refresh_token`，见下 |
| 积分 | `GET {cloud}/credit/details` | `details[]` 带 `granted_amount` / `remaining_amount` / `consumed_amount` |
| 签到面板 | `GET {cloud}/signin/status?timezone_id=Asia/Shanghai` | **`timezone_id` 是必需参数**，缺则 `1406010011 invalid timezone_id` |
| 签到 | `POST {cloud}/signin/claim?timezone_id=Asia/Shanghai`，body `{}` | 空 body 与官方客户端一致；**同样需要 `timezone_id`** |

其中：

```
{llm}   = https://agent.minimax.cn/mavis/api/v1/llm
{cloud} = https://agent.minimax.cn/minimax-cloud/api/v1
```

**注意两个 base 不同**：Anthropic SDK 会自己在 `baseURL` 后补 `/v1/messages`，所以 `{llm}` **不带**结尾的 `/v1`；而 cloud 路由**带** `/v1`。

## 鉴权

读 `~/.minimax/auth/prod/cn/mcode-public/auth.json`，取 `records[*].accessToken`（`mmoat_` 开头），以 **`Authorization: Bearer`** 发送。

> ⚠️ **不能用 Anthropic 的 `x-api-key`**：实测报 `401 {"code":401,"message":"token is required"}`。

记录键是 `` `${service}\0${account}` ``，分隔符是**真的 NUL 字符**，`account` = `base64url(sha256(authHome + "\0" + "mcode-public"))`。

## 凭据自续期

access token **有效期 1 小时**。MiniMax Code 大致每小时续期一次并写回同一个文件 —— 在它之外没有任何东西会做这件事，所以关掉桌面客户端后，插件在 token 过期的那一刻就废了：实测过期后第一个请求回 `401 invalid access token`，而记录里躺着一个完全可用的 `refreshToken` 无人问津。

本插件自己执行同一个 grant：

```
POST https://account.minimax.cn/oauth2/token
     grant_type=refresh_token
     refresh_token=<mmort_…>
     client_id=mcode-public
     scope=agent.default
     audience=agent-backend
  -> { access_token, refresh_token, token_type, expires_in, scope }
```

行为：

- **提前 5 分钟续期**，不让任何一条流开在一个正在死掉的 token 上。除按需触发外，还有一条 60 秒的巡检。
- **`refresh_token` 单次有效、每次 grant 都轮换**，所以旧值在应答到达的瞬间就死了，新的一对必须在用新 access token 之前落盘。写入是**原子替换**（临时文件 + rename），桌面客户端不会读到写了一半的记录。
- **与官方客户端共存**。客户端用文件锁串行化自己的续期（`proper-lockfile`，`auth.lock` → `auth.lock.lock` 目录，`stale: 30_000`）。这里复用同一套 on-disk 约定：`mkdir` 抢占、超过 30 秒的锁按陈旧回收、写入前重新读一次文件并**采纳更新的 generation 而不是覆盖它**。两边轮流续期互不踢出，已实测双向共存。
- **两个文件必须同步推进**。客户端 `MCodeOAuthCore.readUsableCredential` 要求 `credential.generation === state.generation`，不一致就当成未登录。新代际取 `max(state.generation, credential.generation) + 1` —— 只用凭据自己的计数器，就可能写回一个**低于** `auth-state.json` 的值，把账号锁在自己的新 token 外面。
- **失败不抛异常**，一律回 `{ ok: false, reason, fatal? }`，调用方继续用盘上已有的 token。`fatal` 只标记一种永久失败：`invalid_grant`（refresh token 本身没了），此时只有去 MiniMax Code 重新登录一次能把 provider 救回来。

设一面卡片会直接显示当前状态：*自动续期已启用（到期前 5 分钟），不用打开 MiniMax Code* / *正在自动续期…* / *自动续期暂停，HH:MM:SS 后重试* / *凭据没有 refreshToken，需在 MiniMax Code 里重新登录一次*。

### 端到端验证

`test/renew-e2e.mjs` 只把 `expiresAtMs` 改到"即将过期"（**两个 token 一个都不碰**，所以 grant 失败也是零代价），然后调用插件自己发货的 `renewCredential`，最后拿新 token 打真实模型端点：

```bash
node test/renew-e2e.mjs ~/.minimax/auth/prod/cn/mcode-public/auth.json
```

在 MiniMax Code **进程数为 0** 的情况下实测通过：grant 273 ms、代际 +1、两个文件代际相等、`loginEpoch` 保留、`refreshToken` 轮换，新 token 打 `/v1/messages` 返回 **HTTP 200** `{"text":"ok","base_resp":{"status_code":0}}`。

## 安装

```bash
dsh plugin --profile desktop add "github:VICqiufeeng/dsh-minimax-connect"
```

1. 装在 profile 的 `node_modules` 下，`dsh.profile.bundles` 会自动加上这一项。
2. **重启 DSH** 后生效。
3. 本插件不写用户补丁层（不碰 `cordis.patch.yml`），卸载时从 `dependencies` 与 `dsh.profile.bundles` 两处移除即可，不留残留。

如果 pnpm 的供应链闸门报 `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`（对 git 依赖一般不触发），追加 `--config.minimumReleaseAge=0`。

## 界面

**设置 → MiniMax**（`settings.section` 插槽，order 460），四个区块：

- **积分 + 签到 + 账号** —— 通用积分余额、七天签到面板、账号信息与续期状态。
- **模型清单** —— 逐模型开关 / 图片输入 / 上下文窗口（200K 或 1M）。
- **保存行** —— 落盘到插件自己的 settings 命名空间 `llm-minimax`。

同一份卡片也会出现在**插件管理页**（侧边栏「插件」图标 → 已安装 → `dsh-minimax-connect`）的详情里，因为它同时注册了 `plugins.bundle.config` 与 `plugins.row.config`。

另有一个自包含的零构建 HTML 面板：`GET /plugins/dsh-minimax-connect/panel`。

## 路由（全部仅回环）

| 路由 | 说明 |
|---|---|
| `GET /plugins/dsh-minimax-connect/status` | 汇总快照（面板用），含 `selfRenewal` |
| `GET /plugins/dsh-minimax-connect/usage` | 积分明细原始应答 |
| `GET /plugins/dsh-minimax-connect/checkin` | 签到状态 |
| `GET /plugins/dsh-minimax-connect/signin` | 七天签到面板原始应答 |
| `POST /plugins/dsh-minimax-connect/signin/claim` | 执行签到 |
| `GET /plugins/dsh-minimax-connect/models` | 当前模型清单 |
| `POST /plugins/dsh-minimax-connect/__save` | 写回启用模型 / 图片开关 / 上下文窗口 |
| `GET /plugins/dsh-minimax-connect/panel` | 自包含 HTML 面板（无构建步骤） |

## 配置

`Config`（schemastery）可覆盖的字段：

| 字段 | 默认 |
|---|---|
| `baseUrl` | `https://agent.minimax.cn/mavis/api/v1/llm` |
| `cloudBaseUrl` | `https://agent.minimax.cn/minimax-cloud/api/v1` |
| `authFile` | `~/.minimax/auth/prod/cn/mcode-public/auth.json` |
| `configFile` | `~/.minimax/config.yaml` |
| `cacheMs` | `15000` |
| `enabledModelIds` / `imageOverrides` / `useMaximumContextWindow` | 由设置页写入 |
| 各 `*Route` | 见上表 |

## 模型

清单来自本地 `~/.minimax/config.yaml` 的 `whitelist` + `model_order`，默认四个：

| 模型 | 上下文 | 图片 | 推理 |
|---|---|---|---|
| `MiniMax-M3` | 512K / 1M | ✅ | 可开关 |
| `MiniMax-M3.1-Flash-Preview` | 512K / 1M | ✅ | 强制 |
| `MiniMax-M2.7` | 200K | ❌ | 强制 |
| `MiniMax-M2.7-highspeed` | 200K | ❌ | 强制 |

## 已知限制

- **积分不换算成本**：模型描述符的 `cost` 全为 0。积分制下没有公开的每 token 单价，填 0 好过填一个编出来的数字。
- **依赖客户端非公开接口**：MiniMax 更新后端点可能变动；端点集中在 `lib/index.js` 顶部注释里，便于对照。
- **图片输入**走宿主的 durable attachment service。老版本宿主不提供该服务时会回 `UNSUPPORTED_CONTENT`，插件对两种 store 形状都做了适配。
- 只测过 **Windows + 国内版（cn）**。区域路径与 `buildEnv` 硬编码在 `defaultAuthFile()` 里，其它区域需要改这一处。

## 设计说明

代码里凡是"为什么这么写"的地方都留了注释，几处值得一读的：

- `credential renewal` 段头：为什么插件不得不接管续期。
- `mirrorAuthState` / `nextGeneration`：两个文件代际必须一致的原因，以及那个会导致锁死自己的 off-by-one。
- `withAuthLock`：为什么复刻 `proper-lockfile` 的 on-disk 约定而不是依赖它。
- `adaptAttachmentStore`：宿主 attachment store 的两种形状。

## License

MIT
