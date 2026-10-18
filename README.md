# MiniMax Code 接入 DSH 0.2.1-rc.2

适配版 `0.1.0-dsh021rc2.3`，基于 [VICqiufeeng/dsh-minimax-connect](https://github.com/VICqiufeeng/dsh-minimax-connect) 的提交 `8c927d79d1ac09b384b48fd350783ec8cdb9e01e`。原作者 VICqiufeeng，许可证 MIT。

## 适配内容

- 使用 `engines.dsh: 0.2.1-rc.2` 限定经过验证的宿主版本；DSH 接口的 peerDependencies 同步更新。此包不用于旧版 DSH 0.2.0-rc.2。
- 沿用已经适配新版接口的认证、图片附件、重试默认值及设置页代码；使用宿主的 pi-ai 1.x，不额外打包一份旧版 SDK。
- 凭据始终从 MiniMax Code 的登录文件读取，由插件已有的锁和 OAuth 流程续期；禁止 SDK 写入该账号或回退到其他服务商的环境变量凭据。
- 修复异步初始化期间卸载或热重载插件，仍可能注册遗留模型路由和选择器条目的问题。卸载时立即标记结束，异步初始化恢复后再次确认生命周期。
- 续期使用 `proper-lockfile` 4.1.2 维护 MiniMax Code 兼容的目录锁：30 秒陈旧阈值、5 秒心跳、约 20 秒等待上限；兑换请求与响应体读取合计限时 15 秒。锁丢失时取消请求，阻止旧持有者写入凭据或删除替换后的锁。
- 凭据原子写回使用独占、随机名称的私有临时文件，保持或收紧 Unix 权限并清理失败的临时文件。
- 卡片、状态页和实际适配器共用模型目录；点击重新获取后同步更新并通知宿主。最大上下文只使用基础窗口和明确声明的扩展窗口，不再人为抬高小窗口模型的上限。
- 所有插件 Web 接口复用 DSH Connection 的 Host/Origin 和登录校验，并要求 owner 身份；Connection 不可用时拒绝请求。仅来自回环地址也不能绕过登录。
- 续期任务和失败退避按实际凭据文件隔离，符号链接别名归一到真实路径。伴随状态写入失败时保留已经轮换的新令牌并明确报告待修复，随后持锁修复状态，不再次兑换令牌；显式退出登录或已有更新状态时不自动恢复旧凭据。
- OAuth 错误和损坏凭据文件的诊断不回显原始响应或文件内容。
- 附带只使用临时伪造凭据的回归测试；移除旧版需要改写真账号到期时间的手工测试脚本。

## 验证环境和结果

2026-10-18，腾讯云 Ubuntu 24.04、Node 24.18.1、DSH 0.2.1-rc.2、Cordis 4.0.5、Schemastery 3.18.5、pi-ai 1.3.0。

在独立的宿主、DSH_HOME、工作区和回环端口中验证，未切换生产服务。

`npm test` 共 32 项测试，全部通过，覆盖宿主默认值、附件、认证隔离、流式文本、工具调用、卸载、上下文上限、模型刷新、文件权限、写入清理、跨进程心跳、锁替换、网络超时、不同账号续期隔离、伴随状态失败恢复、退出登录、凭据别名及全部插件路由鉴权。

Windows 另行验证原子创建与替换、锁检查与释放、失败写入清理；Unix 权限测试在 Linux 执行，Windows 文件访问仍由 ACL 决定。

安装包验证使用独立的 DSH profile、本地模拟上游及假账号。模型从 Fixture-A 改为 Fixture-B 后，刷新响应、后续读取和状态页同步，最大上下文保持 32768。路由鉴权验证同时检查未登录、错误 Origin、伪造 Cookie 与正常 owner 登录。

前一迭代 `.1` 已做真实 MiniMax Web 验证：设置页显示登录状态、积分与 4 个模型；禁用模型、保存、重新启用后保存均成功；模型选择器列出 4 个 MiniMax 模型；选用 M3 发起真实对话，返回“连接成功”。浏览器无控制台错误。本轮续期和边界测试使用假账号，不强制轮换真实凭据。

测试不强制刷新真实账号凭据，续期轮换使用模拟 OAuth 服务验证；未逐个实测全部模型，也未做真实图片识别测试。

## 模型目录和登录

插件优先读取 MiniMax Code 的 `~/.minimax/config.yaml` 中 `provider.minimax.models`，不会混入自定义服务商。没有可读配置文件时使用随包内置的 4 个模型目录，并在页面标注 fallback；这不是从服务端动态枚举全部可用模型。

默认登录文件为 `~/.minimax/auth/prod/cn/mcode-public/auth.json`。需先在运行 DSH 的机器上登录国内 MiniMax Code 账号；安装包和源码不包含登录凭据。

## 安装

先准备 DSH **0.2.1-rc.2** 的宿主环境，再在其 Web profile 中安装本包；可使用 DSH 的插件管理器或该版本的 CLI：

```sh
dsh plugin --profile web add /absolute/path/dsh-minimax-connect-0.1.0-dsh021rc2.3.tgz
```

CLI 的 `add` 只添加依赖。首次安装还需在该 profile 的 `package.json` → `dsh.profile.bundles` 数组中追加 `"dsh-minimax-connect"`，保留原有条目；已经启用旧版的 profile 无需重复追加。

独立建立 profile 时，使用宿主提供的 peer 包。其 `pnpm-workspace.yaml` 应包含 `nodeLinker: hoisted` 和 `autoInstallPeers: false`，使插件能复用宿主，避免另装一套 DSH 依赖及触发无关依赖的构建审批。正常使用已有 profile 时保留其配置。

务必使用实际服务的 `DSH_HOME` 和升级后宿主的 CLI。重启后刷新页面，再检查设置 → MiniMax 和模型选择器。本包的安装不会替代其他插件各自的兼容性验证。

开发验证时，在具有上述宿主依赖的已安装插件目录运行 `npm test`。客户端专用模块由 Web 宿主提供，无需额外打包。旧的改写真账号到期时间的手工脚本已由临时假凭据测试替代。
