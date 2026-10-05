import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ComputerUseError, type Backend } from './types.js';

export interface BackendOptions { helperPath?: string; helperArgs?: string[]; timeoutMs?: number }
type Pending = {
  resolve(value: unknown): void; reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>; cleanup(): void;
};

/** Private child process; no port, shell, model-supplied code, or automatic input retry. */
export class NativeBackend implements Backend {
  private child?: ChildProcessWithoutNullStreams;
  private pending = new Map<number, Pending>();
  private serial = 0;
  private buffer = '';
  private closed = false;
  private stopping?: Promise<void>;
  private readonly timeoutMs: number;
  private readonly helperPath: string;
  private readonly helperArgs: string[];
  constructor(options: BackendOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.helperPath = options.helperPath ?? fileURLToPath(new URL('../lib/native/cpuse-windows.exe', import.meta.url));
    this.helperArgs = options.helperArgs ?? [];
  }
  private start() {
    if (this.closed) throw new ComputerUseError('CLOSED', 'Computer Use backend has been disposed.');
    if (this.stopping) throw new ComputerUseError('HELPER_STOPPING', 'Native helper is still stopping; wait before rediscovery.');
    if (this.child) return this.child;
    if (process.platform !== 'win32') throw new ComputerUseError('UNSUPPORTED_PLATFORM', 'This backend requires a Windows desktop session.');
    if (!existsSync(this.helperPath)) throw new ComputerUseError('HELPER_NOT_BUILT', 'Run npm run build:native before using Computer Use.');
    const child = spawn(this.helperPath, this.helperArgs, { shell: false, windowsHide: true, stdio: 'pipe' });
    this.child = child;
    this.buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (this.child !== child) return;
      this.buffer += chunk;
      if (this.buffer.length > 64 * 1024 * 1024) { this.fail(new ComputerUseError('PROTOCOL_ERROR', 'Native response exceeds 64 MB.')); return; }
      let newline: number;
      while ((newline = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, newline).trim();
        this.buffer = this.buffer.slice(newline + 1);
        if (!line) continue;
        try {
          const response = JSON.parse(line);
          const request = this.pending.get(response.id);
          if (!request) continue;
          this.pending.delete(response.id);
          clearTimeout(request.timer); request.cleanup();
          if (response.error) request.reject(new ComputerUseError(String(response.error.code ?? 'NATIVE_ERROR'), String(response.error.message)));
          else request.resolve(response.result);
        } catch { this.fail(new ComputerUseError('PROTOCOL_ERROR', 'Invalid JSON from native helper.')); return; }
      }
    });
    // Consume stderr without logging app titles, document content, or typed text.
    child.stderr.resume();
    child.on('error', () => { if (this.child === child) this.fail(new ComputerUseError('HELPER_FAILED', 'Could not start the native helper.')); });
    child.on('exit', () => { if (this.child === child) this.fail(new ComputerUseError('HELPER_EXITED', 'Native helper exited. Re-list windows and observe before continuing.')); });
    child.stdin.on('error', () => { if (this.child === child) this.fail(new ComputerUseError('HELPER_FAILED', 'Native helper input stream closed.')); });
    return child;
  }
  call<T>(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(new ComputerUseError('ABORTED', 'Action cancelled before dispatch.'));
    let child: ChildProcessWithoutNullStreams;
    try { child = this.start(); } catch (error) { return Promise.reject(error); }
    const id = ++this.serial;
    return new Promise<T>((resolve, reject) => {
      const cancel = () => this.fail(new ComputerUseError('ABORTED', 'Action interrupted; outcome may be unknown. Reobserve before retrying.'));
      const timer = setTimeout(() => this.fail(new ComputerUseError('TIMEOUT', 'Native request timed out; outcome may be unknown. Reobserve before retrying.')), this.timeoutMs);
      this.pending.set(id, { resolve: value => resolve(value as T), reject, timer, cleanup: () => signal?.removeEventListener('abort', cancel) });
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) { cancel(); return; }
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }
  private fail(error: Error): Promise<void> {
    if (this.stopping) return this.stopping;
    const child = this.child; this.child = undefined;
    this.buffer = '';
    const requests = [...this.pending.values()];
    for (const request of requests) { clearTimeout(request.timer); request.cleanup(); }
    this.pending.clear();
    const stopped = !child || child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve()
      : new Promise<void>(resolve => {
        child.once('exit', () => resolve());
        child.once('error', () => resolve());
        if (!child.kill()) resolve();
      });
    this.stopping = stopped.then(() => {
      for (const request of requests) request.reject(error);
      this.stopping = undefined;
    });
    return this.stopping;
  }
  close() { this.closed = true; return this.fail(new ComputerUseError('CLOSED', 'Computer Use stopped.')); }
}
