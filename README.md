# dsh-minimax-connect

把本机 **MiniMax Code（Mavis）** 已登录的订阅接入 [DeepSeek Harness](https://github.com/deepseek-ai)，作为模型 provider，并在设置里给出一张卡片：积分余额 / 每日签到 / 订阅额度 / 模型清单。

积分制账号：不消耗 API key，消耗订阅积分。推理端点本身就是 Anthropic Messages 协议，所以直连官方端点 —— 不需要反代进程，也不需要 hook 客户端。

> **不用打开 MiniMax Code。** 插件自己完成 OAuth 续期。

English: [README.en.md](README.en.md)

## 兼容性

一个实现，没有版本判断。向下兼容到 `@deepseek-ai/dsh` **0.2.1-rc.2**，实测到 **0.2.1-rc.5**（当前 `latest`）。这条线内 `dsh-llm` / `dsh-settings` / `dsh-client-ui-slots` / `dsh-llm-pi-ai` 四个包的 `lib/` 逐字节相同，所以兼容性不靠分支维持。

`0.2.2-alpha.*` 是另一条线，不在声明范围内（当前测下来也能跑，但没做保证）。

## 安装

```bash
dsh plugin --profile desktop add "github:VICqiufeeng/dsh-minimax-connect"
```

装完**重启 DSH**。插件不写用户补丁层（不碰 `cordis.patch.yml`），卸载时从 `dependencies` 与 `dsh.profile.bundles` 两处移除即可。

## 界面

**设置 → MiniMax**，四个区块：

- **积分 + 签到 + 账号** —— 积分余额、七天签到、续期状态。
- **订阅额度** —— 套餐、订阅类型、倍用量、额度余额（总 / 订阅 / 免费）、待入账、每日登录赠送、到期时间、自动续费、可升级动作、工作区，以及「已自动续期 N 次」。
- **模型清单** —— 逐模型开关 / 图片输入 / 上下文窗口（512K 或 1M），每个模型下附思考档位、单轮附件上限、思考摘要策略；表头一行给出桌面客户端自己的默认模型 / 默认档位 / 默认上下文。
- **保存行** —— 落到插件自己的 settings 命名空间 `llm-minimax`。

同一张卡片还出现在插件管理页（包页与行页）和 **设置 → 模型** 里本 provider 的卡片位。另有零构建 HTML 面板：`GET /plugins/dsh-minimax-connect/panel`。

## 鉴权与续期

读 `~/.minimax/auth/prod/cn/mcode-public/auth.json` 的 `records[*].accessToken`（`mmoat_` 开头），以 `Authorization: Bearer` 发送。**不能用 `x-api-key`**（实测 401）。

access token 只有 1 小时。关掉桌面客户端后没有别的东西会续期，所以插件自己执行同一个 grant：

- 提前 **5 分钟**续期，另有 60 秒巡检。
- `refresh_token` 每次 grant 都轮换，新的一对**原子落盘**（临时文件 + rename），客户端不会读到写了一半的记录。
- 复用客户端的文件锁约定（`mkdir` 抢占、30 秒陈旧回收），写入前重读并**采纳更新的 generation 而不是覆盖它** —— 两边轮流续期互不踢出。
- 失败不抛异常，回 `{ ok: false, reason, fatal? }`，继续用盘上已有的 token。`fatal` 只标一种永久失败：`invalid_grant`。

`test/renew-e2e.mjs` 只把 `expiresAtMs` 改到即将过期（**两个 token 一个都不碰**），在 MiniMax Code **进程数为 0** 时实测通过：grant 273 ms、代际 +1、新 token 打 `/v1/messages` 返回 200。

## 实测契约（真实响应，非推测）

| 用途 | 方法与路径 | 备注 |
|---|---|---|
| 对话 | `POST {llm}/v1/messages` | Anthropic Messages，流式 `thinking_delta` + `text_delta` |
| 模型清单 | `GET {llm}/v1/models` | 返回 **503 `direct_route_not_configured`** → 改从本地 `config.yaml` 解析 |
| 续期 | `POST https://account.minimax.cn/oauth2/token` | `grant_type=refresh_token` |
| 积分 | `GET {cloud}/credit/details` | `details[]` 带 granted / remaining / consumed |
| 签到 | `GET`/`POST {cloud}/signin/{status,claim}?timezone_id=Asia/Shanghai` | **缺 `timezone_id` 报 `1406010011`** |
| 订阅 | `POST {matrix}/commerce/get_membership_info` | body `{}` |
| 工作区 | `POST {matrix}/user/get_user_extra_info` | body `{}` |

思考档位方言（同一端点，带本机凭据实测）：

| 模型 | `thinking.type=disabled` | `output_config.effort` |
|---|---|---|
| `MiniMax-M3.1-Flash` | **400** `requires adaptive thinking` | `default/low/medium/high/xhigh/max` 全 200 |
| `MiniMax-M3` | 200（可关） | `default` **400** `invalid reasoning_effort`，其余 200 |

所以 M3.1-Flash 的 `off` 档必须声明为 `null`（从可选档位里剔除），不能靠发 `disabled` 关掉。

```
{llm}    = https://agent.minimax.cn/mavis/api/v1/llm   ← 不带结尾 /v1，SDK 自己补
{cloud}  = https://agent.minimax.cn/minimax-cloud/api/v1
{matrix} = https://agent.minimax.cn/matrix/api/v1
```

## 配置

| 字段 | 默认 |
|---|---|
| `baseUrl` | `https://agent.minimax.cn/mavis/api/v1/llm` |
| `cloudBaseUrl` | `https://agent.minimax.cn/minimax-cloud/api/v1` |
| `matrixBaseUrl` | 由 `cloudBaseUrl` 派生（`/minimax-cloud` → `/matrix`） |
| `authFile` | `~/.minimax/auth/prod/cn/mcode-public/auth.json` |
| `configFile` | `~/.minimax/config.yaml` |
| `cacheMs` | `15000` |

`enabledModelIds` / `imageOverrides` / `useMaximumContextWindow` 由设置页写入，三者必须是 **volatile** 字段，否则 settings 服务拒绝写入（`Config field "X" is not volatile`）。

## 模型

清单来自本地 `config.yaml`，解析模型条目本身（`limit` / `modalities` / `thinking_config` / `capabilities` / `contextWindowOptions` / `thinking.effortOptions`），不依赖 `whitelist` 或 `model_order` 决定有哪些模型。本机实测：

| 模型 | 上下文 | 图片 | 思考模式 | 档位 | 附件 |
|---|---|---|---|---|---|
| `MiniMax-M3` | 512K / 1M | ✅ | 可切换 | — | 9 |
| `MiniMax-M3.1-Flash` | 512K / 1M | ✅ | 强制开启 | default/low/medium/high/xhigh/max | 4 |

**思考档位怎么进宿主**：pi-ai 的模型描述符只有 `thinkingLevelMap` 一个抓手，所以插件把它生成出来（`minimal`→`low`、其余同名，`off`→`null`），并同时置 `compat.forceAdaptiveThinking = true` 让请求走 `thinking:{type:'adaptive'}` + `output_config.effort` 这条路。档位为空的模型不输出 `thinkingLevelMap`，退回 pi-ai 原生的 budget 分支。

目录里还声明了 `video`，卡片会显示但**不作为可选项**：报文只承载 text 与 image 两类内容块（pi-ai 的 `Model.input` 也只有这两类），列成可勾选等于承诺一个送不出去的能力。读不到 `config.yaml` 时回落到内置清单，`/models` 的 `source` 字段会说明来源是磁盘还是回落。

## 订阅额度

唯一真实来源是 `POST {matrix}/commerce/get_membership_info`。卡片显示套餐 / 订阅类型 / 倍用量 / 额度余额 / 待入账 / 每日登录赠送 / 到期时间 / 自动续费 / 续费周期 / 可升级 / 工作区；**拿不到的字段显示「接口未返回」，不空着也不填 0**。

**倍用量**：客户端包里没有套餐目录接口，营销页的 Go / Explore / Build 与 3× / 12× 是静态文案，服务端不发布。所以不硬编一张营销表，而是在应答里递归（最多三层）找数值型 `*multiplier*` / `*multiple*` / `*times*` 字段，找到就显示，找不到就写「接口未返回」。

**包含的模型**用本账号真正能用的清单回答 —— 即本地 `config.yaml` 的解析结果，而不是套餐宣传里的模型表。OpenPlatform 的 `/backend/account/token_plan/subscriptions` 用 agent token 调用会 404 / `401 not login`（实测），所以订阅额度只走 matrix 通道。

「长时间免登录」靠的是续期机制，不是这张卡：卡片上的**已自动续期 N 次**取自 `auth-state.json` 的 `generation`。

## 路由（全部仅回环）

前缀均为 `/plugins/dsh-minimax-connect`。

| 路由 | 说明 |
|---|---|
| `GET /status` | 汇总快照，含 `selfRenewal` 与 `membership` |
| `GET /usage`、`GET /signin` | 积分明细 / 签到面板原始应答 |
| `POST /signin/claim` | 执行签到 |
| `GET /models` | 当前模型清单（`?refresh=1` 重读磁盘），含 `desktop` 默认项与每模型 `efforts` / `maxAttachments` |
| `POST /__save` | 写回启用模型 / 图片开关 / 上下文窗口 |
| `GET /panel` | 自包含 HTML 面板（无构建步骤） |

保存优先走宿主的 `configForms`（带 revision，冲突自动恢复），宿主没有该命名空间时回落到 `__save`；两条路写同一份配置，写没落地会明确报错而不是假装成功。

## 已知限制

- **积分不换算成本**：没有公开的每 token 单价，模型描述符的 `cost` 全填 0。
- **倍用量拿不到就写「接口未返回」**：服务端没有套餐目录接口。
- **视频输入只显示不启用**：目录里有，传输层没有对应的内容块类型。
- **附件上限只显示不拦截**：`max_attachments_count` 来自客户端目录，宿主的附件校验由宿主自己做。
- **依赖客户端非公开接口**：MiniMax 更新后端点可能变动，端点集中在 `lib/index.js` 顶部注释里便于对照。
- **图片输入**走宿主的 durable attachment service（0.2 线用 `resolveImageAccess`），缺该服务时回 `UNSUPPORTED_CONTENT`。
- 只测过 **Windows + 国内版（cn）**；区域路径与 `buildEnv` 硬编码在 `defaultAuthFile()`，其它区域需改这一处。

## 自检

```bash
npm run smoke        # 槽位 / 命名空间契约
npm run smoke:slots  # 把注册灌进真实 SlotCore 校验
npm run matrix       # rc.5 → rc.2 逐版本过一遍
npm run render       # 用真机 /status 应答渲染卡片文本
npm run render:models # 用真实 config.yaml 渲染模型清单，并检查交给 pi-ai 的描述符
```

`matrix` 对每个版本加载**那个版本自己的** `SlotCore`，把插件真实的注册灌进去，并跑一条负向对照 —— 0.1.0 那种「keyed 槽传 `id`」的写法必须被拒；对照没被拒就说明整列在测空气，脚本会报 HARNESS BROKEN。

`render` 的宿主端口每次启动都会变，脚本自己扫回环 LISTENING 端口、逐个探 `/status`，只认回 `signedIn` + `models` 的那个（同机器上别的监听端口会回 401）；也可以把 URL 当第一个参数传进去。

宿主侧的检查必须在**已安装的 profile 副本**里跑：裸 checkout 没有 peer 依赖，`import` 会直接 `ERR_MODULE_NOT_FOUND`。

## License

MIT
