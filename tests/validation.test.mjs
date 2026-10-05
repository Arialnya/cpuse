import test from 'node:test';
import assert from 'node:assert/strict';
import { validate, record, string, number, windowRef } from '../lib/validation.js';

const window = { id: 101, app: 'C:\\Windows\\System32\\notepad.exe' };
const observed = { window, observation_id: 'observation-1' };
const invalid = fn => assert.throws(fn, { code: 'INVALID_ARGUMENT' });

test('the argument boundary rejects primitives, arrays and null', () => {
  for (const value of [undefined, null, [], 12, 'input', true]) invalid(() => record(value));
  assert.deepEqual(validate('list_apps', {}), {});
});

test('strings reject NUL, excessive size and non-string values', () => {
  for (const value of ['', 'a\0b', 12, undefined]) invalid(() => string(value, 'text'));
  invalid(() => string('abcd', 'text', 3));
  assert.equal(string('中文🙂', 'text'), '中文🙂');
});

test('numeric window handles must be finite positive safe integers', () => {
  for (const id of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '101']) {
    invalid(() => windowRef({ id, app: window.app }));
  }
  assert.deepEqual(windowRef({ ...window, title: 'untrusted title' }), window);
  invalid(() => number(Infinity, 'coordinate'));
});

test('click selects exactly one targeting mode and preserves screenshot identity', () => {
  assert.deepEqual(validate('click', { ...observed, element_index: 2 }), { ...observed, element_index: 2 });
  assert.deepEqual(validate('click', { ...observed, x: 4, y: 6, screenshotId: 'image-1' }),
    { ...observed, x: 4, y: 6, screenshotId: 'image-1' });
  for (const args of [
    observed,
    { ...observed, element_index: 2, x: 4, y: 6, screenshotId: 'image-1' },
    { ...observed, x: 4, screenshotId: 'image-1' },
    { ...observed, x: 4, y: 6 },
    { ...observed, element_index: -1 },
  ]) invalid(() => validate('click', args));
});

test('click count and mouse buttons are bounded', () => {
  assert.equal(validate('click', { ...observed, element_index: 0, click_count: 3, mouse_button: 'r' }).mouse_button, 'r');
  for (const extras of [{ click_count: 0 }, { click_count: 4 }, { click_count: 1.5 }, { mouse_button: 'aux' }]) {
    invalid(() => validate('click', { ...observed, element_index: 0, ...extras }));
  }
});

test('all input actions require an observation id', () => {
  const inputs = {
    click: { element_index: 0 }, press_key: { key: 'CTRL+A' }, type_text: { text: 'hello' },
    scroll: { x: 1, y: 2, scrollX: 0, scrollY: 120, screenshotId: 'image-1' },
    drag: { from_x: 1, from_y: 2, to_x: 3, to_y: 4, screenshotId: 'image-1' },
    set_value: { element_index: 0, value: '' },
    perform_secondary_action: { element_index: 0, action: 'invoke' },
  };
  for (const [method, input] of Object.entries(inputs)) {
    invalid(() => validate(method, { window, ...input }));
    assert.equal(validate(method, { ...observed, ...input }).observation_id, observed.observation_id);
  }
});

test('system-key aliases cannot bypass the shortcut restriction', () => {
  for (const key of ['WIN+R', 'Ctrl+Windows', 'meta', 'SUPER_R+L', 'Command+X', 'OS_L']) {
    invalid(() => validate('press_key', { ...observed, key }));
  }
  assert.equal(validate('press_key', { ...observed, key: 'CTRL+SHIFT+LEFT' }).key, 'CTRL+SHIFT+LEFT');
});

test('scroll and drag validate all coordinates and finite deltas', () => {
  const scroll = { ...observed, x: 0, y: 0, scrollX: 0, scrollY: -120, screenshotId: 'image-1' };
  assert.equal(validate('scroll', scroll).scrollY, -120);
  for (const patch of [{ x: -1 }, { y: Infinity }, { scrollY: 10001 }, { scrollX: NaN }, { screenshotId: '' }]) {
    invalid(() => validate('scroll', { ...scroll, ...patch }));
  }
  const drag = { ...observed, from_x: 0, from_y: 0, to_x: 20, to_y: 30, screenshotId: 'image-1' };
  assert.equal(validate('drag', drag).to_y, 30);
  invalid(() => validate('drag', { ...drag, to_y: -1 }));
});

test('set_value permits intentional clearing and type_text preserves literal content', () => {
  assert.equal(validate('set_value', { ...observed, element_index: 0, value: '' }).value, '');
  const text = '中文🙂\n`$()';
  assert.equal(validate('type_text', { ...observed, text }).text, text);
  invalid(() => validate('type_text', { ...observed, text: '' }));
});

test('observation switches are explicit booleans; unknown arguments do not reach native input', () => {
  invalid(() => validate('get_window_state', { window, include_screenshot: 'false' }));
  assert.deepEqual(validate('get_window_state', { window, include_screenshot: false, include_text: true, code: 'ignored' }),
    { window, include_screenshot: false, include_text: true });
  assert.deepEqual(validate('get_window', { id: window.id, app: window.app, command: 'ignored' }),
    { id: window.id, app: window.app });
});

test('window search accepts a bounded query and never forwards invented target identities', () => {
  assert.deepEqual(validate('find_window', { query: '杀戮尖塔 2', id: 999, app: 'invented.exe', command: 'ignored' }),
    { query: '杀戮尖塔 2' });
  for (const query of ['', undefined, 42, 'x'.repeat(257), 'game\0name']) {
    invalid(() => validate('find_window', { query }));
  }
});

test('input modes are explicit and cannot enable a native clipboard or privilege bypass', () => {
  for (const mode of ['virtual-key', 'scan-code']) {
    assert.equal(validate('press_key', { ...observed, key: 'Return', mode }).mode, mode);
  }
  for (const mode of ['scan', 'auto', '', 1, ['scan-code'], { toString: () => 'scan-code' }]) invalid(() => validate('press_key', { ...observed, key: 'Return', mode }));
  for (const method of ['unicode', 'paste']) {
    const result = validate('type_text', { ...observed, text: '中文🙂', method, allow_clipboard_paste: true, run_as_admin: true });
    assert.equal(result.method, method);
    assert.equal(Object.hasOwn(result, 'allow_clipboard_paste'), false);
    assert.equal(Object.hasOwn(result, 'run_as_admin'), false);
  }
  for (const method of ['auto', 'clipboard', '', true, ['paste'], { toString: () => 'unicode' }]) invalid(() => validate('type_text', { ...observed, text: 'hello', method }));
  invalid(() => validate('press_key', { ...observed, key: 'Win+R', mode: 'scan-code' }));
});
