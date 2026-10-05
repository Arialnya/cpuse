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
  const fiber = await ctx.plugin(plugin, { screenshots: true, ...options.config });
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

test('real Cordis mounts all 14 tools and guidance, and unload removes both', async t => {
  const { ctx, fiber, calls, closed } = await setup(t);
  const names = methods.map(method => `computer_use_${method}`);
  assert.deepEqual(ctx.tools.schemas().map(tool => tool.name).sort(), [...names].sort());
  const assembled = await ctx.systemPrompt.assemble();
  assert.equal(assembled.tools.length, 14);
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
  assert.equal(ctx.tools.schemas().length, 14);
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
