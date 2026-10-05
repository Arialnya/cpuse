# 工具与 JavaScript API

本文适用于 DeepSeek Harness **0.2.0-rc.2**。Harness 模型工具使用 `computer_use_` 前缀；JavaScript 客户端使用相同操作名，不带前缀。所有参数都是数据对象。应用标识和窗口对象取自枚举结果。

## 工具参数

`Window` 至少为 `{ id: number, app: string, title?: string }`，发现结果还可含 `process_name`、`class_name`、`is_minimized`、`is_foreground`。`observation_id` 为本会话最近一次观察返回的字符串。以下表中“窗口”表示必填 `window: Window`，“观察”表示必填 `observation_id`。

| 操作 | 参数 | 结果 |
|---|---|---|
| `list_apps` | `{}` | 应用数组，每项含 `id` 和 `windows` |
| `list_windows` | `{}` | 窗口数组 |
| `find_window` | `query` | `{query,matched,ambiguous,windows,next_action,note}`；候选全部来自真实枚举 |
| `get_window` | `id`、可选 `app` | 已枚举窗口的当前对象 |
| `launch_app` | `app` | 启动后重新枚举的提示 |
| `get_window_state` | 窗口；可选 `include_screenshot`、`include_text` | `WindowState` |
| `click` | 窗口、观察；`element_index` 或 `x,y,screenshotId`；可选 `click_count`、`mouse_button` | `{success:true,state:WindowState}` |
| `press_key` | 窗口、观察、`key`；可选 `mode: virtual-key/scan-code` | 同上，可含 `receipt` |
| `type_text` | 窗口、观察、`text`；可选 `method: unicode/paste` | 同上，含输入 `receipt`；paste 需可信配置允许 |
| `scroll` | 窗口、观察、`screenshotId,x,y,scrollX,scrollY` | 同上 |
| `set_value` | 窗口、观察、`element_index,value` | 同上 |
| `drag` | 窗口、观察、`screenshotId,from_x,from_y,to_x,to_y` | 同上 |
| `perform_secondary_action` | 窗口、观察、`element_index,action` | 同上 |
| `activate_window` | 窗口 | 同上；旧观察失效 |
| `capabilities` | `{}` | 当前后端能力与限制 |

点击只能选择一种定位方式；坐标方式必须同时提供 `x`、`y` 和 `screenshotId`。`click_count` 为 1–3，鼠标按钮为 `left/right/middle` 或 `l/r/m`。滚动的正 Y 表示向下，正 X 表示向右。`set_value` 的空字符串表示清空控件。`press_key` 使用 `Return`、`Tab`、`Control_L+a`、`Control_L+Shift_L+period`、`KP_0` 等键名；系统键组合被拒绝。

默认观察同时取得截图和 UIA 文本。显式关闭文本会使元素索引动作不可用；`type_text` 要求确认目标内非密码文本焦点。游戏按键不要求 UIA 文本树，显式 `mode: scan-code` 按目标键盘布局发送物理扫描码。文本模式可以关闭截图，但坐标输入仍需要真实截图身份。

`WindowState` 含 `window`、`observation_id`、可选 `captured_at`、`accessibility`、`screenshots` 和 `input`。`input` 报告 `injection`、helper/目标完整性、焦点来源和可用文本/按键模式。无障碍状态含索引树 `tree`、可选文档文本、焦点、选中项和选中文字。截图含 `id,width,height,originX,originY,zIndex`；原始 PNG data URL 在程序结果中可用，Harness 的模型结果改为附件图像。

动作结果的 `verification` 可为 `text_changed`、`queued_unverified` 或仅 `state_refreshed`。`receipt.retry_safe` 固定为 `false`；刷新成功不证明任务成功，必须检查可见状态。显式粘贴只执行一次，不自动从 Unicode 切换；无法完整保存剪贴板时拒绝，并发修改时保留新内容。helper 被强制终止可能来不及恢复临时剪贴板，因此该功能默认禁用，由用户按需启用。

## 模型工具调用示例

先调用 `computer_use_list_windows` 并选择结果中的对象，接着调用：

```json
{
  "window": { "id": 101, "app": "C:\\Apps\\editor.exe" },
  "include_text": true,
  "include_screenshot": true
}
```

查看该次 `computer_use_get_window_state` 返回的索引后，以它返回的实际令牌调用 `computer_use_click`：

```json
{
  "window": { "id": 101, "app": "C:\\Apps\\editor.exe" },
  "observation_id": "来自最新状态的实际值",
  "element_index": 4
}
```

这些 ID、令牌和索引只是格式示例，不能直接用作真实桌面的目标。下一次输入使用点击结果中的新 `state.observation_id`。

## 会话 JavaScript 客户端

客户端为可信本地程序提供 `sky` 风格 facade；不是任意模型代码执行工具。它缓存最新观察，并替调用方补上观察令牌；仅有一张截图时，也可自动补上坐标输入的截图 ID。

```js
import { createComputerUse } from 'dsh-plugin-cpuse/client';

const sky = createComputerUse({ screenshots: true });
try {
  const windows = await sky.list_windows();
  const target = windows.find(w => w.app === process.env.CPUSE_TARGET_APP);
  if (!target) throw new Error('目标应用未出现，请先启动并重新枚举。');
  const state = await sky.get_window_state({ window: target, include_text: true });
  // 读取 state.accessibility.tree，选择实际观察到的元素。
  console.log(state.accessibility?.tree);
  // 每个输入完成后，通过 sky.lastState 核实结果。
} finally {
  await sky.dispose();
}
```

各方法在最后一个参数接受 `AbortSignal`。输入方法返回 `void`，其自动刷新结果由 `sky.lastState` 读取。`activate_window` 也更新该状态。客户端调用不经过 Harness 的审批钩子，调用者负责在用户授权范围内使用它。

`createComputerUse` 的选项包括 `screenshots`、`allowPrintWindowFallback`、`allowClipboardPaste`、`windowAliases`、`allowedApps`、`deniedApps`、`observationTtlMs`、`timeoutMs` 和可信本地 `helperPath`。PrintWindow 降级默认关闭，启用后截图会标注实际后端和降级原因。应用列表使用大小写和路径分隔符规范化后的精确标识匹配，拒绝列表优先；内置排除项不能通过允许列表重新启用。

`trustedApps` 只影响插件注册工具时的审批钩子：列出的应用不发起宿主审批提问，输入和观察都直接放行，即使 Harness 的审批策略为 `never`。它不改变 `allowedApps`／`deniedApps` 的执行期校验，因此被拒绝的应用无法借助它执行。按应用放弃审批意味着模型可以无人确认地读取该应用窗口内容并操作其界面，请只列出确实需要无人值守的应用。

## 失败与恢复

参数错误在发送输入之前返回 `INVALID_ARGUMENT`。未枚举窗口返回 `UNKNOWN_WINDOW`，旧/异会话观察返回 `STALE_OBSERVATION`，异截图返回 `STALE_SCREENSHOT`，应用策略拒绝返回 `APP_DENIED`。

`capabilities` 报告 `process_integrity` 与 `input_injection`：`target-dependent` 表示还需逐目标检查，不能由 `SetCursorPos` 成功推断输入一定可用。`state.input` 的目标完整性检查不兼容时返回 `INPUT_TARGET_BLOCKED`，检查不可靠时返回 `INPUT_IDENTITY_UNAVAILABLE`。坐标输入在移动指针后核对 `GetCursorPos`，被丢弃的移动返回 `INPUT_DROPPED`；部分键事件入队返回 `INPUT_PARTIAL`，均不自动重试。

失败在 Harness 中仍为真正 `isError:true`，机器可读的 `error.info.code` 和内容中的 JSON 诊断含 `operation`、`input_outcome` 与 `recovery`，不包含输入文本或剪贴板内容。稳定阻断暂停该 owner/真实窗口的 SendInput 通道；部分输入、文本无可见变化和派发后通信失败暂停相应文本/按键/指针通道。刷新、枚举、切换文本方法不清除暂停，其他窗口、会话、读取和合法 UIA 操作不受该通道暂停影响。

动作后刷新失败返回 `REFRESH_FAILED`，它意味着输入可能已经完成。`ABORTED`、`TIMEOUT` 或 helper 退出后，重新枚举并观察；不要立即重复输入。原生层还会返回窗口关闭、身份改变、元素失效、前台失败和截图失败等原因。
