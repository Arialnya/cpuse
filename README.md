# cpuse · DeepSeek Harness Windows 电脑控制插件

> **⚠️ 这是 vibe coding 作品，稳定性不保证**
>
> 本项目是 dsh 桌面端插件，代码由 AI 在对话中生成与迭代，作者负责提出需求、验证结果和把握方向，而非逐行手写。它能正常运行，也通过了仓库内的 `npm test` 与 `npm run test:native`，但**不保证稳定**：内部实现、配置项和行为都可能在没有预告的情况下变化，边界场景（混合 DPI 多显示器、提权应用、弱 UIA 应用、GPU 内容截图等）覆盖有限，未实测的部分不应假定可用。
>
> 它还会**真实移动鼠标、切换前台窗口、发送键盘输入**。请只在能接受误操作风险的环境中使用，重要操作前先备份，生产环境默认别用。

按 Codex Windows Computer Use 的原理独立实现：枚举应用/窗口 → UI Automation 与窗口截图观察 → 向绑定窗口发送输入 → 返回新状态验证。包含全部 13 项公开 window2 操作，以及 `capabilities` 诊断工具。

这是使用公开 Windows API 编写的实现，不依赖 Codex 安装、`@oai/sky` 或其私有 helper。适用 Windows 10 19041+ / Windows 11；浏览器可作为普通窗口控制。Codex 的私有实现、DOM 浏览器接口和 macOS 后端不在本包内。

## 安装与运行

源码构建需要 Node.js 22.19+ 或 24+，以及 .NET 8/9 SDK。Harness 插件安装命令还需要 `pnpm` 在 PATH 中。默认发布自包含 Windows x64 helper，运行生成的插件无需单独安装 .NET。首次构建会下载 npm/NuGet 依赖。

```powershell
# 在克隆下来的源码目录中执行
npm ci
npm run build:all
npm test
npm run test:native
```

本插件的目标与兼容性基线是 **DeepSeek Harness 0.2.0-rc.2**；使用该版本的官方发布包接口，锁定 Cordis **4.0.4**、Schemastery **3.18.4**。安装时使用明确版本。

```powershell
npx @deepseek-ai/dsh@0.2.0-rc.2 --profile cpuse --from-default-profile web --dump-config
npx @deepseek-ai/dsh@0.2.0-rc.2 plugin --profile cpuse add .
npx @deepseek-ai/dsh@0.2.0-rc.2 --profile cpuse
```

在该 profile 中配置模型和审批服务后，可以请求：“使用电脑控制，找到我打开的编辑器窗口，读取内容并完成指定修改，每一步核实结果。”插件通过 `cordis.patch.yml` 安装，注册 `computer_use_*` 工具和对应系统提示；既可供普通工具调用，也可供 Harness Code Mode 的工具 SDK 调用。

需要安装包时运行 `npm pack`。打包前会构建 TypeScript 和原生 helper；源码、文档和 helper 一起分发，研究下载与依赖缓存不进入包；自建测试窗的验证证据随文档分发。ARM64 构建可运行：

```powershell
powershell -NoProfile -File scripts/build-native.ps1 -Runtime win-arm64
```

## GitHub 源码仓库

仓库保留源码、测试、文档和依赖锁文件。`node_modules/`、`lib/`、原生构建目录与 NuGet 缓存均由 `.gitignore` 排除；克隆后运行 `npm ci` 和 `npm run build:all` 即可重新生成。`npm pack` 会先完整构建，再将运行所需的 helper 和 .NET 运行时打入安装包；生成的 `.tgz` 可作为 GitHub Release 附件分发。

## 实现能力


| 能力                           | 实现                                                                              |
| ------------------------------ | --------------------------------------------------------------------------------- |
| 应用与窗口发现/启动            | Win32 窗口枚举、进程身份、App Paths 和 AppsFolder                                 |
| 窗口截图与遮挡窗口             | Windows.Graphics.Capture + Direct3D/WinRT，PNG 编码；包含关联弹窗截图             |
| UI 结构与文字                  | UI Automation 控件树、元素索引、焦点、选中文字、选中项、文档文字                  |
| 点击、组合键、文字、滚动、拖拽 | `SendInput`，Unicode 输入，DPI aware 多显示器坐标转换及目标命中检查               |
| 控件值与辅助动作               | UIA Value/Text、Invoke、Toggle、Selection、Expand/Collapse、Scroll 等可用 pattern |
| 模型截图                       | 复用 Harness 官方 MCP 工具适配器，核对模型图像能力并存储持久化附件                |
| 状态与资源                     | 单次观察令牌、会话绑定、桌面串行、动作后刷新、取消/超时、卸载等待资源停止         |

所有模型输入必须携带最新 `observation_id`；坐标动作还需 `screenshotId`。每次输入自动刷新状态，下一步只能使用返回的新观察。原生 helper 再检查 HWND、PID、进程启动时间、窗口位置、元素身份和前台目标。输入结果不确定时不会自动重试。

模型工具的规范返回值采用 Harness MCP 格式：`structuredContent` 是操作结果；截图作为 `content` 中的图片投影进入模型上下文。普通状态位于 `structuredContent`，输入后的状态位于 `structuredContent.state`。Base64 不作为模型文字输出。

## 配置

```yaml
- insert:
    - id: cpuse
      name: dsh-plugin-cpuse
      config:
        approvalMode: always
        screenshots: true
        allowPrintWindowFallback: false
        timeoutMs: 30000
        observationTtlMs: 30000
        allowedApps: []
        deniedApps: []
```

- `approvalMode: always`：读取某应用之前审批；每次输入、启动和切换前台再走宿主审批。`app` 则在插件生命周期内按 agent/应用记住审批。实际批准/拒绝仍由 Harness 的审批服务决定，缺少该服务时需要审批的操作不会执行。
- `allowedApps` / `deniedApps`：使用枚举返回的精确应用标识，忽略大小写和路径分隔符差异。空允许列表不限制普通应用。终端、锁屏和部分敏感应用为内置排除项。
- `screenshots: false`：供没有图像输入的模型使用 UIA 文字。没有图像能力的模型不会因为安装本插件而获得视觉理解；画布等弱 UIA 应用需要视觉模型。
- `allowPrintWindowFallback: true`：WGC 失败时允许 PrintWindow 降级，结果明确报告实际后端与原因。某些 GPU 内容可能不完整；默认关闭。
- `helperPath`：可信配置可指定已构建 helper 的绝对路径；模型工具不能更改它。

Windows 输入运行在已解锁的活动桌面，会移动指针和改变前台焦点。管理员应用受 Windows UIPI 限制；受保护内容、最小化窗口和应用自身的无障碍实现可能限制截图或控件操作。桌面操作过程中的人为干预和应用异步变化无法完全消除，需检查每次返回状态。

宿主已挂载 `computerUse` 登记服务时，插件占用其唯一提供者槽，原生进程及截图投影停止后才释放。没有该服务的自定义组合中，本插件的串行队列只约束自身实例，请保持只启用一个桌面控制提供者。

审批是执行门槛，不能自动识别每个按钮的业务含义。插件提示要求模型遵循用户范围并在发送、删除、付款或分享等动作前取得用户批准；界面内容不能被当作授权。建议在需要独立工作的场景使用专用 Windows 会话或虚拟机。

## 测试与资料

```powershell
npm test             # 类型构建、协议/控制器测试、真实 Cordis/审批/附件投影集成
npm run test:native  # 原生能力诊断，不发送桌面输入
npm run test:desktop # 自建测试窗，实际验证输入、UIA、WGC/遮挡；占用前台
```

验证记录与限制见 [验证结果](docs/verification-results.md)；参数及本地 JavaScript facade 见 [API](docs/api.md)；架构和来源见 [移植规范](docs/porting.md)；故障定位见 [验证指南](docs/verification.md)。没有模型凭据的情况下，不会把模拟视觉模型的测试描述为在线模型端到端验收。

兼容性依据：[Harness 0.2.0-rc.2 发布包](https://www.npmjs.com/package/@deepseek-ai/dsh/v/0.2.0-rc.2)、[同版本工具 SDK](https://www.npmjs.com/package/@deepseek-ai/dsh-tools/v/0.2.0-rc.2)、[同版本 MCP 图片适配器](https://www.npmjs.com/package/@deepseek-ai/dsh-mcp-client/v/0.2.0-rc.2)。官方教程用于说明开发流程，实际接口以目标发布包为准；固定源码依据见移植说明。Windows window2 接口参考本机 Computer Use 插件公开文档与 [OpenAI Computer Use 文档](https://learn.chatgpt.com/docs/computer-use)。
