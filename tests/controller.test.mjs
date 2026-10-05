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
        input: { injection: 'allowed', focus: { source: 'uia', in_window: true, password: 'no', can_type: true }, text_methods: ['unicode', 'paste'] },
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

test('an unknown native input failure pauses its channel without retrying', async t => {
  const { backend, controller } = setup(t);
  const state = await observe(controller);
  backend.hook = method => { if (method === 'click') throw new ComputerUseError('INPUT_FAILED', 'fixture rejection'); };
  await rejected(controller.execute('click', click(state), context), 'INPUT_FAILED');
  await rejected(controller.execute('click', click(state), context), 'INPUT_PAUSED');
  assert.equal(backend.calls.filter(c => c.method === 'click').length, 1);
});

test('input followed by failed verification reports an uncertain result without retry', async t => {
  const { backend, controller } = setup(t);
  const state = await observe(controller);
  backend.hook = method => { if (method === 'get_window_state') throw new ComputerUseError('CAPTURE_FAILED', 'fixture capture failure'); };
  await rejected(controller.execute('click', click(state), context), 'REFRESH_FAILED');
  assert.equal(backend.calls.filter(c => c.method === 'click').length, 1);
  await rejected(controller.execute('click', click(state), context), 'INPUT_PAUSED');
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

test('verified Win32 edit focus permits typing when an application exposes no UIA tree', async t => {
  const { backend, controller } = setup(t);
  let serial = 0;
  const receipt = { method: 'unicode', status: 'queued_unverified', events_queued: 10, retry_safe: false };
  backend.hook = (method, params) => {
    if (method === 'get_window_state') return {
      window: params.window, observation_id: `win32-${++serial}`, accessibility: null, screenshots: [],
      input: { injection: 'allowed', focus: { source: 'win32', in_window: true, password: 'no', can_type: true }, text_methods: ['unicode'] },
    };
    if (method === 'type_text') return { receipt };
  };
  const state = await observe(controller);
  const result = await controller.execute('type_text', { window, observation_id: state.observation_id, text: 'hello' }, context);
  assert.equal(result.success, true);
  assert.deepEqual(result.receipt, receipt);
  assert.equal(result.receipt.status, 'queued_unverified', 'Queued input is not a claim that the app consumed it.');
  assert.equal(backend.calls.filter(call => call.method === 'type_text').length, 1);
});

test('native focus diagnostics override a legacy UIA focus string and cannot authorize unsafe text input', async t => {
  const { backend, controller } = setup(t);
  const unsafeFocuses = [
    { source: 'uia', in_window: false, password: 'no', can_type: true },
    { source: 'win32', in_window: true, password: 'unknown', can_type: true },
    { source: 'uia', in_window: true, password: 'yes', can_type: true },
    { source: 'none', in_window: true, password: 'no', can_type: false },
  ];
  let serial = 0;
  for (const focus of unsafeFocuses) {
    backend.hook = (method, params) => method === 'get_window_state' ? {
      window: params.window, observation_id: `unsafe-${++serial}`,
      accessibility: { tree: '[0] Edit', focused_element: '[0] Edit' }, screenshots: [],
      input: { injection: 'allowed', focus, text_methods: ['unicode'] },
    } : undefined;
    const state = await observe(controller);
    await assert.rejects(controller.execute('type_text', { window, observation_id: state.observation_id, text: 'secret' }, context),
      error => error instanceof ComputerUseError && ['FOCUS_UNKNOWN', 'PASSWORD_INPUT_FORBIDDEN'].includes(error.code));
  }
  assert.equal(backend.calls.filter(call => call.method === 'type_text').length, 0);
});

test('weak accessibility game windows still accept observed coordinates and explicit scan-code controls', async t => {
  const { backend, controller } = setup(t);
  let serial = 0;
  backend.hook = (method, params) => method === 'get_window_state' ? {
    window: params.window, observation_id: `game-${++serial}`, accessibility: null,
    screenshots: [{ id: `game-image-${serial}`, url: 'data:image/png;base64,fixture', width: 100, height: 60, originX: 0, originY: 0, zIndex: 0 }],
    input: { injection: 'allowed', focus: { source: 'win32', in_window: true, password: 'unknown', can_type: false }, text_methods: [] },
  } : undefined;
  const state = await observe(controller);
  const clicked = await controller.execute('click', {
    window, observation_id: state.observation_id, screenshotId: state.screenshots[0].id, x: 20, y: 20,
  }, context);
  await controller.execute('press_key', { window, observation_id: clicked.state.observation_id, key: 'Return', mode: 'scan-code' }, context);
  assert.deepEqual(backend.calls.filter(call => ['click', 'press_key'].includes(call.method)).map(call => call.method), ['click', 'press_key']);
  assert.equal(backend.calls.find(call => call.method === 'press_key').params.mode, 'scan-code');
});

test('clipboard paste requires host configuration and model-supplied permission flags do not grant it', async t => {
  const denied = setup(t);
  const deniedState = await observe(denied.controller);
  await assert.rejects(denied.controller.execute('type_text', {
    window, observation_id: deniedState.observation_id, text: 'literal text', method: 'paste', allow_clipboard_paste: true,
  }, context), error => error instanceof ComputerUseError && /CLIPBOARD|PASTE/.test(error.code));
  assert.equal(denied.backend.calls.filter(call => call.method === 'type_text').length, 0);
  const allowed = setup(t, { allowClipboardPaste: true });
  const allowedState = await observe(allowed.controller);
  await allowed.controller.execute('type_text', {
    window, observation_id: allowedState.observation_id, text: 'literal text', method: 'paste', allow_clipboard_paste: false,
  }, context);
  const sent = allowed.backend.calls.find(call => call.method === 'type_text');
  assert.equal(sent.params.method, 'paste');
  assert.equal(sent.params.allow_clipboard_paste, true, 'Native opt-in must come from the trusted host config.');
});

for (const code of ['INPUT_BLOCKED', 'INPUT_TARGET_BLOCKED', 'INPUT_IDENTITY_UNAVAILABLE']) {
  test(`${code} pauses this owner and window's injection channel without blocking reads, UIA or other targets`, async t => {
    const { backend, controller } = setup(t);
    let rejectOnce = true;
    backend.hook = method => {
      if (method === 'press_key' && rejectOnce) { rejectOnce = false; throw new ComputerUseError(code, 'Fixture stable injection refusal.'); }
    };
    const state = await observe(controller);
    await rejected(controller.execute('press_key', { window, observation_id: state.observation_id, key: 'Return' }, context), code);
    // Rediscovery and fresh snapshots must not clear the native-channel stop.
    await controller.execute('list_apps', {}, context);
    const after = await observe(controller);
    await rejected(controller.execute('type_text', { window, observation_id: after.observation_id, text: 'no retry' }, context), 'INPUT_PAUSED');
    const fresh = await controller.execute('get_window_state', { window }, context);
    await rejected(controller.execute('click', click(fresh), context), 'INPUT_PAUSED');
    const uia = await controller.execute('get_window_state', { window }, context);
    await controller.execute('set_value', { window, observation_id: uia.observation_id, element_index: 0, value: 'UIA allowed' }, context);
    const otherOwner = { owner: 'session-b' };
    const ownerState = await controller.execute('get_window_state', { window }, otherOwner);
    await controller.execute('press_key', { window, observation_id: ownerState.observation_id, key: 'Return' }, otherOwner);
    const targetState = await controller.execute('get_window_state', { window: secondWindow }, context);
    await controller.execute('press_key', { window: secondWindow, observation_id: targetState.observation_id, key: 'Return' }, context);
    assert.equal(backend.calls.filter(call => call.method === 'type_text').length, 0);
    assert.equal(backend.calls.filter(call => call.method === 'click').length, 0);
    assert.equal(backend.calls.filter(call => call.method === 'set_value').length, 1);
    assert.equal(backend.calls.filter(call => call.method === 'press_key').length, 3);
  });
}

for (const code of ['INPUT_NOT_ACCEPTED', 'INPUT_PARTIAL', 'INPUT_OUTCOME_UNKNOWN']) {
  test(`${code} stops text replay across observation tokens and text methods without blocking pointer recovery`, async t => {
    const { backend, controller } = setup(t, { allowClipboardPaste: true });
    let rejectOnce = true;
    backend.hook = method => {
      if (method === 'type_text' && rejectOnce) { rejectOnce = false; throw new ComputerUseError(code, 'Fixture text input outcome.'); }
    };
    const first = await observe(controller);
    await rejected(controller.execute('type_text', { window, observation_id: first.observation_id, text: 'original' }, context), code);
    await controller.execute('list_windows', {}, context);
    const again = await controller.execute('get_window_state', { window }, context);
    await rejected(controller.execute('type_text', { window, observation_id: again.observation_id, text: 'different text', method: 'paste' }, context), 'INPUT_PAUSED');
    const fresh = await controller.execute('get_window_state', { window }, context);
    await controller.execute('click', click(fresh), context);
    assert.equal(backend.calls.filter(call => call.method === 'type_text').length, 1);
    assert.equal(backend.calls.filter(call => call.method === 'click').length, 1);
  });
}

test('Chinese game aliases find only returned English-title or empty-title process windows', async t => {
  const { backend, controller } = setup(t);
  const gameWindows = [
    { id: 201, app: 'C:\Games\Spire\game.exe', title: 'Slay the Spire 2', process_name: 'game.exe' },
    { id: 202, app: 'C:\Games\Spire\SlayTheSpireII.exe', title: '', process_name: 'SlayTheSpireII.exe' },
    { id: 203, app: 'C:\Games\Spire\sts2.exe', title: '', process_name: 'sts2.exe' },
  ];
  backend.windows = [...gameWindows, window];
  const result = await controller.execute('find_window', { query: '杀戮尖塔 ２' }, context);
  assert.equal(result.matched, true);
  assert.equal(result.ambiguous, true);
  assert.equal(result.next_action, 'choose_from_candidates');
  assert.deepEqual(result.windows.map(target => target.id).sort(), gameWindows.map(target => target.id));
  assert.deepEqual(backend.calls.map(call => call.method), ['list_windows']);
  const observed = await controller.execute('get_window_state', { window: result.windows[1] }, context);
  assert.equal(observed.window.id, result.windows[1].id);
});

test('custom window aliases do not invent identities or bypass denied application policy', async t => {
  const { backend, controller } = setup(t, {
    windowAliases: [{ name: '我的游戏', terms: ['Fixture editor'] }], deniedApps: [window.app],
  });
  const result = await controller.execute('find_window', { query: '我的游戏', id: 999, app: 'C:\Invented\fake.exe' }, context);
  assert.equal(result.matched, true);
  assert.deepEqual(result.windows, [window]);
  await rejected(controller.execute('get_window_state', { window: result.windows[0] }, context), 'APP_DENIED');
  assert.deepEqual(backend.calls.map(call => call.method), ['list_windows']);
});

test('a window search miss asks for the actual visible window and grants no forged handle', async t => {
  const { backend, controller } = setup(t);
  const result = await controller.execute('find_window', { query: 'No such game' }, context);
  assert.equal(result.matched, false);
  assert.equal(result.ambiguous, false);
  assert.deepEqual(result.windows, []);
  assert.equal(result.next_action, 'ask_user_to_show_window');
  await rejected(controller.execute('get_window_state', { window: { id: 999, app: 'C:\Game\fake.exe' } }, context), 'UNKNOWN_WINDOW');
  assert.deepEqual(backend.calls.map(call => call.method), ['list_windows']);
});

test('a partial pointer action pauses click, scroll and drag while leaving keyboard controls usable', async t => {
  const { backend, controller } = setup(t);
  backend.hook = method => { if (method === 'click') throw new ComputerUseError('INPUT_PARTIAL', 'Fixture partial pointer input.'); };
  const first = await observe(controller);
  await rejected(controller.execute('click', click(first), context), 'INPUT_PARTIAL');
  const scroll = await controller.execute('get_window_state', { window }, context);
  await rejected(controller.execute('scroll', {
    window, observation_id: scroll.observation_id, screenshotId: scroll.screenshots[0].id,
    x: 10, y: 10, scrollX: 0, scrollY: 120,
  }, context), 'INPUT_PAUSED');
  const drag = await controller.execute('get_window_state', { window }, context);
  await rejected(controller.execute('drag', {
    window, observation_id: drag.observation_id, screenshotId: drag.screenshots[0].id,
    from_x: 10, from_y: 10, to_x: 20, to_y: 20,
  }, context), 'INPUT_PAUSED');
  const keyboard = await controller.execute('get_window_state', { window }, context);
  await controller.execute('press_key', { window, observation_id: keyboard.observation_id, key: 'Return', mode: 'scan-code' }, context);
  assert.equal(backend.calls.filter(call => call.method === 'click').length, 1);
  assert.equal(backend.calls.filter(call => ['drag', 'scroll'].includes(call.method)).length, 0);
  assert.equal(backend.calls.filter(call => call.method === 'press_key').length, 1);
});

for (const code of ['ABORTED', 'TIMEOUT', 'HELPER_EXITED', 'HELPER_FAILED', 'PROTOCOL_ERROR']) {
  test(`dispatched ${code} input cannot be replayed after helper rediscovery`, async t => {
    const { backend, controller } = setup(t);
    let rejectOnce = true;
    backend.hook = method => {
      if (method === 'type_text' && rejectOnce) { rejectOnce = false; throw new ComputerUseError(code, 'Fixture transport outcome unknown.'); }
    };
    const first = await observe(controller);
    await assert.rejects(controller.execute('type_text', { window, observation_id: first.observation_id, text: 'original' }, context), error => {
      assert.equal(error.code, code);
      assert.equal(error.details.native_request_dispatched, true);
      assert.equal(error.details.input_outcome, 'unknown');
      return true;
    });
    await rejected(controller.execute('get_window_state', { window }, context), 'UNKNOWN_WINDOW');
    const fresh = await observe(controller);
    await rejected(controller.execute('type_text', { window, observation_id: fresh.observation_id, text: 'replay' }, context), 'INPUT_PAUSED');
    const uia = await controller.execute('get_window_state', { window }, context);
    await controller.execute('set_value', { window, observation_id: uia.observation_id, element_index: 0, value: 'UIA still available' }, context);
    assert.equal(backend.calls.filter(call => call.method === 'type_text').length, 1);
    assert.equal(backend.calls.filter(call => call.method === 'set_value').length, 1);
  });
}

test('cancellation before input dispatch invalidates the snapshot without pausing the input channel', async t => {
  const { backend, controller } = setup(t);
  const first = await observe(controller);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(controller.execute('type_text', { window, observation_id: first.observation_id, text: 'not sent' },
    { ...context, signal: abort.signal }), error => {
    assert.equal(error.code, 'ABORTED');
    assert.equal(error.details.native_request_dispatched, false);
    assert.equal(error.details.input_outcome, 'not_sent');
    return true;
  });
  const fresh = await observe(controller);
  await controller.execute('type_text', { window, observation_id: fresh.observation_id, text: 'new request' }, context);
  assert.equal(backend.calls.filter(call => call.method === 'type_text').length, 1);
});

for (const code of ['NATIVE_ERROR', 'BACKEND_ERROR', 'FOCUS_CHANGED']) {
  test(`${code} after text dispatch pauses unknown input rather than allowing a refreshed replay`, async t => {
    const { backend, controller } = setup(t, { allowClipboardPaste: true });
    let failOnce = true;
    backend.hook = method => {
      if (method === 'type_text' && failOnce) { failOnce = false; throw new ComputerUseError(code, 'Fixture outcome lacks delivery proof.'); }
    };
    const first = await observe(controller);
    await assert.rejects(controller.execute('type_text', { window, observation_id: first.observation_id, text: 'original' }, context), error => {
      assert.equal(error.code, code);
      assert.equal(error.details.native_request_dispatched, true);
      assert.equal(error.details.input_outcome, 'unknown');
      return true;
    });
    const fresh = await observe(controller);
    await rejected(controller.execute('type_text', { window, observation_id: fresh.observation_id, text: 'replay', method: 'paste' }, context), 'INPUT_PAUSED');
    const pointer = await controller.execute('get_window_state', { window }, context);
    await controller.execute('click', click(pointer), context);
    assert.equal(backend.calls.filter(call => call.method === 'type_text').length, 1);
    assert.equal(backend.calls.filter(call => call.method === 'click').length, 1);
  });
}

test('an untyped backend exception becomes an uncertain error and pauses the dispatched input channel', async t => {
  const { backend, controller } = setup(t);
  let failOnce = true;
  backend.hook = method => {
    if (method === 'press_key' && failOnce) { failOnce = false; throw new Error('Fixture undocumented native failure.'); }
  };
  const first = await observe(controller);
  await assert.rejects(controller.execute('press_key', { window, observation_id: first.observation_id, key: 'Return' }, context), error => {
    assert.ok(error instanceof ComputerUseError);
    assert.equal(error.code, 'BACKEND_ERROR');
    assert.equal(error.details.input_outcome, 'unknown');
    return true;
  });
  const fresh = await observe(controller);
  await rejected(controller.execute('press_key', { window, observation_id: fresh.observation_id, key: 'Return', mode: 'scan-code' }, context), 'INPUT_PAUSED');
  assert.equal(backend.calls.filter(call => call.method === 'press_key').length, 1);
});

test('native prechecks that prove zero input permit a new request after reobservation', async t => {
  for (const code of ['FOCUS_FAILED', 'INVALID_KEY', 'KEYBOARD_BUSY']) {
    const { backend, controller } = setup(t);
    let failOnce = true;
    backend.hook = method => {
      if (method === 'press_key' && failOnce) { failOnce = false; throw new ComputerUseError(code, 'Fixture pre-input refusal.'); }
    };
    const first = await observe(controller);
    await assert.rejects(controller.execute('press_key', { window, observation_id: first.observation_id, key: 'Return' }, context), error => {
      assert.equal(error.code, code);
      assert.equal(error.details.native_request_dispatched, true);
      assert.equal(error.details.input_outcome, 'not_sent');
      return true;
    });
    const fresh = await controller.execute('get_window_state', { window }, context);
    await controller.execute('press_key', { window, observation_id: fresh.observation_id, key: 'Return' }, context);
    assert.equal(backend.calls.filter(call => call.method === 'press_key').length, 2);
  }
});

test('a target integrity refusal during pointer input is not claimed to prove zero input', async t => {
  const { backend, controller } = setup(t);
  backend.hook = method => { if (method === 'click') throw new ComputerUseError('INPUT_TARGET_BLOCKED', 'Fixture target changed during repeated clicks.'); };
  const first = await observe(controller);
  await assert.rejects(controller.execute('click', { ...click(first), click_count: 2 }, context), error => {
    assert.equal(error.code, 'INPUT_TARGET_BLOCKED');
    assert.equal(error.details.input_outcome, 'unknown');
    return true;
  });
  const fresh = await controller.execute('get_window_state', { window }, context);
  await rejected(controller.execute('press_key', { window, observation_id: fresh.observation_id, key: 'Return' }, context), 'INPUT_PAUSED');
  assert.equal(backend.calls.filter(call => call.method === 'press_key').length, 0);
});
