export interface WindowRef {
  id: number; app: string; title?: string;
  process_name?: string; class_name?: string; is_minimized?: boolean; is_foreground?: boolean;
}
export interface InputState {
  injection: 'allowed' | 'blocked' | 'unknown'; reason?: string;
  helper_integrity?: string; target_integrity?: string;
  focus: { source: 'uia' | 'win32' | 'none'; in_window: boolean; password: 'yes' | 'no' | 'unknown'; can_type: boolean };
  text_methods: ('unicode' | 'paste')[];
  key_modes?: ('virtual-key' | 'scan-code')[];
}
export interface InputReceipt {
  method: string; status: 'text_changed' | 'queued_unverified'; events_queued?: number; retry_safe: false;
}
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
  input?: InputState;
}
export interface Backend {
  call<T = unknown>(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<T>;
  close(): void | Promise<void>;
}
export class ComputerUseError extends Error {
  constructor(public readonly code: string, message: string, public readonly details?: {
    native_request_dispatched?: boolean; input_outcome?: 'not_sent' | 'unknown'; original_code?: string;
  }) { super(message); this.name = 'ComputerUseError'; }
}
export const actions = new Set(['click', 'press_key', 'type_text', 'scroll', 'set_value', 'drag', 'perform_secondary_action']);
export const methods = ['list_apps', 'list_windows', 'find_window', 'get_window', 'launch_app', 'get_window_state',
  'click', 'press_key', 'type_text', 'scroll', 'set_value', 'drag', 'perform_secondary_action',
  'activate_window', 'capabilities'] as const;
export type Method = typeof methods[number];
