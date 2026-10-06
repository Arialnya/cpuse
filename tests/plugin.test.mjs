import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { Context } from '@deepseek-ai/cordis';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ApprovalService from '@deepseek-ai/dsh-user-approval';
import LlmRuntime, { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm';
import { Session, SessionId } from '@deepseek-ai/dsh-session';
import { AttachmentStore, AttachmentId } from '@deepseek-ai/dsh-attachment';
import ComputerUseRegistry from '@deepseek-ai/dsh-computer-use';
import { ComputerUseProviderName } from '@deepseek-ai/dsh-computer-use/brand';
import * as plugin from '../lib/index.js';
import { NativeBackend } from '../lib/backend.js';
import { methods, ComputerUseError } from '../lib/types.js';

// No test starts the native helper or interacts with the user's desktop.
// Only the native boundary is mocked; Cordis, tool dispatch, approval auditing,
// model capability admission, and MCP-to-Harness image projection are real.
const window = { id: 101, app: 'C:\\Fixture\\editor.exe', title: 'Plugin fixture' };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDb8AAAAASUVORK5CYII=', 'base64');

class MemoryAttachments extends AttachmentStore {
  saved = [];
  imageLimits = {
    maxImageBytes: 1024 * 1024, maxImagesPerMessage: 20,
    maxMessageImageBytes: 1024 * 1024, maxImagePixels: 1024,
    maxImageDimension: 32, mediaTypes: ['image/png'],
  };
  async validateImage(input) {
    assert.equal(input.mediaType, 'image/png');
    assert.deepEqual(Buffer.from(input.data), png);
  }
  async saveImage(input) {
    await this.validateImage(input);
    const ref = {
      attachmentId: AttachmentId(createHash('sha256').update(input.data).digest('hex')),
      mediaType: 'image/png', bytes: input.data.length, width: 1, height: 1,
    };
    this.saved.push({ data: Buffer.from(input.data), ref });
    return ref;
  }
}

class FixtureModel extends LlmAdapter {
  constructor(image, resolveHook) { super(); this.image = image; this.resolveHook = resolveHook; }
  async resolveModel(provider, model, signal) {
    signal?.throwIfAborted();
    await this.resolveHook?.(signal);
    signal?.throwIfAborted();
    return { provider, id: model, name: model, inputModalities: this.image ? ['text', 'image'] : ['text'] };
  }
  async *stream() { throw new Error('The test must not call a real or fixture model.'); }
}

async function setup(t, options = {}) {
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  const calls = [];
  const closed = new Set();
  const pending = new Map();
  let serial = 0;
  t.mock.method(NativeBackend.prototype, 'call', async function (method, params, signal) {
    signal?.throwIfAborted();
    if (closed.has(this)) throw new ComputerUseError('CLOSED', 'Fixture closed.');
    calls.push({ method, params: structuredClone(params), signal });
    if (options.hook) {
      const overridden = await options.hook(method, params, signal, this, pending);
      if (overridden !== undefined) return overridden;
    }
    if (method === 'list_windows') return [structuredClone(window)];
    if (method === 'list_apps') return [{ id: window.app, windows: [structuredClone(window)] }];
    if (method === 'get_window') return structuredClone(window);
    if (method === 'get_window_state') return {
      window: structuredClone(params.window), observation_id: `observation-${++serial}`,
      accessibility: { tree: '[0] Edit', focused_element: '[0] Edit' },
      input: { injection: 'allowed', focus: { source: 'uia', in_window: true, password: 'no', can_type: true }, text_methods: ['unicode', 'paste'] },
      screenshots: params.include_screenshot ? [{
        id: `screenshot-${serial}`, url: `data:image/png;base64,${png.toString('base64')}`,
        width: 1, height: 1, originX: 0, originY: 0, zIndex: 0,
      }] : [],
    };
    if (method === 'capabilities') return { target: 'windows', fixture: true };
    return null;
  });
  t.mock.method(NativeBackend.prototype, 'close', async function () {
    await options.closeHook?.(this);
    closed.add(this);
    pending.get(this)?.reject(new ComputerUseError('CLOSED', 'Fixture closed.'));
    pending.delete(this);
  });
  await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false });
  await ctx.plugin(ToolRuntime, { mode: 'native' });
  if (options.computerUse) await ctx.plugin(ComputerUseRegistry);
  if (options.approval !== false) await ctx.plugin(ApprovalService, { policy: options.policy ?? 'ask' });
  if (options.image !== undefined) {
    await ctx.plugin(LlmRuntime);
    ctx.llm.registerAdapter(['fixture'], new FixtureModel(options.image, options.modelHook));
    await ctx.plugin(MemoryAttachments);
  }
  if (options.answer) ctx.on('approval/request', options.answer);
  const fiber = await ctx.plugin(plugin, { screenshots: true, approvalMode: 'always', ...options.config });
  const agent = makeAgent();
  let callSerial = 0;
  const execute = (method, args = {}, execution = {}) => ctx.tools.execute({
    callId: ToolCallId(`fixture-${++callSerial}`), name: `computer_use_${method}`,
    arguments: args, agent, signal: new AbortController().signal, ...execution,
  });
  return { ctx, fiber, calls, closed, pending, agent, execute };
}

function makeAgent() {
  const id = SessionId(randomUUID());
  const session = Session.create(id);
  session.append('turn/start', { turn: 1 });
  return { id, session, options: { provider: 'fixture', model: 'fixture-model' } };
}

function canonical(result) {
  assert.equal(result.isError, false, result.content.map(b => b.text ?? '').join('\n'));
  return result.value.structuredContent;
}
async function observe(execute) {
  canonical(await execute('list_windows'));
  return canonical(await execute('get_window_state', { window }));
}

test('real Cordis mounts every computer-use tool and guidance, and unload removes both', async t => {
  const { ctx, fiber, calls, closed } = await setup(t);
  const names = methods.map(method => `computer_use_${method}`);
  assert.deepEqual(ctx.tools.schemas().map(tool => tool.name).sort(), [...names].sort());
  const assembled = await ctx.systemPrompt.assemble();
  assert.equal(assembled.tools.length, methods.length);
  const guidance = assembled.sections.find(section => section.name === 'computer-use:cpuse');
  assert.ok(guidance);
  assert.match(guidance.text, /observation_id/);
  assert.equal(calls.length, 0);
  await fiber.dispose();
  assert.equal(ctx.tools.schemas().length, 0);
  assert.equal((await ctx.systemPrompt.assemble()).sections.some(section => section.name === 'computer-use:cpuse'), false);
  assert.equal(closed.size, 1);
});

test('the optional real computer-use registry prevents a second cpuse provider', async t => {
  const { ctx, fiber, calls } = await setup(t, { computerUse: true });
  assert.equal(ctx.computerUse.providerName, 'cpuse');
  const competing = ctx.plugin(plugin, { screenshots: false });
  await assert.rejects(competing.await(), /computer use provider "cpuse" is already registered/);
  assert.equal(ctx.computerUse.providerName, 'cpuse');
  assert.equal(ctx.tools.schemas().length, methods.length);
  assert.equal(calls.length, 0);
  await competing.dispose();
  await fiber.dispose();
  assert.equal(ctx.computerUse.providerName, undefined);
});

test('provider ownership remains reserved until asynchronous native shutdown finishes', async t => {
  let entered;
  let release;
  const started = new Promise(resolve => { entered = resolve; });
  const { ctx, fiber } = await setup(t, {
    computerUse: true,
    closeHook: () => new Promise(resolve => { release = resolve; entered(); }),
  });
  const disposing = fiber.dispose();
  await started;
  try {
    assert.equal(ctx.computerUse.providerName, 'cpuse');
    assert.throws(() => ctx.computerUse.register(ComputerUseProviderName('fixture-replacement')), /already registered/);
  } finally {
    release();
    await disposing;
  }
  assert.equal(ctx.computerUse.providerName, undefined);
  const replacement = await ctx.plugin({
    name: 'fixture-replacement', inject: ['computerUse'],
    apply(inner) { inner.computerUse.register(ComputerUseProviderName('fixture-replacement')); },
  });
  assert.equal(ctx.computerUse.providerName, 'fixture-replacement');
  await replacement.dispose();
  assert.equal(ctx.computerUse.providerName, undefined);
});

test('missing Harness approval support denies observation and input before native dispatch', async t => {
  const { execute, calls } = await setup(t, { approval: false });
  canonical(await execute('list_windows'));
  const result = await execute('get_window_state', { window });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Computer Use|approval/);
  const click = await execute('click', { window, observation_id: 'invented', element_index: 0 });
  assert.equal(click.isError, true);
  assert.deepEqual(calls.map(call => call.method), ['list_windows']);
});

test('actual ApprovalService never policy rejects even a later allow answerer', async t => {
  let answers = 0;
  const { execute, calls, agent } = await setup(t, { policy: 'never', answer: async () => { answers++; return 'allowed-once'; } });
  canonical(await execute('list_windows'));
  const result = await execute('get_window_state', { window });
  assert.equal(result.isError, true);
  assert.equal(answers, 0);
  assert.deepEqual(calls.map(call => call.method), ['list_windows']);
  const audit = agent.session.snapshotEvents().filter(event => event.type.startsWith('approval/'));
  assert.deepEqual(audit.map(event => event.type), ['approval/asked', 'approval/decided']);
  assert.equal(audit[1].data.outcome, 'rejected');
});

test('trustedApps skips the host approval ask for observation and input under the never policy', async t => {
  let answers = 0;
  const { execute, calls, agent } = await setup(t, {
    policy: 'never',
    config: { trustedApps: ['c:/fixture/EDITOR.exe'] },
    answer: async () => { answers++; return 'allowed-once'; },
  });
  canonical(await execute('list_windows'));
  const state = canonical(await execute('get_window_state', { window }));
  const action = canonical(await execute('click', { window, observation_id: state.observation_id, element_index: 0 }));
  assert.equal(action.success, true);
  assert.equal(answers, 0);
  assert.deepEqual(agent.session.snapshotEvents().filter(event => event.type.startsWith('approval/')), []);
  assert.deepEqual(calls.map(call => call.method), ['list_windows', 'get_window_state', 'click', 'get_window_state']);
});

test('trustedApps leaves every unlisted application behind the approval ask', async t => {
  const requests = [];
  const { execute, calls } = await setup(t, {
    config: { trustedApps: ['C:\\Fixture\\other.exe'] },
    answer: async request => { requests.push(request.toolName); return 'allowed-once'; },
  });
  await observe(execute);
  assert.deepEqual(requests, ['computer_use_get_window_state']);
  assert.deepEqual(calls.map(call => call.method), ['list_windows', 'get_window_state']);
});

test('trustedApps cannot re-enable an application denied by policy or built-in exclusion', async t => {
  const { execute, calls } = await setup(t, {
    policy: 'never',
    config: { trustedApps: [window.app], deniedApps: [window.app] },
  });
  canonical(await execute('list_windows'));
  const denied = await execute('get_window_state', { window });
  assert.equal(denied.isError, true);
  assert.match(denied.content[0].text, /excluded by the Computer Use policy/);
  assert.deepEqual(calls.map(call => call.method), ['list_windows']);
});

test('a sandboxed helper reports INPUT_BLOCKED instead of a silent success', async t => {
  const { execute, calls } = await setup(t, {
    config: { trustedApps: [window.app] },
    hook: (method) => {
      if (method === 'click') throw new ComputerUseError('INPUT_BLOCKED', 'Cannot inject desktop input for click: the native helper runs with a low integrity token.');
      return undefined;
    },
  });
  canonical(await execute('list_windows'));
  const state = canonical(await execute('get_window_state', { window }));
  const clicked = await execute('click', { window, observation_id: state.observation_id, element_index: 0 });
  assert.equal(clicked.isError, true);
  assert.match(clicked.content[0].text, /INPUT_BLOCKED|low integrity token/);
  assert.deepEqual(calls.map(call => call.method), ['list_windows', 'get_window_state', 'click']);
});

test('approved image observation becomes a verified attachment reference while screenshot coordinates remain canonical', async t => {
  const { ctx, execute, calls } = await setup(t, { image: true, answer: async () => 'allowed-once' });
  canonical(await execute('list_windows'));
  const result = await execute('get_window_state', { window });
  const state = canonical(result);
  assert.equal(state.screenshots[0].url, undefined);
  assert.equal(state.screenshots[0].id, 'screenshot-1');
  assert.equal(state.screenshots[0].width, 1);
  const image = result.content.find(block => block.type === 'image');
  assert.ok(image);
  assert.deepEqual(image.attachment, ctx.attachments.saved[0].ref);
  assert.equal(ctx.attachments.saved.length, 1);
  assert.deepEqual(ctx.attachments.saved[0].data, png);
  assert.equal(result.value.content[1].data, png.toString('base64'));
  assert.equal(result.content.some(block => block.type === 'text' && block.text.includes(png.toString('base64'))), false);
  assert.deepEqual(calls.map(call => call.method), ['list_windows', 'get_window_state']);
});

test('text-only route preserves programmatic image bytes but sends a diagnostic and stores no image', async t => {
  const { ctx, execute } = await setup(t, { image: false, answer: async () => 'allowed-once' });
  canonical(await execute('list_windows'));
  const result = await execute('get_window_state', { window });
  canonical(result);
  assert.equal(result.content.some(block => block.type === 'image'), false);
  assert.match(result.content.map(block => block.text ?? '').join('\n'), /does not declare image input/);
  assert.equal(ctx.attachments.saved.length, 0);
  assert.equal(result.value.content[1].data, png.toString('base64'));
});

test('always policy reapproves input after successful observation and returns fresh state', async t => {
  const requests = [];
  const { execute } = await setup(t, { config: { approvalMode: 'always' }, answer: async request => { requests.push(request.toolName); return 'allowed-once'; } });
  const first = await observe(execute);
  const action = canonical(await execute('click', { window, observation_id: first.observation_id, element_index: 0 }));
  assert.equal(action.success, true);
  assert.notEqual(action.state.observation_id, first.observation_id);
  assert.deepEqual(requests, ['computer_use_get_window_state', 'computer_use_click']);
});

test('always policy separately gates activation and launch after approving that app', async t => {
  const requests = [];
  const { execute, calls } = await setup(t, {
    config: { approvalMode: 'always' },
    answer: async request => {
      requests.push(request.toolName);
      return request.toolName === 'computer_use_get_window_state' ? 'allowed-once' : 'rejected';
    },
  });
  await observe(execute);
  assert.equal((await execute('activate_window', { window })).isError, true);
  assert.equal((await execute('launch_app', { app: window.app })).isError, true);
  assert.deepEqual(requests, ['computer_use_get_window_state', 'computer_use_activate_window', 'computer_use_launch_app']);
  assert.deepEqual(calls.map(call => call.method), ['list_windows', 'get_window_state']);
});

test('approval is owned by each Harness agent in app approval mode', async t => {
  const requests = [];
  const { execute } = await setup(t, { config: { approvalMode: 'app' }, answer: async request => { requests.push(request.agent.id); return 'allowed-once'; } });
  await observe(execute);
  const secondAgent = makeAgent();
  canonical(await execute('get_window_state', { window }, { agent: secondAgent }));
  assert.equal(requests.length, 2);
  assert.notEqual(requests[0], requests[1]);
});

test('an existing pre-execute denial remains authoritative and cannot spawn the backend', async t => {
  let answers = 0;
  const { ctx, execute, calls } = await setup(t, { answer: async () => { answers++; return 'allowed-once'; } });
  ctx.on('tools/pre-execute', async () => ({ kind: 'deny', reason: 'Fixture deployment policy.' }));
  const result = await execute('get_window_state', { window });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Fixture deployment policy/);
  assert.equal(answers, 0);
  assert.equal(calls.length, 0);
});

test('cancelled approval ignores a late grant and never invokes native input', async t => {
  let release;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const { execute, calls } = await setup(t, { answer: async () => { entered(); return new Promise(resolve => { release = resolve; }); } });
  const abort = new AbortController();
  const pending = execute('get_window_state', { window }, { signal: abort.signal });
  await started;
  abort.abort(new Error('Fixture interrupt.'));
  const result = await pending;
  assert.equal(result.isError, true);
  assert.equal(calls.length, 0);
  release('allowed-once');
  await Promise.resolve();
  assert.equal(calls.length, 0);
});

test('pre-aborted calls never pass approval or invoke a native method', async t => {
  let answers = 0;
  const { execute, calls } = await setup(t, { answer: async () => { answers++; return 'allowed-once'; } });
  const abort = new AbortController();
  abort.abort();
  const result = await execute('list_windows', {}, { signal: abort.signal });
  assert.equal(result.isError, true);
  assert.equal(calls.length, 0);
  assert.equal(answers, 0);
});

test('plugin disposal closes its pending backend operation and removes model tools', async t => {
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const { ctx, fiber, execute, calls } = await setup(t, {
    hook: async (method, _args, _signal, backend, pending) => {
      if (method !== 'list_windows') return undefined;
      entered();
      return new Promise((resolve, reject) => pending.set(backend, { resolve, reject }));
    },
  });
  const invocation = execute('list_windows');
  await started;
  await fiber.dispose();
  const result = await invocation;
  assert.equal(result.isError, true);
  assert.match(result.content.map(block => block.text ?? '').join('\n'), /closed|stopped/i);
  assert.equal(ctx.tools.schemas().length, 0);
  assert.equal(calls.length, 1);
});

test('unload cancels in-flight MCP image admission and waits for the tool to settle', async t => {
  let entered;
  let observedAbort;
  let rejectResolver;
  let modelSignal;
  const started = new Promise(resolve => { entered = resolve; });
  const aborted = new Promise(resolve => { observedAbort = resolve; });
  const { ctx, fiber, execute } = await setup(t, {
    computerUse: true,
    image: true,
    answer: async () => 'allowed-once',
    modelHook: signal => {
      modelSignal = signal;
      return new Promise((_resolve, reject) => {
        rejectResolver = reject;
        // Keep admission pending after cancellation to verify ownership lasts
        // until even a slow model adapter has settled.
        signal.addEventListener('abort', observedAbort, { once: true });
        entered();
      });
    },
  });
  canonical(await execute('list_windows'));
  let settled = false;
  const invocation = execute('get_window_state', { window }).then(result => { settled = true; return result; });
  await started;
  const disposing = fiber.dispose();
  try {
    await aborted;
    assert.equal(modelSignal.aborted, true);
    assert.equal(settled, false);
    assert.equal(ctx.computerUse.providerName, 'cpuse');
    rejectResolver(modelSignal.reason);
    await disposing;
    assert.equal(settled, true, 'Unloading must await the entire MCP projection, not only the native call.');
    assert.equal((await invocation).isError, true);
    assert.equal(ctx.attachments.saved.length, 0);
    assert.equal(ctx.computerUse.providerName, undefined);
  } finally {
    // Settle the controlled fixture even when testing a broken lifecycle.
    rejectResolver(new Error('Fixture finished.'));
    await invocation;
    await disposing;
  }
});

function diagnostic(result, code) {
  assert.equal(result.isError, true);
  assert.equal(result.error.info.code, code, 'The Harness failure must retain its machine-readable code.');
  const value = JSON.parse(result.error.message);
  assert.equal(value.code, code);
  assert.equal(value.recovery.automatic_retry, false);
  return value;
}

test('structured focus failures retain real Harness errors without sending or disclosing typed text', async t => {
  const { execute, calls } = await setup(t, {
    config: { trustedApps: [window.app] },
    hook: (method, params) => method === 'get_window_state' ? {
      window: params.window, observation_id: 'no-text-focus', accessibility: null, screenshots: [],
      input: { injection: 'allowed', focus: { source: 'win32', in_window: true, password: 'unknown', can_type: false }, text_methods: [] },
    } : undefined,
  });
  const state = await observe(execute);
  const result = await execute('type_text', { window, observation_id: state.observation_id, text: 'private literal payload' });
  const failure = diagnostic(result, 'FOCUS_UNKNOWN');
  assert.equal(failure.operation, 'type_text');
  assert.equal(failure.native_request_dispatched, false);
  assert.equal(failure.input_outcome, 'not_sent');
  assert.equal(failure.recovery.next_action, 'observe_then_select_focus_once');
  assert.ok(failure.recovery.allowed_methods.includes('press_key'));
  assert.deepEqual(failure.target, { id: window.id, app: window.app });
  assert.equal(result.error.message.includes('private literal payload'), false);
  assert.equal(calls.filter(call => call.method === 'type_text').length, 0);
});

test('input uncertainty stays an error and pauses replay across fresh snapshots and text methods', async t => {
  const { execute, calls } = await setup(t, {
    config: { trustedApps: [window.app], allowClipboardPaste: true },
    hook: method => { if (method === 'type_text') throw new ComputerUseError('INPUT_PARTIAL', 'The fixture inserted only part of an input batch.'); },
  });
  const state = await observe(execute);
  const failed = diagnostic(await execute('type_text', { window, observation_id: state.observation_id, text: 'original' }), 'INPUT_PARTIAL');
  assert.equal(failed.native_request_dispatched, true);
  assert.equal(failed.input_outcome, 'unknown');
  assert.equal(failed.recovery.human_required, true);
  assert.equal(failed.recovery.next_action, 'stop_input_and_report');
  const fresh = canonical(await execute('get_window_state', { window }));
  const paused = diagnostic(await execute('type_text', { window, observation_id: fresh.observation_id, text: 'retry', method: 'paste' }), 'INPUT_PAUSED');
  assert.equal(paused.original_code, 'INPUT_PARTIAL');
  assert.equal(paused.native_request_dispatched, false);
  assert.equal(calls.filter(call => call.method === 'type_text').length, 1);
});

test('an input channel stop leaves unrelated legitimate Harness tools usable', async t => {
  const { ctx, execute, calls, agent } = await setup(t, {
    config: { trustedApps: [window.app] },
    hook: method => { if (method === 'press_key') throw new ComputerUseError('INPUT_TARGET_BLOCKED', 'Fixture target has greater integrity.'); },
  });
  ctx.tools.register({
    name: 'fixture_legitimate_read', description: 'An unrelated read-only fixture tool.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async () => 'still available',
  });
  const state = await observe(execute);
  diagnostic(await execute('press_key', { window, observation_id: state.observation_id, key: 'Return', mode: 'scan-code' }), 'INPUT_TARGET_BLOCKED');
  const fresh = canonical(await execute('get_window_state', { window }));
  diagnostic(await execute('click', { window, observation_id: fresh.observation_id, element_index: 0 }), 'INPUT_PAUSED');
  const result = await ctx.tools.execute({
    callId: ToolCallId('unrelated-fixture-call'), name: 'fixture_legitimate_read', arguments: {}, agent,
    signal: new AbortController().signal,
  });
  assert.equal(result.isError, false);
  assert.equal(result.value, 'still available');
  assert.equal(calls.filter(call => call.method === 'press_key').length, 1);
  assert.equal(calls.filter(call => call.method === 'click').length, 0);
});

test('game window searches remain read-only under never approval and do not authorize observation', async t => {
  const game = { id: 222, app: 'C:\Games\sts2.exe', title: '', process_name: 'sts2.exe' };
  let asks = 0;
  const { execute, calls } = await setup(t, {
    policy: 'never', answer: async () => { asks++; return 'allowed-once'; },
    hook: method => method === 'list_windows' ? [game] : undefined,
  });
  const found = canonical(await execute('find_window', { query: '杀戮尖塔2' }));
  assert.deepEqual(found.windows, [game]);
  assert.equal(found.matched, true);
  const observed = await execute('get_window_state', { window: found.windows[0] });
  assert.equal(observed.isError, true);
  assert.equal(asks, 0);
  assert.deepEqual(calls.map(call => call.method), ['list_windows']);
});

test('risk is the new default and routine Steam work proceeds without approval requests', async t => {
  const steam = { id: 200, app: 'C:\\Program Files (x86)\\Steam\\steam.exe', title: 'Steam' };
  let asks = 0;
  const { execute, calls } = await setup(t, { config: { approvalMode: undefined }, policy: 'never',
    answer: async () => { asks++; return 'rejected'; },
    hook: method => method === 'list_windows' ? [steam] : undefined });
  canonical(await execute('launch_app', { app: steam.app }));
  canonical(await execute('list_windows'));
  canonical(await execute('get_window', { id: steam.id }));
  canonical(await execute('activate_window', { window: steam }));
  let state = canonical(await execute('get_window_state', { window: steam }));
  state = canonical(await execute('click', { window: steam, observation_id: state.observation_id, element_index: 0, intent: '打开Steam游戏库' })).state;
  state = canonical(await execute('type_text', { window: steam, observation_id: state.observation_id, text: 'Slay the Spire 2', intent: '填写游戏搜索词' })).state;
  canonical(await execute('press_key', { window: steam, observation_id: state.observation_id, key: 'Return', intent: '确认库内搜索' }));
  assert.equal(asks, 0);
  assert.equal(calls.filter(call => call.method === 'launch_app').length, 1);
  assert.equal(calls.some(call => Object.hasOwn(call.params, 'intent') || Object.hasOwn(call.params, 'risk')), false);
});

test('risk approval is one action at a time even for trusted applications', async t => {
  const requests = [];
  const { execute } = await setup(t, { config: { approvalMode: 'risk', trustedApps: [window.app] },
    answer: async req => { requests.push(req); return 'allowed-once'; } });
  for (const risk of ['purchase', 'delete', 'send', 'upload', 'share', 'security', 'sensitive_data']) {
    const state = await observe(execute);
    canonical(await execute('click', { window, observation_id: state.observation_id, element_index: 0, intent: 'perform this action', risk }));
  }
  assert.equal(requests.length, 7);
  assert.equal(new Set(requests.map(req => req.callId)).size, 7);
});

test('risk mode does not trust routine metadata over a real purchase control', async t => {
  let asks = 0;
  const { execute, calls } = await setup(t, { config: { approvalMode: 'risk' },
    answer: async () => { asks++; return 'rejected'; },
    hook: (method, params) => method === 'get_window_state' ? { window: params.window, observation_id: 'buy-state',
      accessibility: { tree: '[0] Button "购买"', focused_element: '[0] Button "购买"' }, screenshots: [] } : undefined });
  const state = await observe(execute);
  diagnostic(await execute('click', { window, observation_id: state.observation_id, element_index: 0, intent: '普通点击', risk: 'routine' }), 'RISK_APPROVAL_REJECTED');
  assert.equal(asks, 1);
  assert.equal(calls.some(call => call.method === 'click'), false);
});

test('risk mode allows routine reading without an approval service but refuses high-risk dispatch', async t => {
  const { execute, calls } = await setup(t, { approval: false, config: { approvalMode: 'risk' } });
  const state = await observe(execute);
  diagnostic(await execute('click', { window, observation_id: state.observation_id, element_index: 0, intent: '确认购买' }), 'RISK_APPROVAL_UNAVAILABLE');
  assert.equal(calls.some(call => call.method === 'click'), false);
});

test('never policy and a later allow hook cannot bypass high-risk body approval', async t => {
  const { ctx, execute, calls } = await setup(t, { policy: 'never', config: { approvalMode: 'risk', trustedApps: [window.app] }, answer: async () => 'allowed-once' });
  ctx.on('tools/pre-execute', async () => ({ kind: 'allow' }));
  const state = await observe(execute);
  diagnostic(await execute('click', { window, observation_id: state.observation_id, element_index: 0, intent: '确认购买' }), 'RISK_APPROVAL_REJECTED');
  assert.equal(calls.some(call => call.method === 'click'), false);
});

test('risk mode retains upstream denial for otherwise routine work', async t => {
  const { ctx, execute, calls } = await setup(t, { config: { approvalMode: 'risk' } });
  ctx.on('tools/pre-execute', async () => ({ kind: 'deny', reason: 'Deployment restriction' }));
  const result = await execute('launch_app', { app: 'C:\\Steam\\steam.exe' });
  assert.equal(result.isError, true);
  assert.equal(calls.length, 0);
});

test('cancellation during risk approval never dispatches the pending input', async t => {
  let enter, grant;
  const entered = new Promise(resolve => { enter = resolve; });
  const pending = new Promise(resolve => { grant = resolve; });
  const { execute, calls } = await setup(t, { config: { approvalMode: 'risk' }, answer: async () => { enter(); return pending; } });
  const state = await observe(execute);
  const cancelled = new AbortController();
  const operation = execute('click', { window, observation_id: state.observation_id, element_index: 0, intent: '确认购买' }, { signal: cancelled.signal });
  await entered; cancelled.abort(); grant('allowed-once');
  const result = await operation;
  assert.equal(result.isError, true);
  assert.equal(calls.some(call => call.method === 'click'), false);
});
