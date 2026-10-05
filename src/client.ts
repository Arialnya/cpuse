import { randomUUID } from 'node:crypto';
import { NativeBackend, type BackendOptions } from './backend.js';
import { Controller, type ControllerOptions } from './controller.js';
import { ComputerUseError, type AppInfo, type Method, type WindowRef, type WindowState } from './types.js';
import type { FindWindowResult } from './discovery.js';
export type { AppInfo, WindowRef, WindowState, Screenshot, AccessibilityState, InputState, InputReceipt } from './types.js';
export type { FindWindowResult, WindowAlias } from './discovery.js';

type WindowInput = { window: WindowRef };
type CoordinateInput = WindowInput & { x: number; y: number; screenshotId?: string };
export type ClickInput = WindowInput & { element_index?: number; x?: number; y?: number;
  screenshotId?: string; click_count?: number; mouse_button?: 'left' | 'right' | 'middle' | 'l' | 'r' | 'm' };

/** Persistent, typed sky-style facade for trusted local JavaScript programs. */
export class ComputerUseClient {
  readonly target = 'windows';
  private readonly controller: Controller;
  private readonly owner = randomUUID();
  private observed?: WindowState;
  constructor(options: BackendOptions & ControllerOptions = {}) {
    this.controller = new Controller(new NativeBackend(options), options);
  }
  get lastState() { return this.observed; }
  private async run<T>(method: Method, args: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    try {
      const result = await this.controller.execute(method, args, { owner: this.owner, signal });
      if (method === 'get_window_state') this.observed = result as WindowState;
      else if (result && typeof result === 'object' && 'state' in result) this.observed = result.state as WindowState;
      return result as T;
    } catch (error) { this.observed = undefined; throw error; }
  }
  private async input(method: Method, args: WindowInput & Record<string, unknown>, signal?: AbortSignal): Promise<void> {
    const state = this.observed;
    if (!state || state.window.id !== args.window.id || state.window.app !== args.window.app)
      throw new ComputerUseError('STALE_OBSERVATION', 'Observe this window first.');
    const parameters: Record<string, unknown> = { ...args, observation_id: state.observation_id };
    if (['click', 'scroll', 'drag'].includes(method) && parameters.element_index === undefined && parameters.screenshotId === undefined) {
      if (state.screenshots.length !== 1) throw new ComputerUseError('AMBIGUOUS_SCREENSHOT', 'Specify the observed screenshotId.');
      parameters.screenshotId = state.screenshots[0].id;
    }
    await this.run(method, parameters, signal);
  }
  list_apps(signal?: AbortSignal) { return this.run<AppInfo[]>('list_apps', {}, signal); }
  list_windows(signal?: AbortSignal) { return this.run<WindowRef[]>('list_windows', {}, signal); }
  find_window(input: { query: string }, signal?: AbortSignal) { return this.run<FindWindowResult>('find_window', input, signal); }
  get_window(input: { id: number; app?: string }, signal?: AbortSignal) { return this.run<WindowRef>('get_window', input, signal); }
  async launch_app(input: { app: string }, signal?: AbortSignal) { this.observed = undefined; await this.run('launch_app', input, signal); }
  get_window_state(input: WindowInput & { include_screenshot?: boolean; include_text?: boolean }, signal?: AbortSignal) {
    return this.run<WindowState>('get_window_state', input, signal);
  }
  click(input: ClickInput, signal?: AbortSignal) { return this.input('click', input, signal); }
  press_key(input: WindowInput & { key: string; mode?: 'virtual-key' | 'scan-code' }, signal?: AbortSignal) { return this.input('press_key', input, signal); }
  type_text(input: WindowInput & { text: string; method?: 'unicode' | 'paste' }, signal?: AbortSignal) { return this.input('type_text', input, signal); }
  scroll(input: CoordinateInput & { scrollX: number; scrollY: number }, signal?: AbortSignal) { return this.input('scroll', input, signal); }
  set_value(input: WindowInput & { element_index: number; value: string }, signal?: AbortSignal) { return this.input('set_value', input, signal); }
  drag(input: WindowInput & { from_x: number; from_y: number; to_x: number; to_y: number; screenshotId?: string }, signal?: AbortSignal) { return this.input('drag', input, signal); }
  perform_secondary_action(input: WindowInput & { element_index: number; action: string }, signal?: AbortSignal) { return this.input('perform_secondary_action', input, signal); }
  async activate_window(input: WindowInput, signal?: AbortSignal) { await this.run('activate_window', input, signal); }
  capabilities(signal?: AbortSignal) { return this.run<Record<string, unknown>>('capabilities', {}, signal); }
  dispose() { this.observed = undefined; return this.controller.dispose(); }
}
export const createComputerUse = (options?: BackendOptions & ControllerOptions) => new ComputerUseClient(options);
