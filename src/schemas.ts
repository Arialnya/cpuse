import type { ParameterSchemaSpec } from '@deepseek-ai/dsh-tools';
import type { Method } from './types.js';
const window = { type: 'object', additionalProperties: false, required: true,
  properties: { id: { type: 'integer', required: true }, app: { type: 'string', required: true }, title: { type: 'string' } },
} as const;
const observation = { type: 'string', required: true, description: 'Exact observation_id from the latest state returned in this session.' } as const;
const screenshot = { type: 'string', description: 'Exact screenshot id from that observation; coordinates use its original pixel size.' } as const;
const coordinate = { type: 'number' } as const;
const requiredCoordinate = { type: 'number', required: true } as const;
export const schemas: Record<Method, ParameterSchemaSpec> = {
  list_apps: {}, list_windows: {}, capabilities: {},
  find_window: { query: { type: 'string', required: true, description: 'Actual title/process name or a configured alias. Searches only real discovered windows; never supplies a handle.' } },
  get_window: { id: { type: 'integer', required: true }, app: { type: 'string' } },
  launch_app: { app: { type: 'string', required: true, description: 'Returned app id or absolute .exe path. No arguments or shell commands.' } },
  get_window_state: { window, include_screenshot: { type: 'boolean' }, include_text: { type: 'boolean' } },
  activate_window: { window },
  click: { window, observation_id: observation, element_index: { type: 'integer' }, x: coordinate, y: coordinate,
    screenshotId: screenshot, click_count: { type: 'integer' }, mouse_button: { type: 'string', enum: ['left','right','middle','l','r','m'] } },
  press_key: { window, observation_id: observation, key: { type: 'string', required: true, description: 'Keysym or chord, e.g. Control_L+a, Return, KP_0. Windows key is disabled.' }, mode: { type: 'string', enum: ['virtual-key', 'scan-code'], description: 'Explicit scan-code mode for game controls; no automatic replay if a key is ignored.' } },
  type_text: { window, observation_id: observation, text: { type: 'string', required: true }, method: { type: 'string', enum: ['unicode', 'paste'], description: 'unicode is default. paste is an explicit clipboard transaction and requires host allowClipboardPaste. Never replay unverified input using another method.' } },
  scroll: { window, observation_id: observation, screenshotId: { ...screenshot, required: true }, x: requiredCoordinate, y: requiredCoordinate,
    scrollX: { type: 'number', required: true }, scrollY: { type: 'number', required: true } },
  set_value: { window, observation_id: observation, element_index: { type: 'integer', required: true }, value: { type: 'string', required: true } },
  drag: { window, observation_id: observation, screenshotId: { ...screenshot, required: true },
    from_x: requiredCoordinate, from_y: requiredCoordinate, to_x: requiredCoordinate, to_y: requiredCoordinate },
  perform_secondary_action: { window, observation_id: observation, element_index: { type: 'integer', required: true }, action: { type: 'string', required: true } },
};
export const descriptions: Record<Method, string> = {
  list_apps: 'Discover installed/running Windows applications and their targetable windows. Select a returned app/window before acting.',
  list_windows: 'Discover currently targetable windows, including dialogs. Select exactly one target.',
  find_window: 'Find a real visible window by title or process, including games with empty titles. Returns candidates and a bounded recovery instruction if none match. Chinese Slay the Spire 2 alias is supported.',
  get_window: 'Rehydrate a previously discovered window, checking its process identity.',
  launch_app: 'Launch an installed app or explicit executable, then rediscover its windows.',
  get_window_state: 'Observe the selected window: bounded PNG screenshots, indexed accessibility tree, focus, selected text and document text. Defaults to both image and text.',
  click: 'Click an observed accessibility index OR original screenshot-relative x,y. Returns refreshed state.',
  press_key: 'Send one keysym key/chord to the selected window; returns refreshed state.',
  type_text: 'Insert literal text into a verified non-password focus. Inspect receipt and refreshed state: queued input is not proof the application accepted it. Use press_key for game controls.',
  scroll: 'Scroll at an observed window-relative point; positive Y is down, positive X is right. Returns refreshed state.',
  set_value: 'Replace an observed editable UIA element value (including clearing it); returns refreshed state.',
  drag: 'Drag between two observed window-relative points; returns refreshed state.',
  perform_secondary_action: 'Invoke a named secondary accessibility action shown in the tree; returns refreshed state.',
  activate_window: 'Bring a discovered window to the foreground, invalidate prior observation and return fresh state.',
  capabilities: 'Report actual backend, supported operations, screenshot support and platform limitations.',
};
