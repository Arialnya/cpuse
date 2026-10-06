import { basename } from 'node:path';
import { actions, ComputerUseError, type AppInfo, type Backend, type InputReceipt, type Method, type WindowRef, type WindowState } from './types.js';
import { validate } from './validation.js';
import { findWindows, type WindowAlias } from './discovery.js';

export interface ControllerOptions {
  allowedApps?: string[]; deniedApps?: string[]; observationTtlMs?: number; screenshots?: boolean; allowPrintWindowFallback?: boolean;
  allowClipboardPaste?: boolean; windowAliases?: WindowAlias[];
}
export interface ExecutionContext { owner: string; signal?: AbortSignal }
const blocked = ['cmd.exe', 'powershell.exe', 'pwsh.exe', 'windowsterminal.exe', 'wt.exe', 'bash.exe', 'wsl.exe', 'conhost.exe',
  'lockapp.exe', 'credentialuibroker.exe', 'consent.exe', 'sechealthui.exe', 'keepass.exe',
  'keepassxc.exe', '1password.exe', 'bitwarden.exe'];
/** App identifiers compare case-insensitively and ignore path separator differences. */
export const normalizeAppId = (app: string) => app.replaceAll('/', '\\').toLowerCase();
const normalize = normalizeAppId;
const leaf = (app: string) => basename(app.replaceAll('\\', '/')).toLowerCase();
const injected = new Set<Method>(['click', 'press_key', 'type_text', 'scroll', 'drag']);
const blockedInput = new Set(['INPUT_BLOCKED', 'INPUT_TARGET_BLOCKED', 'INPUT_IDENTITY_UNAVAILABLE']);
const uncertainInput = new Set(['INPUT_NOT_ACCEPTED', 'INPUT_PARTIAL', 'INPUT_OUTCOME_UNKNOWN', 'INPUT_DROPPED', 'CLIPBOARD_CHANGED']);
const transportFailures = new Set(['ABORTED', 'TIMEOUT', 'HELPER_EXITED', 'HELPER_FAILED', 'PROTOCOL_ERROR']);
// These native failures are only raised before SendInput. Focus/window/desktop
// changes and occlusion are deliberately absent: later checks can fail after
// an earlier click or input batch already reached the application.
const zeroInputFailures = new Set(['INVALID_ARGUMENT', 'INVALID_KEY', 'SYSTEM_KEY_FORBIDDEN',
  'FOCUS_FAILED', 'FOCUS_UNKNOWN', 'KEYBOARD_BUSY', 'PASSWORD_INPUT_FORBIDDEN',
  'STALE_OBSERVATION', 'STALE_SCREENSHOT', 'UNKNOWN_ELEMENT', 'ELEMENT_CHANGED', 'ELEMENT_NOT_INTERACTABLE',
  'COORDINATE_OUT_OF_BOUNDS', 'POINT_OFF_SCREEN', 'WINDOW_HIDDEN', 'WINDOW_UNRESPONSIVE', 'CLIPBOARD_UNAVAILABLE',
  'UNBOUND_WINDOW', 'WINDOW_APP_MISMATCH', 'INVALID_REQUEST', 'REQUEST_TOO_LARGE', 'METHOD_NOT_FOUND',
  'HELPER_NOT_BUILT', 'HELPER_STOPPING', 'UNSUPPORTED_PLATFORM', 'CLOSED']);
const channel = (method: Method) => method === 'type_text' ? 'text' : ['click', 'drag', 'scroll'].includes(method) ? 'pointer' : method;

// A Windows desktop is shared even by different Cordis plugin instances.
let desktopQueue: Promise<void> = Promise.resolve();
let desktopEpoch = 0;
function exclusive<T>(run: () => Promise<T>): Promise<T> {
  const result = desktopQueue.then(run, run);
  desktopQueue = result.then(() => {}, () => {});
  return result;
}

export class Controller {
  private windows = new Map<number, WindowRef>();
  private apps = new Set<string>();
  private observation?: { state: WindowState; owner: string; createdAt: number; epoch: number };
  private disposed = false;
  private readonly inputStops = new Map<string, Map<string, string>>();
  private readonly ttl: number;
  constructor(private readonly backend: Backend, private readonly options: ControllerOptions = {}) {
    this.ttl = options.observationTtlMs ?? 30_000;
  }
  /** Only the current owner's fresh, identity-bound observation may inform approval. */
  approvalObservation(args: Record<string, unknown>, owner: string): WindowState | undefined {
    const observed = this.observation;
    const window = args.window as WindowRef | undefined;
    return observed && window && observed.owner === owner && observed.epoch === desktopEpoch &&
      Date.now() - observed.createdAt <= this.ttl && observed.state.observation_id === args.observation_id &&
      observed.state.window.id === window.id && normalize(observed.state.window.app) === normalize(window.app)
      ? observed.state : undefined;
  }
  private checkApp(app: string) {
    const key = normalize(app);
    if (blocked.includes(leaf(app)) || /(?:microsoft\.windowsterminal|microsoft\.sechealthui|microsoft\.lockapp)_/i.test(app) || this.options.deniedApps?.some(id => normalize(id) === key))
      throw new ComputerUseError('APP_DENIED', 'This application is excluded by the Computer Use policy.');
    if (this.options.allowedApps?.length && !this.options.allowedApps.some(id => normalize(id) === key))
      throw new ComputerUseError('APP_DENIED', 'App identifier is not in allowedApps. Use an exact identifier from list_apps.');
  }
  private remember(window: WindowRef) { this.windows.set(window.id, { ...window }); }
  private stopKey(window: WindowRef, owner: string) { return JSON.stringify([owner, normalize(window.app), window.id]); }
  private checkInputStop(window: WindowRef, owner: string, method: Method) {
    const stops = this.inputStops.get(this.stopKey(window, owner));
    const reason = (injected.has(method) ? stops?.get('injection') : undefined) ?? stops?.get(channel(method));
    if (reason) throw new ComputerUseError('INPUT_PAUSED',
      `Input channel is paused for this window after ${reason}. Observation does not reset it. Report to the human; do not replay input or change permissions. A human may reload the plugin after diagnosing the target.`,
      { native_request_dispatched: false, input_outcome: 'not_sent', original_code: reason });
  }
  private stopInput(window: WindowRef, owner: string, method: Method, code: string) {
    const key = this.stopKey(window, owner);
    const stops = this.inputStops.get(key) ?? new Map<string, string>();
    stops.set(blockedInput.has(code) ? 'injection' : channel(method), code);
    this.inputStops.set(key, stops);
  }
  private target(window: WindowRef): WindowRef {
    const known = this.windows.get(window.id);
    if (!known || normalize(known.app) !== normalize(window.app))
      throw new ComputerUseError('UNKNOWN_WINDOW', 'Select a window returned by list_apps/list_windows before acting.');
    this.checkApp(known.app);
    return { ...known };
  }
  private consume(method: Method, args: Record<string, unknown>, owner: string): WindowState {
    const observed = this.observation;
    const target = args.window as WindowRef;
    if (!observed || observed.owner !== owner || observed.state.observation_id !== args.observation_id ||
      observed.state.window.id !== target.id || normalize(observed.state.window.app) !== normalize(target.app) ||
      Date.now() - observed.createdAt > this.ttl || observed.epoch !== desktopEpoch)
      throw new ComputerUseError('STALE_OBSERVATION', 'Reobserve this window in this session before acting.');
    if (args.screenshotId !== undefined && !observed.state.screenshots.some(s => s.id === args.screenshotId))
      throw new ComputerUseError('STALE_SCREENSHOT', 'screenshotId does not belong to this observation.');
    if (args.element_index !== undefined && !observed.state.accessibility)
      throw new ComputerUseError('NO_ACCESSIBILITY', 'Observe with include_text:true before using element indexes.');
    if (injected.has(method) && observed.state.input?.injection === 'blocked')
      throw new ComputerUseError('INPUT_BLOCKED', 'This target does not permit input from the configured helper. Keep observation available and ask the human to diagnose; do not change permissions.');
    if (method === 'type_text') {
      const focus = observed.state.input?.focus;
      if (focus?.password === 'yes') throw new ComputerUseError('PASSWORD_INPUT_FORBIDDEN', 'Password inputs cannot receive text through this plugin.');
      if (focus ? !focus.in_window || !focus.can_type || focus.password !== 'no' : !observed.state.accessibility?.focused_element)
        throw new ComputerUseError('FOCUS_UNKNOWN', 'No verified non-password text focus. Observe/select an editable surface; games use coordinates or scan-code press_key, not type_text.');
    }
    this.observation = undefined;
    return observed.state;
  }
  private async observe(window: WindowRef, args: Record<string, unknown>, context: ExecutionContext): Promise<WindowState> {
    this.observation = undefined;
    const state = await this.backend.call<WindowState>('get_window_state', {
      window, include_screenshot: args.include_screenshot ?? this.options.screenshots ?? true,
      include_text: args.include_text ?? true,
      allow_print_window_fallback: this.options.allowPrintWindowFallback ?? false,
      allow_clipboard_paste: this.options.allowClipboardPaste ?? false,
    }, context.signal);
    if (!state?.observation_id || state.window?.id !== window.id || normalize(state.window.app) !== normalize(window.app))
      throw new ComputerUseError('PROTOCOL_ERROR', 'Native helper returned a mismatched window state.');
    this.remember(state.window);
    this.observation = { state, owner: context.owner, createdAt: Date.now(), epoch: desktopEpoch };
    return state;
  }
  execute(method: Method, input: unknown, context: ExecutionContext): Promise<unknown> {
    return exclusive(async () => {
      if (this.disposed) throw new ComputerUseError('CLOSED', 'Computer Use stopped.');
      let actionWindow: WindowRef | undefined;
      let actionDispatched = false;
      try {
        if (context.signal?.aborted) throw new ComputerUseError('ABORTED', 'Cancelled before dispatch.');
        const args = validate(method, input);
        if (method === 'list_windows' || method === 'find_window') {
          const windows = await this.backend.call<WindowRef[]>('list_windows', {}, context.signal);
          this.windows.clear(); windows.forEach(w => this.remember(w));
          return method === 'find_window' ? findWindows(windows, String(args.query), this.options.windowAliases) : windows;
        }
        if (method === 'list_apps') {
          const apps = await this.backend.call<AppInfo[]>(method, args, context.signal);
          this.apps.clear(); this.windows.clear();
          for (const app of apps) { this.apps.add(normalize(app.id)); app.windows.forEach(w => this.remember(w)); }
          return apps;
        }
        if (method === 'capabilities') return await this.backend.call(method, args, context.signal);
        if (method === 'launch_app') {
          const app = String(args.app); this.checkApp(app);
          if (!this.apps.has(normalize(app)) && !/^(?:[A-Za-z]:\\|\\\\)[^\r\n"<>|]*\.exe$/i.test(app))
            throw new ComputerUseError('UNKNOWN_APP', 'Launch a discovered app id or an absolute .exe path; command lines are unsupported.');
          this.observation = undefined;
          desktopEpoch++;
          await this.backend.call(method, args, context.signal);
          return { success: true, instruction: 'Refresh list_apps/list_windows and choose the returned window.' };
        }
        if (method === 'get_window') {
          const known = this.windows.get(Number(args.id));
          if (!known) throw new ComputerUseError('UNKNOWN_WINDOW', 'Window id was not returned by discovery.');
          this.target({ id: known.id, app: String(args.app ?? known.app) });
          const window = await this.backend.call<WindowRef>(method, { id: known.id, app: known.app }, context.signal);
          this.remember(window); return window;
        }
        const window = this.target(args.window as WindowRef); args.window = window;
        if (method === 'get_window_state') return await this.observe(window, args, context);
        if (actions.has(method)) {
          actionWindow = window;
          this.checkInputStop(window, context.owner, method);
          if (method === 'type_text') {
            if (args.method === 'paste' && !this.options.allowClipboardPaste)
              throw new ComputerUseError('CLIPBOARD_DISABLED', 'Clipboard paste is disabled by trusted host configuration. The model cannot enable it or use another helper.');
            args.allow_clipboard_paste = this.options.allowClipboardPaste ?? false;
          }
          this.consume(method, args, context.owner);
          desktopEpoch++;
          actionDispatched = true;
          const result = await this.backend.call<{ receipt?: InputReceipt } | null>(method, args, context.signal);
          try {
            const state = await this.observe(window, {}, context);
            const receipt = result?.receipt;
            return { success: true, state, ...(receipt ? { receipt, verification: receipt.status } : { verification: 'state_refreshed' }) };
          } catch (error) {
            this.observation = undefined;
            if (error instanceof ComputerUseError && ['ABORTED', 'TIMEOUT', 'HELPER_EXITED', 'HELPER_FAILED', 'PROTOCOL_ERROR'].includes(error.code)) {
              this.windows.clear(); this.apps.clear();
            }
            throw new ComputerUseError('REFRESH_FAILED', `Input was dispatched, but state refresh failed; application acceptance is unknown. Do not replay it. ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        this.observation = undefined;
        desktopEpoch++;
        await this.backend.call(method, args, context.signal);
        return { success: true, state: await this.observe(window, {}, context) };
      } catch (error) {
        this.observation = undefined;
        if (error instanceof ComputerUseError && ['ABORTED', 'TIMEOUT', 'HELPER_EXITED', 'HELPER_FAILED', 'PROTOCOL_ERROR'].includes(error.code)) {
          this.windows.clear(); this.apps.clear();
        }
        if (error instanceof ComputerUseError) {
          const unknownInput = actionDispatched && injected.has(method) && !zeroInputFailures.has(error.code);
          if (actionWindow && (blockedInput.has(error.code) || uncertainInput.has(error.code) || error.code === 'REFRESH_FAILED' || actionDispatched && transportFailures.has(error.code) || unknownInput))
            this.stopInput(actionWindow, context.owner, method, error.code);
          const targetPrecheck = ['INPUT_TARGET_BLOCKED', 'INPUT_IDENTITY_UNAVAILABLE'].includes(error.code) && ['type_text', 'press_key'].includes(method);
          const notSent = !actionDispatched || injected.has(method) && (zeroInputFailures.has(error.code) || targetPrecheck);
          throw new ComputerUseError(error.code, error.message, {
            native_request_dispatched: actionDispatched, input_outcome: notSent ? 'not_sent' : 'unknown', ...error.details,
          });
        }
        if (actionWindow && actionDispatched && injected.has(method)) {
          this.stopInput(actionWindow, context.owner, method, 'BACKEND_ERROR');
          throw new ComputerUseError('BACKEND_ERROR', error instanceof Error ? error.message : 'The input backend failed with an unknown outcome.',
            { native_request_dispatched: true, input_outcome: 'unknown' });
        }
        throw error;
      }
    });
  }
  dispose() { this.disposed = true; this.observation = undefined; this.inputStops.clear(); return this.backend.close(); }
}
