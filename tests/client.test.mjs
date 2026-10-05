import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createComputerUse } from '../lib/client.js';

const windowsOnly = { skip: process.platform !== 'win32' };
const fixture = fileURLToPath(new URL('./fixtures/jsonl-helper.mjs', import.meta.url));
function setup(t, options = {}) {
  const client = createComputerUse({ helperPath: process.execPath, helperArgs: [fixture], ...options });
  t.after(() => client.dispose());
  return client;
}

test('the sky-style facade caches observation tokens and the latest verified state', windowsOnly, async t => {
  const client = setup(t);
  assert.equal(client.target, 'windows');
  const [window] = await client.list_windows();
  const state = await client.get_window_state({ window });
  assert.equal(client.lastState.observation_id, state.observation_id);
  assert.equal(await client.click({ window, x: 0, y: 0 }), undefined);
  assert.notEqual(client.lastState.observation_id, state.observation_id);
  const capabilities = await client.capabilities();
  const click = capabilities.fixture_calls.find(call => call.method === 'click');
  assert.equal(click.params.observation_id, state.observation_id);
  assert.equal(click.params.screenshotId, state.screenshots[0].id);
});

test('typing, value replacement and secondary actions use updated observations', windowsOnly, async t => {
  const client = setup(t);
  const [window] = await client.list_windows();
  await client.get_window_state({ window });
  await client.type_text({ window, text: '中文🙂\n' });
  await client.set_value({ window, element_index: 0, value: '' });
  await client.perform_secondary_action({ window, element_index: 0, action: 'Expand' });
  const calls = (await client.capabilities()).fixture_calls;
  const inputs = calls.filter(c => ['type_text', 'set_value', 'perform_secondary_action'].includes(c.method));
  assert.deepEqual(inputs.map(c => c.params.observation_id), ['observation-1', 'observation-2', 'observation-3']);
  assert.equal(inputs[0].params.text, '中文🙂\n');
  assert.equal(inputs[1].params.value, '');
});

test('a target without a cached snapshot cannot receive input', windowsOnly, async t => {
  const client = setup(t);
  const [window] = await client.list_windows();
  await assert.rejects(client.click({ window, element_index: 0 }), { code: 'STALE_OBSERVATION' });
  await client.get_window_state({ window });
  await assert.rejects(client.click({ window: { ...window, id: 999 }, element_index: 0 }), { code: 'STALE_OBSERVATION' });
  const calls = (await client.capabilities()).fixture_calls;
  assert.equal(calls.filter(c => c.method === 'click').length, 0);
});

test('a text-only snapshot does not invent screenshot coordinates', windowsOnly, async t => {
  const client = setup(t, { screenshots: false });
  const [window] = await client.list_windows();
  const state = await client.get_window_state({ window });
  assert.deepEqual(state.screenshots, []);
  await assert.rejects(client.click({ window, x: 0, y: 0 }), { code: 'AMBIGUOUS_SCREENSHOT' });
  await client.click({ window, element_index: 0 });
});

test('a backend error clears facade state and is never automatically retried', windowsOnly, async t => {
  const client = setup(t);
  const [window] = await client.list_windows();
  await client.get_window_state({ window });
  await assert.rejects(client.type_text({ window, text: 'fixture-error' }), { code: 'FIXTURE_ERROR' });
  assert.equal(client.lastState, undefined);
  await assert.rejects(client.type_text({ window, text: 'again' }), { code: 'STALE_OBSERVATION' });
  const calls = (await client.capabilities()).fixture_calls;
  assert.equal(calls.filter(c => c.method === 'type_text').length, 1);
});

test('launch and disposal invalidate the cached facade state', windowsOnly, async t => {
  const client = setup(t);
  const [window] = await client.list_windows();
  await client.get_window_state({ window });
  await client.launch_app({ app: window.app });
  assert.equal(client.lastState, undefined);
  client.dispose();
  await assert.rejects(client.list_windows(), { code: 'CLOSED' });
});
