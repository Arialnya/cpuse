import test from 'node:test';
import assert from 'node:assert/strict';
import { assessRisk } from '../lib/risk.js';
import { validate } from '../lib/validation.js';

const window = { id: 20, app: 'C:\\Steam\\steam.exe' };
const state = { window, observation_id: 'fresh',
  accessibility: { tree: '[0] Window "Steam" bounds=(100,100,1000,800)\n[1] Button "PLAY" bounds=(120,120,100,40)\n[2] Button "购买" bounds=(700,700,100,40)\n[3] Edit "Search" value="delete purchase upload" bounds=(300,200,200,40)',
    focused_element: '[3] Edit "Search" value="delete purchase upload"' },
  screenshots: [{ id: 'shot', originX: 100, originY: 100, width: 1000, height: 800 }],
};
const args = { window, observation_id: 'fresh', element_index: 1 };

test('Steam startup, activation, observations and ordinary library input are routine', () => {
  for (const method of ['list_apps', 'find_window', 'get_window_state', 'get_window', 'activate_window'])
    assert.equal(assessRisk(method, args, {}, state).approval, false);
  assert.equal(assessRisk('launch_app', { app: window.app }, {}).approval, false);
  assert.equal(assessRisk('click', args, { intent: '打开游戏库并开始游戏' }, state).approval, false);
  assert.equal(assessRisk('press_key', { ...args, key: 'Return' }, { intent: '确认库内搜索' }, state).approval, false);
  assert.equal(assessRisk('type_text', { ...args, text: 'Slay the Spire 2' }, { intent: '填写搜索关键词' }, state).approval, false);
});

test('explicit high-risk effects and operation intentions require approval', () => {
  for (const risk of ['purchase', 'delete', 'send', 'upload', 'share', 'security', 'sensitive_data', 'unknown'])
    assert.equal(assessRisk('click', args, { risk, intent: 'perform action' }, state).approval, true);
  for (const intent of ['确认购买', '永久删除文件', '发送消息', '上传资料', '共享文件', '修改权限', '输入私钥', 'unknown effect'])
    assert.equal(assessRisk('click', args, { risk: 'routine', intent }, state).approval, true);
});

test('observed purchase controls cannot be downgraded through index or coordinate metadata', () => {
  for (const target of [{ element_index: 2 }, { screenshotId: 'shot', x: 610, y: 610 }]) {
    const risk = assessRisk('click', { window, ...target }, { risk: 'routine', intent: '普通点击' }, state);
    assert.equal(risk.category, 'purchase');
    assert.equal(risk.source, 'observed_control');
  }
  assert.equal(assessRisk('click', { window, screenshotId: 'shot', x: 25, y: 25 }, { intent: '开始游戏' }, state).approval, false);
});

test('focused high-risk controls and drag destinations are checked independently of intent', () => {
  const purchase = { ...state, accessibility: { ...state.accessibility, focused_element: '[2] Button "购买"' } };
  assert.equal(assessRisk('press_key', { key: 'Return' }, { intent: '确认按钮', risk: 'routine' }, purchase).category, 'purchase');
  const trash = { ...state, accessibility: { tree: '[4] Pane "回收站" bounds=(700,700,100,100)' } };
  assert.equal(assessRisk('drag', { screenshotId: 'shot', from_x: 25, from_y: 25, to_x: 610, to_y: 610 }, { intent: '移动项目' }, trash).category, 'delete');
});

test('browsing purchase history and cancelling a dialog stay routine but cannot excuse a purchase button', () => {
  for (const intent of ['查看购买记录', '搜索购买过的游戏', '取消购买确认对话框', 'view purchase history']) {
    assert.equal(assessRisk('click', args, { intent }, state).approval, false);
    assert.equal(assessRisk('click', { ...args, element_index: 2 }, { intent }, state).category, 'purchase');
  }
  assert.equal(assessRisk('click', args, { intent: '查看并购买游戏' }, state).category, 'purchase');
  const page = { ...state, accessibility: { tree: state.accessibility.tree.replace('Window "Steam"', 'Window "购买游戏"') } };
  assert.equal(assessRisk('click', { screenshotId: 'shot', x: 25, y: 25 }, { intent: '打开游戏库' }, page).approval, false);
});

test('delete and submit shortcuts preserve ordinary editing and game controls', () => {
  assert.equal(assessRisk('press_key', { key: 'Delete' }, { intent: '编辑搜索词' }, state).approval, false);
  assert.equal(assessRisk('press_key', { key: 'Shift_L+Delete' }, { intent: '处理当前项' }, state).category, 'delete');
  assert.equal(assessRisk('press_key', { key: 'Control_L+Return' }, { intent: '执行快捷键' }, state).category, 'send');
  const message = { ...state, accessibility: { focused_element: '[4] Edit "Message"', tree: '' } };
  assert.equal(assessRisk('press_key', { key: 'Return' }, { intent: '确认输入' }, message).category, 'send');
  assert.equal(assessRisk('press_key', { key: 'F6' }, { intent: '游戏控制' }, { ...state, accessibility: null }).approval, false);
});

test('installer launches, secret formats and unknown context require approval', () => {
  assert.equal(assessRisk('launch_app', { app: 'C:\\Downloads\\SteamSetup.exe' }, {}).category, 'security');
  assert.equal(assessRisk('type_text', { text: 'sk-' + 'a'.repeat(30) }, { intent: '填入文本' }, state).category, 'sensitive_data');
  assert.equal(assessRisk('click', args, {}, state).category, 'unknown');
  assert.equal(assessRisk('click', args, { intent: '选择项目' }).category, 'unknown');
});

test('risk metadata is bounded and never reaches the native parameter object', () => {
  const input = { ...args, intent: '选择项目', risk: 'routine' };
  assert.deepEqual(validate('click', input), args);
  for (const patch of [{ risk: ['routine'] }, { risk: 'safe' }, { risk: true }, { intent: '' }, { intent: 'x'.repeat(257) }, { intent: 'x\0y' }])
    assert.throws(() => validate('click', { ...input, ...patch }), { code: 'INVALID_ARGUMENT' });
});
