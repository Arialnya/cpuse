import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { Controller } from '../lib/controller.js';
import { ComputerUseError } from '../lib/types.js';

const window = { id: 101, app: 'C:\\Apps\\editor.exe', title: 'Fixture editor' };
const secondWindow = { id: 102, app: 'C:\\Apps\\viewer.exe', title: 'Fixture viewer' };
const context = { owner: 'session-a' };

class FakeBackend {
  calls = [];
  windows = [window, secondWindow];
  serial = 0;
  closed = false;
  hook;
  async call(method, params, signal) {
    this.calls.push({ method, params: structuredClone(params), signal });
    const override = await this.hook?.(method, params, signal);
    if (override !== undefined) return override;
    if (method === 'list_windows') return structuredClone(this.windows);
    if (method === 'list_apps') return this.windows.map(w => ({ id: w.app, windows: [structuredClone(w)] }));
    if (method === 'get_window') return structuredClone(this.windows.find(w => w.id === params.id));
    if (method === 'get_window_state') {
      const id = `observation-${++this.serial}`;
      return {
        window: structuredClone(params.window), observation_id: id,
        accessibility: params.include_text ? { tree: '[0] Edit', focused_element: '[0] Edit' } : null,
        screenshots: params.include_screenshot ? [{ id: `image-${this.serial}`, url: 'data:image/png;base64,fixture', width: 80, height: 60, originX: 20, originY: 30, zIndex: 0 }] : [],
      };
    }
    if (method === 'capabilities') return { target: 'windows' };
    return null;
  }
  close() { this.closed = true; }
}

function setup(t, options = {}) {
  const backend = new FakeBackend();
  const controller = new Controller(backend, options);
  t.after(() => controller.dispose());
  return { backend, controller };
}
async function observe(controller, target = window, owner = context, options = {}) {
  await controller.execute('list_windows', {}, owner);
  return controller.execute('get_window_state', { window: target, ...options }, owner);
}
const rejected = (promise, code) => assert.rejects(promise, { code });
const click = state => ({ window: state.window, observation_id: state.observation_id, element_index: 0 });

test('an unenumerated or forged window is rejected before native dispatch', async t => {
  const { backend, controller } = setup(t);
  await rejected(controller.execute('get_window_state', { window }, context), 'UNKNOWN_WINDOW');
  await rejected(controller.execute('get_window', { id: window.id }, context), 'UNKNOWN_WINDOW');
  assert.equal(backend.calls.length, 0);
  await controller.execute('list_windows', {}, context);
  await rejected(controller.execute('get_window_state', { window: { ...window, app: secondWindow.app } }, context), 'UNKNOWN_WINDOW');
  assert.deepEqual(backend.calls.map(c => c.method), ['list_windows']);
});

test('discovery permits rehydration and an action automatically returns fresh state', async t => {
  const { backend, controller } = setup(t);
  const first = await observe(controller);
  assert.deepEqual(await controller.execute('get_window', { id: window.id }, context), window);
  const result = await controller.execute('click', click(first), context);
  assert.equal(result.success, true);
  assert.notEqual(result.state.observation_id, first.observation_id);
  assert.deepEqual(backend.calls.slice(-2).map(c => c.method), ['click', 'get_window_state']);
  assert.equal(backend.calls.at(-1).params.include_text, true);
});

test('the latest observation is bound to its owner and rejected tokens cannot be reused', async t => {
  const { backend, controller } = setup(t);
  const first = await observe(controller);
  await rejected(controller.execute('click', click(first), { owner: 'session-b' }), 'STALE_OBSERVATION');
  await rejected(controller.execute('click', click(first), context), 'STALE_OBSERVATION');
  assert.equal(backend.calls.filter(c => c.method === 'click').length, 0);
});

test('a new snapshot invalidates previous window and snapshot references', async t => {
  const { controller } = setup(t);
  const first = await observe(controller);
  await controller.execute('get_window_state', { window: secondWindow }, context);
  await rejected(controller.execute('click', click(first), context), 'STALE_OBSERVATION');
  const old = await controller.execute('get_window_state', { window }, context);
  await controller.execute('get_window_state', { window }, context);
  await rejected(controller.execute('click', click(old), context), 'STALE_OBSERVATION');
});

test('observation age is checked at dispatch', async t => {
  const { controller } = setup(t, { observationTtlMs: 1 });
  const state = await observe(controller);
  await delay(10);
  await rejected(controller.execute('click', click(state), context), 'STALE_OBSERVATION');
});

test('coordinate actions require the screenshot from the same current observation', async t => {
  const { backend, controller } = setup(t);
  const state = await observe(controller);
  await rejected(controller.execute('click', { window, observation_id: state.observation_id, screenshotId: 'other-image', x: 10, y: 10 }, context), 'STALE_SCREENSHOT');
  assert.equal(backend.calls.filter(c => c.method === 'click').length, 0);
  const fresh = await controller.execute('get_window_state', { window }, context);
  await controller.execute('scroll', { window, observation_id: fresh.observation_id, screenshotId: fresh.screenshots[0].id, x: 10, y: 10, scrollX: 0, scrollY: 120 }, context);
  assert.equal(backend.calls.filter(c => c.method === 'scroll').length, 1);
});

test('element input requires accessibility and typing requires observed focus', async t => {
  const { backend, controller } = setup(t);
  const state = await observe(controller, window, context, { include_text: false });
  await rejected(controller.execute('click', click(state), context), 'NO_ACCESSIBILITY');
  backend.hook = (method, params) => method === 'get_window_state'
    ? { window: params.window, observation_id: 'no-focus', accessibility: { tree: '[0] Edit' }, screenshots: [] } : undefined;
  const fresh = await controller.execute('get_window_state', { window }, context);
  await rejected(controller.execute('type_text', { window, observation_id: fresh.observation_id, text: 'hello' }, context), 'FOCUS_UNKNOWN');
  assert.equal(backend.calls.filter(c => c.method === 'type_text').length, 0);
});

test('failed native input is never retried and invalidates the observation', async t => {
  const { backend, controller } = setup(t);
  const state = await observe(controller);
  backend.hook = method => { if (method === 'click') throw new ComputerUseError('INPUT_FAILED', 'fixture rejection'); };
  await rejected(controller.execute('click', click(state), context), 'INPUT_FAILED');
  await rejected(controller.execute('click', click(state), context), 'STALE_OBSERVATION');
  assert.equal(backend.calls.filter(c => c.method === 'click').length, 1);
});

test('input followed by failed verification reports an uncertain result without retry', async t => {
  const { backend, controller } = setup(t);
  const state = await observe(controller);
  backend.hook = method => { if (method === 'get_window_state') throw new ComputerUseError('CAPTURE_FAILED', 'fixture capture failure'); };
  await rejected(controller.execute('click', click(state), context), 'REFRESH_FAILED');
  assert.equal(backend.calls.filter(c => c.method === 'click').length, 1);
  await rejected(controller.execute('click', click(state), context), 'STALE_OBSERVATION');
});

test('transport failures invalidate discovered windows until fresh discovery', async t => {
  const { backend, controller } = setup(t);
  const state = await observe(controller);
  backend.hook = method => { if (method === 'click') throw new ComputerUseError('HELPER_EXITED', 'fixture exit'); };
  await rejected(controller.execute('click', click(state), context), 'HELPER_EXITED');
  backend.hook = undefined;
  await rejected(controller.execute('get_window_state', { window }, context), 'UNKNOWN_WINDOW');
  assert.ok((await observe(controller)).observation_id);
});

test('transport failure during automatic refresh clears discovery even after input succeeded', async t => {
  const { backend, controller } = setup(t);
  const state = await observe(controller);
  backend.hook = method => { if (method === 'get_window_state') throw new ComputerUseError('TIMEOUT', 'fixture timeout'); };
  await rejected(controller.execute('click', click(state), context), 'REFRESH_FAILED');
  backend.hook = undefined;
  await rejected(controller.execute('get_window_state', { window }, context), 'UNKNOWN_WINDOW');
  assert.equal(backend.calls.filter(c => c.method === 'click').length, 1);
});

test('invalid input cannot leave a previously observed token reusable', async t => {
  const { backend, controller } = setup(t);
  const state = await observe(controller);
  await rejected(controller.execute('click', { ...click(state), element_index: -1 }, context), 'INVALID_ARGUMENT');
  await rejected(controller.execute('click', click(state), context), 'STALE_OBSERVATION');
  assert.equal(backend.calls.filter(c => c.method === 'click').length, 0);
});

test('mismatched native snapshots are protocol errors and cannot become actionable', async t => {
  const { backend, controller } = setup(t);
  await controller.execute('list_windows', {}, context);
  backend.hook = method => method === 'get_window_state'
    ? { window: secondWindow, observation_id: 'forged', accessibility: { tree: '[0] Edit' }, screenshots: [] } : undefined;
  await rejected(controller.execute('get_window_state', { window }, context), 'PROTOCOL_ERROR');
  await rejected(controller.execute('get_window_state', { window }, context), 'UNKNOWN_WINDOW');
});

test('allowedApps uses normalized exact ids and deniedApps wins', async t => {
  const { controller } = setup(t, { allowedApps: ['c:/apps/EDITOR.exe'], deniedApps: [secondWindow.app] });
  assert.ok((await observe(controller)).observation_id);
  await rejected(controller.execute('get_window_state', { window: secondWindow }, context), 'APP_DENIED');
  const denied = setup(t, { allowedApps: [window.app], deniedApps: ['C:/Apps/EDITOR.exe'] });
  await denied.controller.execute('list_windows', {}, context);
  await rejected(denied.controller.execute('get_window_state', { window }, context), 'APP_DENIED');
});

test('excluded applications cannot be re-enabled by allowedApps', async t => {
  const terminal = { id: 201, app: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' };
  const { backend, controller } = setup(t, { allowedApps: [terminal.app] });
  backend.windows = [terminal];
  await controller.execute('list_windows', {}, context);
  await rejected(controller.execute('get_window_state', { window: terminal }, context), 'APP_DENIED');
  await rejected(controller.execute('launch_app', { app: terminal.app }, context), 'APP_DENIED');
});

test('launch accepts discovered ids or absolute executable paths, never command lines', async t => {
  const { backend, controller } = setup(t);
  await controller.execute('list_apps', {}, context);
  assert.equal((await controller.execute('launch_app', { app: window.app }, context)).success, true);
  assert.equal((await controller.execute('launch_app', { app: 'C:\\New App\\app.exe' }, context)).success, true);
  for (const app of ['editor.exe', 'https://example.com', 'C:\\Apps\\editor.exe --args', 'C:\\Apps\\editor.exe\nother.exe']) {
    await rejected(controller.execute('launch_app', { app }, context), 'UNKNOWN_APP');
  }
  assert.equal(backend.calls.filter(c => c.method === 'launch_app').length, 2);
});

test('global desktop serialization covers multiple controller instances', async t => {
  const a = setup(t); const b = setup(t);
  let running = 0; let maximum = 0; const events = [];
  for (const [label, backend] of [['a', a.backend], ['b', b.backend]]) backend.hook = async method => {
    running++; maximum = Math.max(maximum, running); events.push(`${label}:${method}:start`);
    await delay(8); events.push(`${label}:${method}:end`); running--; return undefined;
  };
  await Promise.all([
    a.controller.execute('list_windows', {}, context),
    b.controller.execute('list_windows', {}, { owner: 'session-b' }),
    a.controller.execute('capabilities', {}, context),
  ]);
  assert.equal(maximum, 1);
  assert.deepEqual(events, ['a:list_windows:start', 'a:list_windows:end', 'b:list_windows:start', 'b:list_windows:end', 'a:capabilities:start', 'a:capabilities:end']);
});

test('input in another controller invalidates earlier desktop observations', async t => {
  const a = setup(t); const b = setup(t);
  const aState = await observe(a.controller);
  const bState = await observe(b.controller);
  await b.controller.execute('click', click(bState), context);
  await rejected(a.controller.execute('click', click(aState), context), 'STALE_OBSERVATION');
  assert.equal(a.backend.calls.filter(c => c.method === 'click').length, 0);
});

test('queued cancellation prevents native dispatch and passes active signals to the backend', async t => {
  const { backend, controller } = setup(t);
  const cancel = new AbortController();
  backend.hook = async method => { if (method === 'list_windows') await delay(20); };
  const first = controller.execute('list_windows', {}, context);
  const aborted = rejected(controller.execute('capabilities', {}, { ...context, signal: cancel.signal }), 'ABORTED');
  cancel.abort();
  await Promise.all([first, aborted]);
  assert.deepEqual(backend.calls.map(c => c.method), ['list_windows']);
  const active = new AbortController();
  await controller.execute('capabilities', {}, { ...context, signal: active.signal });
  assert.equal(backend.calls.at(-1).signal, active.signal);
});

test('dispose closes the backend and rejects further calls', async t => {
  const { backend, controller } = setup(t);
  controller.dispose();
  assert.equal(backend.closed, true);
  await rejected(controller.execute('list_windows', {}, context), 'CLOSED');
  assert.equal(backend.calls.length, 0);
});
