export interface WindowRef { id: number; app: string; title?: string }
export interface AppInfo { id: string; displayName?: string; isRunning?: boolean; windows: WindowRef[] }
export interface Screenshot {
  id: string; url: string; width: number; height: number;
  originX: number; originY: number; zIndex: number; capture_backend?: string;
}
export interface AccessibilityState {
  tree: string; document_text?: string; focused_element?: string;
  selected_elements?: string[]; selected_text?: string;
}
export interface WindowState {
  window: WindowRef; observation_id: string; captured_at?: string;
  accessibility: AccessibilityState | null; screenshots: Screenshot[];
}
export interface Backend {
  call<T = unknown>(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<T>;
  close(): void | Promise<void>;
}
export class ComputerUseError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'ComputerUseError'; }
}
export const actions = new Set(['click', 'press_key', 'type_text', 'scroll', 'set_value', 'drag', 'perform_secondary_action']);
export const methods = ['list_apps', 'list_windows', 'get_window', 'launch_app', 'get_window_state',
  'click', 'press_key', 'type_text', 'scroll', 'set_value', 'drag', 'perform_secondary_action',
  'activate_window', 'capabilities'] as const;
export type Method = typeof methods[number];
