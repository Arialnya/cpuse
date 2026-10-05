import { ComputerUseError, type Method, type WindowRef } from './types.js';

const readMethods = ['find_window', 'list_windows', 'get_window_state', 'capabilities'];
const permissionFailures = new Set(['APP_DENIED', 'SYSTEM_KEY_FORBIDDEN', 'PASSWORD_INPUT_FORBIDDEN',
  'INPUT_BLOCKED', 'INPUT_TARGET_BLOCKED', 'INPUT_IDENTITY_UNAVAILABLE', 'DESKTOP_LOCKED', 'INPUT_PAUSED', 'CLIPBOARD_DISABLED']);

/** No executable recovery commands and no typed text or clipboard contents in diagnostics. */
export function failureDiagnostic(error: ComputerUseError, method: Method, args: unknown) {
  const input = args && typeof args === 'object' ? args as { window?: WindowRef } : undefined;
  const focusFailure = ['FOCUS_UNKNOWN', 'FOCUS_FAILED', 'NO_ACCESSIBILITY'].includes(error.code);
  const uncertainty = error.details?.input_outcome === 'unknown';
  return {
    code: error.code, operation: method,
    target: input?.window ? { id: input.window.id, app: input.window.app } : undefined,
    message: error.message,
    native_request_dispatched: error.details?.native_request_dispatched ?? false,
    input_outcome: error.details?.input_outcome ?? 'not_sent',
    original_code: error.details?.original_code,
    recovery: {
      automatic_retry: false,
      human_required: permissionFailures.has(error.code) || uncertainty,
      next_action: permissionFailures.has(error.code) || uncertainty ? 'stop_input_and_report' : focusFailure ? 'observe_then_select_focus_once' : 'reobserve_before_another_action',
      allowed_methods: focusFailure ? [...readMethods, 'click', 'press_key'] : readMethods,
      note: focusFailure
        ? 'A game/canvas may not expose editable UIA text. Use a fresh screenshot for window coordinates or press_key mode=scan-code for game controls; do not use type_text as a game key.'
        : uncertainty ? 'The application may already have received some or all input. Verify the visible state; do not repeat the same input or switch injection methods to replay it.'
        : 'An input failure does not grant additional permissions. Use only the configured plugin methods and report a blocked target to the human.',
      forbidden_recovery: ['elevate_process', 'edit_security_labels', 'change_approval_or_trusted_apps', 'launch_terminal', 'alternate_input_helper'],
    },
  };
}
