import { actions, type Method, type WindowState } from './types.js';

export const riskCategories = ['auto', 'routine', 'purchase', 'delete', 'send', 'upload', 'share', 'security', 'sensitive_data', 'unknown'] as const;
export type RiskCategory = typeof riskCategories[number];
export interface RiskAssessment { approval: boolean; category: RiskCategory | 'unknown'; source: string }
const rules: [RiskCategory, RegExp][] = [
  ['purchase', /购买|支付|付款|结算|下单|充值|转账|订阅|\b(buy|purchase|pay|payment|checkout|subscribe|transfer money)\b/i],
  ['delete', /删除|永久移除|清空|格式化|卸载|回收站|\b(delete|erase|wipe|format disk|uninstall|trash|recycle bin)\b/i],
  ['send', /发送|提交表单|发表|发布|\b(send|submit|publish|post message)\b/i],
  ['upload', /上传|\b(upload)\b/i],
  ['share', /共享|分享|公开|邀请|\b(share|invite|make public)\b/i],
  ['security', /权限|安全设置|管理员|防火墙|关闭保护|修改密码|允许访问|\b(permission|security|administrator|firewall|disable protection|grant access|change password)\b/i],
  ['sensitive_data', /敏感|私钥|密钥|银行卡|验证码|\b(secret|private key|api key|credit card|verification code)\b/i],
];
function category(text: string): RiskCategory | undefined {
  return rules.find(([, pattern]) => pattern.test(text.normalize('NFKC')))?.[0];
}
// Read control names only. Values/document text may contain unrelated or private data.
function label(line: string) {
  return /^\s*\[\d+\]\s+\S+\s+"((?:\\.|[^"\\])*)"/.exec(line)?.[1] ?? '';
}
function targetLines(method: Method, args: Record<string, unknown>, state: WindowState): string[] {
  const lines = state.accessibility?.tree.split('\n') ?? [];
  if (args.element_index !== undefined) return lines.filter(line => new RegExp(`^\\s*\\[${args.element_index}\\]`).test(line));
  if (method === 'press_key' || method === 'type_text') return state.accessibility?.focused_element ? [state.accessibility.focused_element] : [];
  const shot = state.screenshots.find(image => image.id === args.screenshotId);
  if (!shot) return [];
  const points = method === 'drag' ? [[args.from_x, args.from_y], [args.to_x, args.to_y]] : [[args.x, args.y]];
  return lines.filter(line => {
    // A page/window title describes its context, not the clicked control's effect.
    if (/^\s*\[\d+\]\s+(Window|Pane|Group)\b/i.test(line) && method !== 'drag') return false;
    const match = /bounds=\((-?[\d.]+),(-?[\d.]+),([\d.]+),([\d.]+)\)/.exec(line);
    if (!match) return false;
    const [x, y, width, height] = match.slice(1).map(Number);
    return points.some(([px, py]) => typeof px === 'number' && typeof py === 'number'
      && shot.originX + px >= x && shot.originX + px < x + width && shot.originY + py >= y && shot.originY + py < y + height);
  });
}

/** Conservative hints, not a visual classifier or proof of a button's business meaning. */
export function assessRisk(method: Method, args: Record<string, unknown>, metadata: { intent?: string; risk?: RiskCategory }, state?: WindowState): RiskAssessment {
  const high = (kind: RiskCategory | 'unknown', source: string): RiskAssessment => ({ approval: true, category: kind, source });
  const routine: RiskAssessment = { approval: false, category: 'routine', source: 'routine_operation' };
  if (!actions.has(method) && method !== 'launch_app') return routine;
  if (metadata.risk && !['auto', 'routine'].includes(metadata.risk)) return high(metadata.risk, 'declared_effect');
  if (/无法判断|不确定|未知|\b(unknown|unclear)\b/i.test(metadata.intent ?? '')) return high('unknown', 'uncertain_intent');
  const intent = metadata.intent ?? '';
  const inspection = /^(查看|浏览|搜索|查找|阅读|取消(?:购买|支付|删除|发送|上传)(?:确认|对话框)|view\b|browse\b|search\b|read\b|inspect\b)/i.test(intent)
    && !/然后|并且|并(?:购买|删除|发送|上传|分享|修改)|再(?:购买|删除|发送|上传|分享|修改)|\b(and|then)\b/i.test(intent);
  const intended = inspection ? undefined : category(intent);
  if (intended) return high(intended, 'operation_intent');
  if (method === 'launch_app') {
    const executable = String(args.app).replaceAll('\\', '/').split('/').at(-1) ?? '';
    if (/setup|installer|uninstall|(?:^|[-_.])install(?:[-_.]|$)/i.test(executable)) return high('security', 'installer_launch');
    return routine; // Launching an ordinary discovered app, including steam.exe.
  }
  if (!metadata.intent?.trim()) return high('unknown', 'missing_operation_intent');
  if (!state) return high('unknown', 'missing_fresh_observation');
  if (method === 'scroll') return routine;
  if (method === 'perform_secondary_action' && /^(raise|scroll (up|down|left|right|into view)|expand|collapse)$/i.test(String(args.action))) return routine;
  const targets = targetLines(method, args, state);
  const targetRisk = targets.map(line => category(label(line))).find(Boolean);
  if (targetRisk) return high(targetRisk, 'observed_control');
  if (method === 'press_key') {
    const key = String(args.key).toLowerCase().replaceAll(' ', '');
    const focusedEdit = /^\s*\[\d+\]\s+(edit|document)\b/i.test(state.accessibility?.focused_element ?? '');
    if (/(^|\+)(delete|del)$/.test(key) && (!focusedEdit || /shift/.test(key))) return high('delete', 'destructive_shortcut');
    if (/(ctrl|control)[^+]*\+(return|enter)$/.test(key)) return high('send', 'submit_shortcut');
    if (/(^|\+)(return|enter)$/.test(key) && /消息|聊天|邮件|\b(message|chat|mail)\b/i.test(label(state.accessibility?.focused_element ?? ''))) return high('send', 'message_submit');
  }
  if (method === 'type_text' || method === 'set_value') {
    const text = String(args.text ?? args.value ?? '');
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk-[a-zA-Z0-9]{20,}|AKIA[A-Z0-9]{16})\b/.test(text)) return high('sensitive_data', 'secret_format');
  }
  return routine;
}
