# cpuse · DeepSeek Harness Windows 电脑控制插件

> **⚠️ 这是 vibe coding 作品，稳定性不保证**
>
> 本项目是 dsh 桌面端插件，代码由 AI 在对话中生成与迭代，作者负责提出需求、验证结果和把握方向，而非逐行手写。它能正常运行，也通过了仓库内的 `npm test` 与 `npm run test:native`，但**不保证稳定**：内部实现、配置项和行为都可能在没有预告的情况下变化，边界场景（混合 DPI 多显示器、提权应用、弱 UIA 应用、GPU 内容截图等）覆盖有限，未实测的部分不应假定可用。
>
> 它还会**真实移动鼠标、切换前台窗口、发送键盘输入**。请只在能接受误操作风险的环境中使用，重要操作前先备份，生产环境默认别用。

按 Codex Windows Computer Use 的原理独立实现：枚举应用/窗口 → UI Automation 与窗口截图观察 → 向绑定窗口发送输入 → 返回新状态验证。包含全部 13 项公开 window2 操作，以及 `find_window` 搜索和 `capabilities` 诊断工具。

这是使用公开 Windows API 编写的实现，不依赖 Codex 安装、`@oai/sky` 或其私有 helper。适用 Windows 10 19041+ / Windows 11；浏览器可作为普通窗口控制。Codex 的私有实现、DOM 浏览器接口和 macOS 后端不在本包内。

当前源码版本 **0.1.3**，更新内容见 [CHANGELOG](CHANGELOG.md)。安装问题见 [安装指南](docs/installation.md)，游戏窗口定位见 [游戏窗口指南](docs/game-windows.md)。预构建包以 [GitHub Releases](https://github.com/Arialnya/cpuse/releases) 中实际发布的资产为准。

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

### 从 GitHub Release 安装（推荐：校验下载，免构建）

Release 的 `.tgz` 包含编译好的 JS 与自包含 Windows x64 helper。使用脚本下载明确版本，核对 GitHub 资产的 SHA-256 和大小后，再把输出的绝对路径粘贴到 DSH「插件 → 安装」：

```powershell
# 在本仓库目录中执行；0.1.1 是已经发布的旧版，新版本发布后换成对应版本号
node scripts/download-release.mjs --version 0.1.1 --out-dir "$env:USERPROFILE\Downloads\cpuse"
```

下载脚本不修改 profile、不执行下载包中的代码。已校验 `.tgz` 应保留，供 profile 重装使用；安装预构建包无需 .NET SDK，也无需放行插件构建脚本。浏览器手动下载时，请先与该 Release 的可信 SHA-256 校验值核对。

`ERR_PNPM_MISSING_TARBALL_INTEGRITY` 是 pnpm 锁文件里远程 tarball 缺少预期摘要，不能据此判断网络失败。已在干净目录用 pnpm **11.22.0** 验证旧版 GitHub URL 安装和随后 frozen/offline 重装成功；用户宿主的自带 pnpm 与旧锁文件可能产生不同结果。使用已校验本地包可避开远程 URL 的摘要解析问题，同时保留下载校验和宿主供应链策略。已有损坏锁文件可用 `scripts/repair-lockfile.mjs` 定点修复：先核对可信 SHA-256、预览，再备份原锁并只补该包的 SHA-512；不会删除整锁或放松供链策略。完整命令、验证结果与边界见 [安装指南](docs/installation.md)。

### 从 npm registry 安装（发布后可用）

发布到 npm registry 后，可以在安装框中指定 `dsh-plugin-cpuse@<version>`。Registry 元数据携带 tarball 完整性摘要；本仓库尚不以未发布包名作为有效安装方式。

### 从 git 源安装（需要本机 .NET SDK）

仓库 URL 指向源码，不包含 `lib/`。pnpm 11 可能要求显式批准源码包的 `prepack`，本机还需要 .NET SDK 和 npm/NuGet 网络。请仅按宿主显示的精确构建批准提示操作，不配置全局允许所有构建。普通用户优先安装预构建 Release 包。

## GitHub 源码仓库

仓库保留源码、测试、文档和依赖锁文件；生成目录与缓存由 `.gitignore` 排除。发布前运行 `npm pack`，再运行 `node scripts/release-manifest.mjs .\dsh-plugin-cpuse-<version>.tgz` 检查预编译运行时并生成 SHA-256/SHA-512 校验附件。将 `.tgz`、`.tgz.sha256` 和 `.tgz.release.json` 上传到对应版本的 GitHub Release；更新代码后使用新版本号，不覆盖旧版包。详细发布和安装检查见 [安装指南](docs/installation.md)。

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
        approvalMode: risk
        screenshots: true
        allowPrintWindowFallback: false
        allowClipboardPaste: false
        timeoutMs: 30000
        observationTtlMs: 30000
        allowedApps: []
        deniedApps: []
        trustedApps: []
        windowAliases: []
```

- `approvalMode: risk`（0.1.3 默认）：普通观察、启动 Steam 等应用、激活、导航、搜索、滚动和游戏输入不请求审批。购买/支付、删除、发送、上传、共享、权限变更、敏感信息及无法判定的操作逐次请求审批，批准不缓存。模型为每次输入提供 `intent`；插件另查当前绑定观察中的控件名称、坐标命中与部分快捷键。详情与升级配置见 [审批策略](docs/approval.md)。
- `approvalMode: always`：保留旧的逐输入审批；`app` 则在插件生命周期内按 agent/应用记住审批。旧 profile 中显式的 `always` 不会因升级自动变成 `risk`。是否弹窗仍取决于 Harness 的 `ask/never/always` 策略；上游明确拒绝保持生效，缺少审批服务时高危操作不执行。
- `allowedApps` / `deniedApps`：使用枚举返回的精确应用标识，忽略大小写和路径分隔符差异。空允许列表不限制普通应用。终端、锁屏和部分敏感应用为内置排除项。
- `trustedApps`：仅在旧 `always/app` 模式中免除该应用的审批；在 `risk` 模式中**不能跳过高危审批**。拒绝列表、内置排除项、窗口身份和输入暂停仍生效。通常无需为了自主启动 Steam 将它列为 trusted。
- `screenshots: false`：供没有图像输入的模型使用 UIA 文字。没有图像能力的模型不会因为安装本插件而获得视觉理解；画布等弱 UIA 应用需要视觉模型。
- `allowPrintWindowFallback: true`：WGC 失败时允许 PrintWindow 降级，结果明确报告实际后端与原因。某些 GPU 内容可能不完整；默认关闭。PrintWindow 失败时停止截图，不会自动激活窗口或复制可能包含其他应用内容的桌面区域。
- `helperPath`：可信配置可指定已构建 helper 的绝对路径；模型工具不能更改它。
- `allowClipboardPaste: true`：允许显式 `type_text(method: paste)`，用于不接受 Unicode 键事件的文本控件。仅在能够完整保存剪贴板内容时执行一次粘贴，再保守恢复；并发修改时不覆盖新内容。默认关闭，模型不能自行打开，也不会在结果不明后自动换成粘贴。helper 被强制终止时可能无法恢复临时剪贴板，第三方剪贴板监听也不能完全排除，按需由用户启用。
- `windowAliases`：为实际窗口标题/进程配置搜索别名，例如 `[{name: 我的游戏, terms: [ActualGameProcess]}]`。别名不授予权限，也不创建窗口句柄。内置支持“杀戮尖塔2”与 `Slay the Spire 2` 的搜索对应。

Windows 输入运行在已解锁的活动桌面，会移动指针和改变前台焦点。管理员应用受 Windows UIPI 限制；受保护内容、最小化窗口和应用自身的无障碍实现可能限制截图或控件操作。桌面操作过程中的人为干预和应用异步变化无法完全消除，需检查每次返回状态。

宿主已挂载 `computerUse` 登记服务时，插件占用其唯一提供者槽，原生进程及截图投影停止后才释放。没有该服务的自定义组合中，本插件的串行队列只约束自身实例，请保持只启用一个桌面控制提供者。

## 输入被系统拒绝时

`computer_use_capabilities` 的 `input_injection: target-dependent` 表示需要逐目标检查。能够移动鼠标不证明可以向任意应用输入；Windows 把事件放进队列也不证明应用已经消费。`get_window_state` 的 `input` 会报告 helper/目标完整性等级、实际焦点和可用输入模式。

- `INPUT_TARGET_BLOCKED` / `INPUT_IDENTITY_UNAVAILABLE`：目标权限不兼容或无法可靠检查；停止该窗口的输入并报告用户。
- `INPUT_NOT_ACCEPTED` / `INPUT_PARTIAL` / `INPUT_OUTCOME_UNKNOWN`：未确认文本改变、部分入队或结果不明；只观察，不自动重放、换方式重放或假装成功。
- `INPUT_PAUSED`：该会话/窗口的失败输入通道已暂停。刷新截图、重新枚举或改文本方法都不能解除；用户完成诊断后可以重载插件。

错误不会授权模型调用终端、提权、修改安全标签、改审批/`trustedApps`，或换用其他注入程序。观察和其他目标仍可用；UIA 操作也要通过其自身的控件与权限检查。

### 游戏窗口（包括《杀戮尖塔 2》）

先调用 `computer_use_find_window`，参数为 `{"query":"杀戮尖塔2"}`，从实际返回候选选择窗口。无标题的可见窗口也会返回真实进程名和窗口类；没有匹配时请用户启动/显示游戏，不用 Steam AppID 或进程猜测创建 HWND。

游戏通常没有可编辑的 UIA 文本，先用 `get_window_state(include_text:false, include_screenshot:true)` 看画面，再做截图坐标点击或 `press_key(mode:scan-code)`。缺少 UIA 不代表需要提权；`type_text` 不是游戏按键。每步检查画面效果，`queued_unverified` 仅代表已入队。独占全屏、Raw Input、输入过滤器和更高权限目标仍可能需要用户选择窗口化/无边框模式或人工操作，插件不会绕过这些限制。详见 [游戏窗口排查](docs/game-windows.md)。

审批是执行门槛，不能自动识别每个按钮的业务含义。插件提示要求模型遵循用户范围并在发送、删除、付款或分享等动作前取得用户批准；界面内容不能被当作授权。建议在需要独立工作的场景使用专用 Windows 会话或虚拟机。

## 测试与资料

```powershell
npm test             # 类型构建、协议/控制器测试、真实 Cordis/审批/附件投影集成
npm run test:native  # 原生能力诊断，不发送桌面输入
npm run test:desktop # 自建测试窗，实际验证输入、UIA、WGC/遮挡；占用前台
```

验证记录与限制见 [验证结果](docs/verification-results.md)；参数及本地 JavaScript facade 见 [API](docs/api.md)；架构和来源见 [移植规范](docs/porting.md)；故障定位见 [验证指南](docs/verification.md)。没有模型凭据的情况下，不会把模拟视觉模型的测试描述为在线模型端到端验收。

兼容性依据：[Harness 0.2.0-rc.2 发布包](https://www.npmjs.com/package/@deepseek-ai/dsh/v/0.2.0-rc.2)、[同版本工具 SDK](https://www.npmjs.com/package/@deepseek-ai/dsh-tools/v/0.2.0-rc.2)、[同版本 MCP 图片适配器](https://www.npmjs.com/package/@deepseek-ai/dsh-mcp-client/v/0.2.0-rc.2)。官方教程用于说明开发流程，实际接口以目标发布包为准；固定源码依据见移植说明。Windows window2 接口参考本机 Computer Use 插件公开文档与 [OpenAI Computer Use 文档](https://learn.chatgpt.com/docs/computer-use)。
