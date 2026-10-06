import { ComputerUseError, type Method, type WindowRef } from './types.js';
import { riskCategories } from './risk.js';

const fail = (message: string): never => { throw new ComputerUseError('INVALID_ARGUMENT', message); };
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('Expected an argument object.');
  return value as Record<string, unknown>;
}
export function string(value: unknown, field: string, max = 100_000): string {
  if (typeof value !== 'string' || !value.length || value.length > max || value.includes('\0')) return fail(`${field} must be a nonempty string of at most ${max} characters without NUL.`);
  return value;
}
export function number(value: unknown, field: string, min = -100_000, max = 100_000, integer = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) return fail(`${field} is outside its allowed range.`);
  return value;
}
export function windowRef(value: unknown): WindowRef {
  const target = record(value);
  return { id: number(target.id, 'window.id', 1, Number.MAX_SAFE_INTEGER, true), app: string(target.app, 'window.app', 4096) };
}
export function validate(method: Method, value: unknown): Record<string, unknown> {
  const args = record(value);
  const output: Record<string, unknown> = {};
  // Approval metadata is validated, but never forwarded as native input parameters.
  if (args.intent !== undefined) string(args.intent, 'intent', 256);
  if (args.risk !== undefined && (typeof args.risk !== 'string' || !riskCategories.includes(args.risk as typeof riskCategories[number]))) fail('Invalid risk category.');
  if (!['list_apps', 'list_windows', 'find_window', 'launch_app', 'get_window', 'capabilities'].includes(method)) output.window = windowRef(args.window);
  if (method === 'find_window') output.query = string(args.query, 'query', 256);
  if (method === 'get_window') {
    output.id = number(args.id, 'id', 1, Number.MAX_SAFE_INTEGER, true);
    if (args.app !== undefined) output.app = string(args.app, 'app', 4096);
  }
  if (method === 'launch_app') output.app = string(args.app, 'app', 4096);
  if (method === 'get_window_state') {
    for (const key of ['include_screenshot', 'include_text']) {
      if (args[key] !== undefined) { if (typeof args[key] !== 'boolean') fail(`${key} must be boolean.`); output[key] = args[key]; }
    }
  }
  if (['click', 'press_key', 'type_text', 'scroll', 'set_value', 'drag', 'perform_secondary_action'].includes(method)) {
    output.observation_id = string(args.observation_id, 'observation_id', 256);
  }
  if (['click', 'scroll', 'drag'].includes(method) && args.screenshotId !== undefined) output.screenshotId = string(args.screenshotId, 'screenshotId', 256);
  if (method === 'click') {
    const indexed = args.element_index !== undefined;
    const coordinate = args.x !== undefined || args.y !== undefined;
    if (indexed === coordinate) fail('click requires either element_index or both x and y.');
    if (indexed) output.element_index = number(args.element_index, 'element_index', 0, 100_000, true);
    else { output.x = number(args.x, 'x', 0); output.y = number(args.y, 'y', 0); output.screenshotId = string(args.screenshotId, 'screenshotId', 256); }
    if (args.click_count !== undefined) output.click_count = number(args.click_count, 'click_count', 1, 3, true);
    if (args.mouse_button !== undefined) {
      if (!['left', 'right', 'middle', 'l', 'r', 'm'].includes(String(args.mouse_button))) fail('Invalid mouse_button.');
      output.mouse_button = args.mouse_button;
    }
  }
  if (method === 'press_key') {
    output.key = string(args.key, 'key', 256);
    if (String(output.key).split('+').some(key => /^(meta|windows|win|cmd|command|super|os)(_[lr])?$/i.test(key.trim()))) fail('Windows/system key shortcuts are disabled.');
    if (args.mode !== undefined) {
      if (typeof args.mode !== 'string' || !['virtual-key', 'scan-code'].includes(args.mode)) fail('mode must be virtual-key or scan-code.');
      output.mode = args.mode;
    }
  }
  if (method === 'type_text') {
    output.text = string(args.text, 'text');
    if (args.method !== undefined) {
      if (typeof args.method !== 'string' || !['unicode', 'paste'].includes(args.method)) fail('method must be unicode or paste.');
      output.method = args.method;
    }
  }
  if (method === 'scroll') {
    output.x = number(args.x, 'x', 0); output.y = number(args.y, 'y', 0);
    output.scrollX = number(args.scrollX, 'scrollX', -10_000, 10_000);
    output.scrollY = number(args.scrollY, 'scrollY', -10_000, 10_000);
    output.screenshotId = string(args.screenshotId, 'screenshotId', 256);
  }
  if (method === 'drag') {
    for (const key of ['from_x', 'from_y', 'to_x', 'to_y']) output[key] = number(args[key], key, 0);
    output.screenshotId = string(args.screenshotId, 'screenshotId', 256);
  }
  if (['set_value', 'perform_secondary_action'].includes(method)) output.element_index = number(args.element_index, 'element_index', 0, 100_000, true);
  if (method === 'set_value') {
    if (args.value === '') output.value = ''; else output.value = string(args.value, 'value');
  }
  if (method === 'perform_secondary_action') output.action = string(args.action, 'action', 100);
  return output;
}
