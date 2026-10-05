# 本次验证记录

验证日期：2026-10-04。测试仅使用协议 fixture、假后端、内存附件存储和插件自建的 Windows 测试窗口；没有操作用户现有应用。

## Node 与 Harness

插件版本 `0.1.1` 在 Node.js `v24.19.0`、npm `11.17.0`、Cordis `4.0.4`、Schemastery `3.18.4` 和 **Harness `0.2.0-rc.2`** 发布包组合上重新执行：

```powershell
npm test
```

TypeScript 构建成功，61 项测试通过，0 失败、0 跳过。所有直接依赖的 `@deepseek-ai/dsh-*` 包均精确锁定为 `0.2.0-rc.2`，锁文件与实际运行环境审核记录见 [rc2-sdk-verification.json](test-artifacts/rc2-sdk-verification.json)。

| 测试文件 | 通过数 | 覆盖范围 |
|---|---:|---|
| `tests/validation.test.mjs` | 10 | 参数、定位模式、观察令牌、键名限制、文字与坐标边界 |
| `tests/controller.test.mjs` | 20 | 窗口枚举、应用过滤、会话/观测绑定、过期状态、失败后恢复、全局串行、跨控制器输入使旧状态失效 |
| `tests/backend.test.mjs` | 10 | 实际 Node 子进程 JSONL、分块/乱序、错误、退出、超时、取消、关闭 |
| `tests/client.test.mjs` | 6 | JavaScript facade 缓存与自动传令牌、动作后新状态、纯文本模式、失败无重试 |
| `tests/plugin.test.mjs` | 15 | 真实 Cordis/Harness 工具注册与卸载、提示词、审批与会话绑定、图像附件投影、取消、异步资源关闭和提供者独占 |

15 项 Harness 接入测试在目标 `0.2.0-rc.2` 依赖上全部通过，使用真实 ToolRuntime、SystemPrompt、ApprovalService、Session 与 LlmRuntime；仅替换原生调用和附件存储。它验证结果包含持久化图像引用及模型路由图像能力准入，但未向在线模型发送请求。

## Windows 原生后端

本次适配调整 Harness 依赖组合，Windows 原生后端未改动。重新运行 `npm run test:native` 后，自检返回 `ok=true`、`inputStructBytes=40`；本次执行环境报告 `screenshot_backend=unavailable`。这次自检验证原生入口与协议，不能代替真实桌面输入或截图验收。

以下保留同日已完成的 13 项原生检查与截图证据；该记录独立于 Harness SDK 版本，不将其描述为本次重新执行的桌面测试。

已直接运行自包含发布版 helper，在自建 WinForms 测试窗中执行了 13 项集成检查并全部通过；键盘组合与拖动采用配对的原子 `SendInput` 批次，每次输入使用实际最新观察令牌，坐标输入引用实际截图 ID。最终原始报告为 [native-integration-results.json](test-artifacts/native-integration-results.json)。

环境为 Windows NT `10.0.26200.0`、.NET `8.0.11`、X64、单显示器、测试窗 DPI `96`、Per Monitor V2 DPI 模式。已验证：

- 真实窗口与应用枚举、窗口身份重新取得、UIA 元素树与焦点字段。
- `set_value` 修改界面值，旧元素观察被拒绝。
- 真实鼠标点击、`Control_L+a`、中文/Ω/emoji 输入，UIA 读回匹配。
- RichTextBox 的 UIA TextPattern 文档文字与选中文字，以及多行、换行与 Tab 的 Unicode 输入均有实际读回断言。
- UIA `Invoke` 改变测试窗口状态，真实鼠标点击切换 CheckBox。
- WGC 返回真实 PNG，解码尺寸与元数据一致，截图原点与 DWM frame bounds 一致，非法坐标被拒绝。
- 另一个独立洋红窗口完全遮挡目标后，WGC 仍返回目标绿色像素；由此验证按目标窗口捕获。
- 滚轮输入使 UIA 文档位置实际移动，拖动事件到达测试窗。

原生截图证据：[正常 WGC](test-artifacts/fixture-wgc.png)、[完全遮挡目标后的 WGC](test-artifacts/fixture-occluded-wgc.png)。两张图均为插件自建测试窗内容。

混合 DPI/多屏、PrintWindow 降级、管理员应用、锁屏、受保护/最小化窗口仍需要各自的明确断言或合适主机条件。`launch_app` 已实现并经过参数与插件审批测试，但没有单独执行该工具启动第三方应用的端到端检查。

## 尚未证明的范围

没有运行在线视觉模型的端到端任务，也没有对任意第三方 Windows 应用作兼容性保证。无障碍信息取决于应用提供者，系统权限和图形会话限制仍然适用。上述测试不能用来声明与 Codex 私有运行时在所有细节上等价。
