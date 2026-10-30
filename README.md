# dsh-minimax-connect

把本机 **MiniMax Code（Mavis）** 已登录的订阅接入 [DeepSeek Harness](https://github.com/deepseek-ai)，作为一个模型 provider，并在设置侧边栏给出一个独立页面：**积分余额 / 每日签到 / 模型清单 / 用量**。

积分制账号：不消耗 API key，消耗 MiniMax Code 订阅的积分。

> **不用打开 MiniMax Code。** 插件自己完成 OAuth 续期，桌面客户端可以完全退出。
> 详见 [凭据自续期](#凭据自续期)。

English: [README.en.md](README.en.md)

---

## 兼容性

一个实现，没有版本判断。代码只依赖各版本共有的契约，所以新版不用改、旧版也不用改。

| DSH | 状态 |
|---|---|
| `@deepseek-ai/dsh` 0.2.1-rc.5（当前 `latest`） | ✅ 对照编写基准 |
| `@deepseek-ai/dsh` 0.2.1-rc.4 | ✅ 已核对契约 |
| `@deepseek-ai/dsh` 0.2.1-rc.3 | ✅ 已核对契约 |
| `@deepseek-ai/dsh` 0.2.1-rc.2（兼容下限） | ✅ 已核对契约 |

向下兼容到 `0.2.1-rc.2`。实测 rc.2 到 rc.5 的 `dsh-llm`、`dsh-settings`、`dsh-client-ui-slots`、`dsh-llm-pi-ai` 四个包的 `lib/` **逐字节相同**，`llm-pi-ai` 的导出表也一字不差 —— 这条线内部没有 API 漂移，所以兼容性不需要靠分支维持。

`0.2.2-alpha.2` 是另一条线（`0.2.2-*`），不在兼容声明内。它当前测下来也通过，但没人为它做保证：给一个本机不运行的版本维持兼容，等于为不存在的需求背 alpha 分支。

0.1 线（`0.1.0`）只跑在 `0.2.0-rc.*` 上，且依赖一个从未真正生效的 `settings.installSection` 调用 —— 那套写法在 0.2.1 线上整个方法都不存在。0.2.0 版按 0.2.1 线的实测契约重写，见 [0.2 迁移](#02-迁移改了什么)。

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
| 会员/订阅 | `POST {matrix}/commerce/get_membership_info`，body `{}` | 套餐名、订阅类型、额度余额、自动续费、可升级动作 |
| 工作区 | `POST {matrix}/user/get_user_extra_info`，body `{}` | 个人工作区名、成员数、OpenPlatform 账号组 id |

其中：

```
{llm}   = https://agent.minimax.cn/mavis/api/v1/llm
{cloud} = https://agent.minimax.cn/minimax-cloud/api/v1
{matrix} = https://agent.minimax.cn/matrix/api/v1
```

**注意 base 不同**：Anthropic SDK 会自己在 `baseURL` 后补 `/v1/messages`，所以 `{llm}` **不带**结尾的 `/v1`；cloud 与 matrix 路由**带** `/v1`。`{matrix}` 由 `{cloud}` 派生（把 `/minimax-cloud` 换成 `/matrix`），也可在 `Config.matrixBaseUrl` 里直接给。

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

卡片会直接显示当前状态：*自动续期已启用（到期前 5 分钟），不用打开 MiniMax Code* / *正在自动续期…* / *自动续期暂停，HH:MM:SS 后重试* / *凭据没有 refreshToken，需在 MiniMax Code 里重新登录一次*。

### 端到端验证

`test/renew-e2e.mjs` 只把 `expiresAtMs` 改到"即将过期"（**两个 token 一个都不碰**，所以 grant 失败也是零代价），然后调用插件自己发货的 `renewCredential`，最后拿新 token 打真实模型端点：

```bash
node test/renew-e2e.mjs ~/.minimax/auth/prod/cn/mcode-public/auth.json
```

在 MiniMax Code **进程数为 0** 的情况下实测通过：grant 273 ms、代际 +1、两个文件代际相等、`loginEpoch` 保留、`refreshToken` 轮换，新 token 打 `/v1/messages` 返回 **HTTP 200** `{"text":"ok","base_resp":{"status_code":0}}`。

### 静态自检

改完代码不用等装进 DSH 就能先跑三个不联网的检查：

```bash
npm run smoke        # 客户端：注册了哪四个槽位、用的 id 还是 key、命名空间对不对
npm run smoke:slots  # 同上，但把注册灌进真实的 0.2.1-rc.2 SlotCore 让它自己校验
npm run matrix       # 四个目标版本逐个过一遍：槽位 / settings / llm / adapter
npm run render       # 用真机 /status 的应答把卡片渲染出来，看用户实际看到的那几行
```

`smoke` 用 VM 把 `lib/client.js` 的信封跑起来，不需要任何 peer 包。`smoke:slots` 与 `matrix` 需要 `.apicheck/` 下有解包好的官方包（探查遗留目录，不在仓库里），没有就打印 SKIP 退出。host 侧的 `test/smoke-host.mjs` 要裸导入 peer，只能在装好的副本里跑。

`render` 同样用 VM 加载 `lib/client.js`，但给它一个够用的 React 替身（带状态机，能跑完卡片自己的 `useEffect` 取数），再拿**运行中 DSH 的 `/status` 应答**渲染，最后把「订阅额度」那一块的文本逐行打出来。默认指向 `http://127.0.0.1:61878/plugins/dsh-minimax-connect/status`，可以传参换端口：

```bash
node test/render-card.mjs http://127.0.0.1:61878/plugins/dsh-minimax-connect/status
```

`matrix` 的结论不是断言出来的：它对每个版本加载**那个版本自己的** `SlotCore`，把插件真实的注册灌进去；settings/llm/adapter 三列则从该版本自己的类体里读出方法是否存在。最后还跑一条负向对照——把 0.1.0 那种「keyed 槽传 `id`」的写法喂进去，必须被拒。对照没被拒就说明整个 slots 列在测空气，脚本会直接报 HARNESS BROKEN。

## 安装

```bash
dsh plugin --profile desktop add "github:VICqiufeeng/dsh-minimax-connect"
```

1. 装在 profile 的 `node_modules` 下，`dsh.profile.bundles` 会自动加上这一项。
2. **重启 DSH** 后生效。
3. 本插件不写用户补丁层（不碰 `cordis.patch.yml`），卸载时从 `dependencies` 与 `dsh.profile.bundles` 两处移除即可，不留残留。

如果 pnpm 的供应链闸门报 `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`（对 git 依赖一般不触发），追加 `--config.minimumReleaseAge=0`。

## 界面

**设置 → MiniMax**（`settings.section` 插槽，order 460），三个区块：

- **积分 + 签到 + 账号** —— 通用积分余额、七天签到面板、账号信息与续期状态。
- **订阅额度** —— 套餐名、订阅类型、倍用量、额度余额（总额度 / 订阅额度 / 免费额度）、待入账、每日登录赠送、到期时间、自动续费、可升级动作、工作区，外加「已自动续期 N 次」与本账号可用模型。
- **模型清单** —— 逐模型开关 / 图片输入 / 上下文窗口（512K 或 1M），以及目录声明的思考模式与文件上传能力。
- **保存行** —— 落盘到插件自己的 settings 命名空间 `llm-minimax`。

同一份卡片还出现在三处：**插件管理页**的包页与行页（`plugins.bundle.config` / `plugins.row.config`），以及 **设置 → 模型** 里本 provider 的卡片位（`settings.models.provider-card`）。

另有一个自包含的零构建 HTML 面板：`GET /plugins/dsh-minimax-connect/panel`。

## 路由（全部仅回环）

| 路由 | 说明 |
|---|---|
| `GET /plugins/dsh-minimax-connect/status` | 汇总快照（面板用），含 `selfRenewal` |
| `GET /plugins/dsh-minimax-connect/usage` | 积分明细原始应答 |
| `GET /plugins/dsh-minimax-connect/signin` | 七天签到面板原始应答 |
| `POST /plugins/dsh-minimax-connect/signin/claim` | 执行签到 |
| `GET /plugins/dsh-minimax-connect/models` | 当前模型清单（`?refresh=1` 重读磁盘） |
| `POST /plugins/dsh-minimax-connect/__save` | 写回启用模型 / 图片开关 / 上下文窗口 |
| `GET /plugins/dsh-minimax-connect/panel` | 自包含 HTML 面板（无构建步骤） |

保存有两条路：卡片优先走宿主的 `configForms`（带 revision，冲突自动恢复），宿主没有提供该命名空间时回落到 `__save`。两条路写的是同一份 volatile 配置，`__save` 会把读回的值一起返回，写没落地会明确报错而不是假装成功。

## 配置

`Config`（schemastery）可覆盖的字段：

| 字段 | 默认 |
|---|---|
| `baseUrl` | `https://agent.minimax.cn/mavis/api/v1/llm` |
| `cloudBaseUrl` | `https://agent.minimax.cn/minimax-cloud/api/v1` |
| `authFile` | `~/.minimax/auth/prod/cn/mcode-public/auth.json` |
| `configFile` | `~/.minimax/config.yaml` |
| `cacheMs` | `15000` |
| `enabledModelIds` / `imageOverrides` / `useMaximumContextWindow` | 由设置页写入（均为 volatile） |
| 各 `*Route` | 见上表 |

三个可写字段是 **volatile** 的：宿主的 settings 服务只服务带 volatile 字段的条目，也只允许写 volatile 字段，非 volatile 会回 `Config field "X" is not volatile`。

## 模型

清单来自本地 `~/.minimax/config.yaml`，解析的是模型条目本身（`limit` / `modalities` / `thinking_config` / `capabilities` / `contextWindowOptions`），不依赖 `whitelist` 或 `model_order`。本机实测解析出：

| 模型 | 上下文 | 图片 | 思考模式 | 文件上传 |
|---|---|---|---|---|
| `MiniMax-M3` | 512K / 1M | ✅ | 可切换 | ✅ |
| `MiniMax-M3.1-Flash` | 512K / 1M | ✅ | 强制开启 | ✅ |

目录里 `modalities.input` 还声明了 `video`。卡片会显示这一点，但**不把它作为可选项**：这个 provider 说的是 Anthropic Messages 协议，报文只承载 text 与 image 两类内容块，列成可勾选等于承诺一个传输层送不出去的能力。

读不到 `config.yaml` 时回落到内置清单，`/models` 的 `source` 字段会说明来源是磁盘还是回落。

## 订阅额度与倍用量

套餐信息只有一个真实来源：`POST {matrix}/commerce/get_membership_info`。本机（免费账号）实测应答：

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

卡片从这份应答里显示：套餐名 / 订阅类型 / 倍用量 / 额度余额（总额度、其中订阅额度、其中免费额度）/ 待入账 / 每日登录赠送 / 到期时间 / 自动续费 / 续费周期 / 可升级 / 工作区；**拿不到的字段显示「接口未返回」，不空着也不填 0**。

关于**倍用量**：客户端包里没有套餐目录接口，营销页上的 Go / Explore / Build 与 3× / 12× 是静态文案，服务端不发布。所以这里不硬编一张营销表，而是在应答里递归（最多三层）找数值型的 `*multiplier*` / `*multiple*` / `*times*` 字段，找到就显示，找不到就写「接口未返回」。

**包含的模型**用本账号真正能用的清单回答 —— 即本地 `config.yaml` 解析出的模型（本机为 `MiniMax-M3`、`MiniMax-M3.1-Flash`），而不是套餐宣传里的模型表。

OpenPlatform 的 `/backend/account/token_plan/subscriptions` 用 agent token 调用会落到 404 / `401 not login`（实测），所以订阅额度只走 matrix 通道。

「长时间免登录」不靠这张卡，而是靠凭据自续期：卡片上的 **已自动续期 N 次** 取自 `auth-state.json` 的 `generation`，本机已自续 195 次，从没手工重登过。

## 已知限制

- **积分不换算成本**：模型描述符的 `cost` 全为 0。积分制下没有公开的每 token 单价，填 0 好过填一个编出来的数字。
- **倍用量拿不到就写「接口未返回」**：套餐目录（Go / Explore / Build 与各自的倍用量）是营销页静态文案，服务端没有对应接口；插件不会拿一张编出来的表冒充接口数据。
- **依赖客户端非公开接口**：MiniMax 更新后端点可能变动；端点集中在 `lib/index.js` 顶部注释里，便于对照。
- **图片输入**走宿主的 durable attachment service。0.2 线通过 `resolveImageAccess` 把附件引用换成可读路径；缺该服务时回 `UNSUPPORTED_CONTENT`。
- 只测过 **Windows + 国内版（cn）**。区域路径与 `buildEnv` 硬编码在 `defaultAuthFile()` 里，其它区域需要改这一处。

## 0.2 迁移改了什么

`0.1.0` 的代码里有几处按 0.2 之前的假设写的，在四个目标版本上都不成立。逐条对照：

| 0.1.0 | 0.2.0 | 原因 |
|---|---|---|
| `settings.installSection(ctx, ns, schema, config, hooks)` | `settings.configure({ auto: false }, ctx.fiber)` | 0.2.1 线的 settings 服务都没有 `installSection`；命名空间由 Loader 按 row id 自动发布，`configure` 只负责关掉自动生成的表单，避免同一批字段出现两份 UI |
| `settingsNamespaceOf` 回落到 `'dsh-minimax-connect'` | 回落到 `'llm-minimax'` | settings 服务按 `entry.options.id` 寻址，那是 patch 里的 row id，不是包名 |
| 客户端 namespace `'settings.minimax-connect'` 兼作 settings 命名空间 | 拆成 `SETTINGS_NS='llm-minimax'` 与 `COPY_NS='settings.minimax-connect'` | 前者是 settings 命名空间，后者只是本卡片的词典 id，混用会让写入打到一个没人服务的命名空间 |
| `plugins.bundle.config` / `plugins.row.config` 传 `id` | 传 `key` | 这两个槽位在 0.2 是 keyed，注册时缺 `key` 直接抛 `keyed slot "..." requires options.key` |
| 注册 `settings.plugin.item` | 删除 | 该槽位在 0.2.1 线不存在（rc.2 到 rc.5 的 slot 表都没有），注册必然抛错 |
| 无 | 新增 `settings.models.provider-card`（key = `llm-minimax`） | 这是 0.2 给 provider 加卡片的正规位置，按 provider 的 settingsNs 派发 |
| `ctx.slots.register` 直接调用，`priority` 由插件给 | 包在 `ctx.effect` 里，`priority` 交给 runtime | 非 chain 槽位的 priority 由 runtime 分配，插件传的值会被覆盖；`ctx.effect` 保证 fiber 卸载时注销 |
| `adaptAttachmentStore` 兼容 `{maxPixels,maxBytes}` / `{width,height,maxBytes}` 两种形状 | 删除，改用 `resolveImageAccess` | 0.2 的 adapter 不再走 `readImageRequest`，而是 `imageHostPath` + 宿主映射函数 |
| profile 缺三个图像预算字段 | 显式补 `maxRequestImageBytes` / `requestImagePixelBudget` / `requestImageMaxBytes` | 手写 profile 绕过了 `resolveProfiles` 的默认值，缺了会让 `toPiContext` 拿到 `undefined` |
| `parseModels` 只读 `name` / `limit` / `- image` | 增补 `modalities` / `thinking_config` / `capabilities` / `contextWindowOptionHints` | MiniMax 已更新配置格式，旧解析器读不到新字段 |
| `FALLBACK_MODELS` 含 `MiniMax-M3.1-Flash-Preview` | 改为 `MiniMax-M3.1-Flash` | 目录里的名字变了 |
| `peerDependencies` 写 `@earendil-works/pi-ai >=0.85.0 <1.0.0` | `>=1.1.0 <2.0.0` | 0.2 线的 `llm-pi-ai` 依赖 `^1.1.0` / `^1.3.0` |
| `esc()` 只转义 `& < > "` | 增补 `'` | 面板里有单引号属性值 |

顺带修掉的两个小问题：`checkinRoute` 与 `debugPort` 是定义了但从未注册/使用的死配置，已移除；`kfmt` 在 1e6 边界会显示 `999.999K`，改成按量级选单位并保留一位小数。

## 设计说明

代码里凡是"为什么这么写"的地方都留了注释，几处值得一读的：

- `credential renewal` 段头：为什么插件不得不接管续期。
- `mirrorAuthState` / `nextGeneration`：两个文件代际必须一致的原因，以及那个会导致锁死自己的 off-by-one。
- `withAuthLock`：为什么复刻 `proper-lockfile` 的 on-disk 约定而不是依赖它。
- `profiles()`：为什么必须返回稳定引用（`PiAiAdapter.current()` 按引用 memoize）。
- `buildProfile` 的 `headers` getter：为什么 token 要在每条流上现读而不是注册时快照。

## License

MIT
