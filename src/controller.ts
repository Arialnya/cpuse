import { basename } from 'node:path';
import { actions, ComputerUseError, type AppInfo, type Backend, type Method, type WindowRef, type WindowState } from './types.js';
import { validate } from './validation.js';

export interface ControllerOptions {
  allowedApps?: string[]; deniedApps?: string[]; observationTtlMs?: number; screenshots?: boolean; allowPrintWindowFallback?: boolean;
}
export interface ExecutionContext { owner: string; signal?: AbortSignal }
const blocked = ['cmd.exe', 'powershell.exe', 'pwsh.exe', 'windowsterminal.exe', 'wt.exe', 'bash.exe', 'wsl.exe', 'conhost.exe',
  'lockapp.exe', 'credentialuibroker.exe', 'consent.exe', 'sechealthui.exe', 'keepass.exe',
  'keepassxc.exe', '1password.exe', 'bitwarden.exe'];
/** App identifiers compare case-insensitively and ignore path separator differences. */
export const normalizeAppId = (app: string) => app.replaceAll('/', '\\').toLowerCase();
const normalize = normalizeAppId;
const leaf = (app: string) => basename(app.replaceAll('\\', '/')).toLowerCase();

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
  private readonly ttl: number;
  constructor(private readonly backend: Backend, private readonly options: ControllerOptions = {}) {
    this.ttl = options.observationTtlMs ?? 30_000;
  }
  private checkApp(app: string) {
    const key = normalize(app);
    if (blocked.includes(leaf(app)) || /(?:microsoft\.windowsterminal|microsoft\.sechealthui|microsoft\.lockapp)_/i.test(app) || this.options.deniedApps?.some(id => normalize(id) === key))
      throw new ComputerUseError('APP_DENIED', 'This application is excluded by the Computer Use policy.');
    if (this.options.allowedApps?.length && !this.options.allowedApps.some(id => normalize(id) === key))
      throw new ComputerUseError('APP_DENIED', 'App identifier is not in allowedApps. Use an exact identifier from list_apps.');
  }
  private remember(window: WindowRef) { this.windows.set(window.id, { ...window }); }
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
    if (method === 'type_text' && !observed.state.accessibility?.focused_element)
      throw new ComputerUseError('FOCUS_UNKNOWN', 'Observe accessibility focus before typing; click the editable surface first.');
    this.observation = undefined;
    return observed.state;
  }
  private async observe(window: WindowRef, args: Record<string, unknown>, context: ExecutionContext): Promise<WindowState> {
    this.observation = undefined;
    const state = await this.backend.call<WindowState>('get_window_state', {
      window, include_screenshot: args.include_screenshot ?? this.options.screenshots ?? true,
      include_text: args.include_text ?? true,
      allow_print_window_fallback: this.options.allowPrintWindowFallback ?? false,
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
      try {
        if (context.signal?.aborted) throw new ComputerUseError('ABORTED', 'Cancelled before dispatch.');
        const args = validate(method, input);
        if (method === 'list_windows') {
          const windows = await this.backend.call<WindowRef[]>(method, args, context.signal);
          this.windows.clear(); windows.forEach(w => this.remember(w)); return windows;
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
          this.consume(method, args, context.owner);
          desktopEpoch++;
          await this.backend.call(method, args, context.signal);
          try {
            const state = await this.observe(window, {}, context);
            return { success: true, state };
          } catch (error) {
            this.observation = undefined;
            if (error instanceof ComputerUseError && ['ABORTED', 'TIMEOUT', 'HELPER_EXITED', 'HELPER_FAILED', 'PROTOCOL_ERROR'].includes(error.code)) {
              this.windows.clear(); this.apps.clear();
            }
            throw new ComputerUseError('REFRESH_FAILED', `Input completed, but verification failed. Reobserve before any retry. ${error instanceof Error ? error.message : String(error)}`);
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
        throw error;
      }
    });
  }
  dispose() { this.disposed = true; this.observation = undefined; return this.backend.close(); }
}
