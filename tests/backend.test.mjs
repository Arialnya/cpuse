import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { NativeBackend } from '../lib/backend.js';

const fixture = fileURLToPath(new URL('./fixtures/jsonl-helper.mjs', import.meta.url));
const windowsOnly = { skip: process.platform !== 'win32' };
function setup(t, timeoutMs = 2000) {
  const backend = new NativeBackend({ helperPath: process.execPath, helperArgs: [fixture], timeoutMs });
  t.after(() => backend.close());
  return backend;
}
const rejected = (promise, code) => assert.rejects(promise, { code });

test('pre-aborted calls and disposed calls never start a helper', async () => {
  const backend = new NativeBackend({ helperPath: 'does-not-exist.exe' });
  const abort = new AbortController(); abort.abort();
  await rejected(backend.call('echo', {}, abort.signal), 'ABORTED');
  backend.close();
  await rejected(backend.call('echo', {}), 'CLOSED');
});

test('a missing helper produces an explicit build diagnostic', windowsOnly, async () => {
  const backend = new NativeBackend({ helperPath: fileURLToPath(new URL('./fixtures/does-not-exist.exe', import.meta.url)) });
  try { await rejected(backend.call('echo', {}), 'HELPER_NOT_BUILT'); }
  finally { backend.close(); }
});

test('JSONL handles UTF-8 data, fragmented lines, empty lines and unknown request IDs', windowsOnly, async t => {
  const backend = setup(t);
  const params = { text: '中文🙂\n`$()', code: 'literal; not shell code' };
  const result = await backend.call('fragmented', params);
  assert.deepEqual(result.params, params);
  assert.equal(typeof result.pid, 'number');
  assert.deepEqual((await backend.call('echo', { number: 17 })).params, { number: 17 });
});

test('out-of-order native responses resolve only their matching request', windowsOnly, async t => {
  const backend = setup(t);
  const result = await Promise.all([
    backend.call('delayed', { marker: 'slow', delayMs: 30 }),
    backend.call('delayed', { marker: 'fast', delayMs: 1 }),
  ]);
  assert.equal(result[0].params.marker, 'slow');
  assert.equal(result[1].params.marker, 'fast');
});

test('native errors are preserved and do not retry the rejected request', windowsOnly, async t => {
  const backend = setup(t);
  const before = await backend.call('echo', {});
  await rejected(backend.call('native_error', {}), 'FIXTURE_ERROR');
  const after = await backend.call('echo', {});
  assert.equal(after.pid, before.pid);
});

test('malformed JSON terminates the helper and rejects pending requests', windowsOnly, async t => {
  const backend = setup(t);
  const before = await backend.call('echo', {});
  const silent = rejected(backend.call('silent', {}), 'PROTOCOL_ERROR');
  const corrupt = rejected(backend.call('corrupt', {}), 'PROTOCOL_ERROR');
  await Promise.all([silent, corrupt]);
  const after = await backend.call('echo', {});
  assert.notEqual(after.pid, before.pid);
});

test('an unexpected helper exit rejects outstanding work and permits a fresh process', windowsOnly, async t => {
  const backend = setup(t);
  const before = await backend.call('echo', {});
  await rejected(backend.call('exit', {}), 'HELPER_EXITED');
  const after = await backend.call('echo', {});
  assert.notEqual(after.pid, before.pid);
});

test('timeouts are explicit and kill the helper without automatic replay', windowsOnly, async t => {
  const backend = setup(t, 300);
  const before = await backend.call('echo', {});
  await rejected(backend.call('silent', {}), 'TIMEOUT');
  const after = await backend.call('echo', {});
  assert.notEqual(after.pid, before.pid);
});

test('active cancellation interrupts every pending request on the private helper', windowsOnly, async t => {
  const backend = setup(t);
  const before = await backend.call('echo', {});
  const abort = new AbortController();
  const a = rejected(backend.call('silent', {}, abort.signal), 'ABORTED');
  const b = rejected(backend.call('silent', {}), 'ABORTED');
  await delay(5); abort.abort();
  await Promise.all([a, b]);
  const after = await backend.call('echo', {});
  assert.notEqual(after.pid, before.pid);
});

test('closing a backend rejects pending and subsequent calls', windowsOnly, async t => {
  const backend = setup(t);
  await backend.call('echo', {});
  const pending = rejected(backend.call('silent', {}), 'CLOSED');
  backend.close();
  await pending;
  await rejected(backend.call('echo', {}), 'CLOSED');
});
