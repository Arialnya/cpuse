# 移植依据与 Harness 插件规范

## 研究基线

研究日期：2026-10-04。兼容性基线为 **DeepSeek Harness 0.2.0-rc.2**，使用该版本 npm 发布包的实际类型定义与实现核对接口。官方文档用于解释开发流程；仓库源码按目标版本固定引用。依赖版本需要保持一致；预览版本之间不保证兼容。

| 依赖 | 使用版本与依据 |
|---|---|
| Harness CLI | [`@deepseek-ai/dsh@0.2.0-rc.2`](https://www.npmjs.com/package/@deepseek-ai/dsh/v/0.2.0-rc.2) |
| 工具、MCP、附件、模型、系统提示及电脑控制注册服务 | `@deepseek-ai/dsh-*` 对应包均固定为 `0.2.0-rc.2`，名称与版本见 `package.json` / `package-lock.json` |
| Cordis | `@deepseek-ai/cordis@4.0.4`，满足目标 Harness 的 `~4.0.4` 要求 |
| Schemastery | `@deepseek-ai/schemastery@3.18.4`，满足目标 Harness 的 `~3.18.4` 要求 |

下列源码链接固定到官方 `dsh-v0.2.0-rc.2` 标签对应提交 `639ed015397290b3745d163aafe02ffee4aa3f84`，由 `git ls-remote` 核对。CLI 发布包也已核对支持 `--profile`、`--from-default-profile`、`--dump-config` 及 `plugin add`；README 的安装命令均明确选用目标版本。

| 主题 | 官方资料 |
|---|---|
| 插件生命周期与依赖注入 | [编写插件](https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/) |
| 工具定义、输入 schema 与执行 | [工具教程](https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/tool)、[工具详细规范](https://deepseek-harness.github.io/deepseek-harness/en/reference/cookbook/adding-a-tool) |
| 配置校验 | [插件配置](https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/config) |
| npm 包与 bundle patch | [打包与发布](https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/publish) |
| 审批与执行策略 | [Approval 子系统](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/approval) |
| 工具执行、取消与结果类型 | [官方 tools 源码](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/core/tools/src/index.ts) |
| 图像结果转换 | [官方 MCP 结果适配器](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/mcp/mcp-client/src/tools.ts) |
| Harness 已有原生桌面 provider | [实验性 Cua Driver provider](https://github.com/deepseek-ai/deepseek-harness/tree/639ed015397290b3745d163aafe02ffee4aa3f84/packages/experimental/computer-use-cua-driver-native) |
| CLI 参数、profile 与 bundle 安装 | [CLI 参数源码](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/apps/cli/src/args.ts)、[profile 初始化源码](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/boot/app-boot/src/profile.ts)、[插件包安装源码](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/boot/plugin-manager/src/operations.ts) |

开发期下载的参考资料不进入仓库，也不随运行包分发；其中不同版本的内容不构成当前兼容性依据。安装时按 `package.json` 的明确版本匹配 Harness，不能用滚动更新的文档或其他预览版接口替代 `0.2.0-rc.2` 发布包。

## 插件组合

Cordis 插件导出名称、依赖注入声明、配置 schema 和 `apply(ctx, config)`。通过 `ctx.tools.register()` 注册工具，通过 `ctx.systemPrompt.section()` 添加桌面控制工作流。`package.json` 的 `dsh.bundle.patch` 指向 `cordis.patch.yml`，供 Harness 的配置组合加载本包。

工具定义使用 Harness 的 schema 与执行接口，规范结果保持 JSON 可序列化。模型可见结果由结果渲染与图像投影生成。截图以 Harness 附件引用进入 Session；规范原始结果中的 data URL 不直接复制成巨大的模型文本。

每个工具执行都接收 Harness 的 `exec.signal` 和调用身份。控制器用稳定会话身份绑定窗口观察，将取消传给后端。插件卸载时移除所注册工具和提示词，并终止所属原生子进程。子进程使用私有 stdio JSONL；不打开监听端口、不运行模型提供的 JavaScript/PowerShell，也不把输入文本交给 shell。

宿主提供 `computerUse` 时，本插件通过其独占注册槽防止两个桌面 provider 同时工作。Cordis 的独立 effect 在卸载时可能并行执行，因此使用一个 generator effect 顺序等待原生关闭与全部在途工具结果（包含模型图像准入），最后释放 provider 注册。该处理遵循官方原生 provider 的生命周期写法。

Harness 的策略接口是 `tools/pre-execute` 等执行钩子，以及需要单调拒绝时的工具 guard。工具本身没有通用 `permission` 属性，也不能假设存在 `ctx.permissions`。宿主的审批配置与本插件的允许/拒绝应用配置共同决定调用是否执行；桌面读取和输入的分类应根据实际动作处理。

## Codex 原理与本项目的对应关系

Codex 的公开 Computer Use 使用会话 JavaScript facade 调用 `sky` window2 API，按应用/窗口枚举、UIA 状态与截图观察、目标窗口输入、新状态核实形成闭环。Windows 实现依托 UI Automation、`SendInput` 和 Windows.Graphics.Capture。

本项目保留这层开发体验与工作流，提供十三类窗口操作的独立实现。`src/client.ts` 提供会话客户端，Harness 注册对应的模型工具；`src/controller.ts` 执行枚举绑定、观察新鲜度、会话隔离、应用过滤、输入串行与动作后刷新；`src/backend.ts` 管理进程通信；`native/Cpuse.Windows` 调用公开 Windows API。

为避免模型拿旧索引或错误截图发送输入，本项目要求输入显式携带 `observation_id`，坐标操作引用 `screenshotId`。这比参考 API 的部分可选字段更严格。用户侧客户端可缓存这些引用，但缓存失效后必须重新观察。

Codex 专有包、私有 helper、浏览器控制、OpenAI 模型视觉能力、系统权限和 Windows 桌面隔离都不属于可直接移植的代码。浏览器内容在这里作为普通 Windows 应用处理；这不是 DOM 浏览器控制插件。模型必须具有自己的图像输入路由，才能依据窗口截图理解界面。

## 维护时需要核对的接口

升级 Harness 前，核对 `ToolDefinition`/`defineTool`、`ToolRunContext`、结果渲染、附件存储、模型图像能力准入、`systemPrompt.section()`、工具策略事件和卸载生命周期。为结果投影或取消接口做出的适配，必须有针对性的集成测试。

升级 Windows/.NET 目标时，核对 WinRT WGC 投影、UIA pattern、DPI 坐标与窗口前台规则。仅在测试窗中通过屏幕输入不够：还要验证遮挡截图、外部状态变化、输入失败和取消后的不确定结果。

## 已执行的 Harness 组合验证

`tests/plugin.test.mjs` 已在上述 `0.2.0-rc.2` 发布包组合上重新通过全部 15 项检查，使用实际 Cordis `4.0.4`、ToolRuntime、SystemPrompt、ApprovalService、ComputerUseRegistry、Session、LlmRuntime 和 MCP 结果适配器加载本插件。只替换原生后端边界及附件存储介质，测试不会启动 helper 或操作用户窗口。覆盖全部十四个工具注册与卸载、提示词组合、审批服务缺失时拒绝、`never` 策略、会话批准隔离、上游拒绝、取消审批及晚到批准、在途调用与图像准入卸载、provider 共存拒绝及延迟关闭期间的注册保留，以及支持/不支持图像的模型路由结果。

图像测试验证固定 PNG 字节通过 AttachmentStore 接纳后，模型结果包含 Harness 附件引用，截图原始尺寸与观察标识留在规范值中；不支持图像的模型得到明确诊断，同时程序调用仍能读取原始 MCP 图像数据。该测试使用内存附件后端，不证明真实宿主磁盘存储、模型视觉推理或 Windows 截图质量。
