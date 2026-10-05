import type { WindowRef } from './types.js';

export interface WindowAlias { name: string; terms: string[] }
export interface FindWindowResult {
  query: string; matched: boolean; ambiguous: boolean; windows: WindowRef[];
  next_action: 'observe_returned_window' | 'choose_from_candidates' | 'ask_user_to_show_window';
  note: string;
}
const normalize = (value: string) => value.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
const builtins: WindowAlias[] = [{ name: '杀戮尖塔2', terms: ['Slay the Spire 2', 'Slay the Spire II', 'sts2'] }];

/** Filter real discovered windows; a search string never creates a window identity. */
export function findWindows(windows: WindowRef[], query: string, aliases: WindowAlias[] = []): FindWindowResult {
  const normalized = normalize(query);
  const terms = new Set([normalized]);
  for (const alias of [...builtins, ...aliases]) {
    const group = [alias.name, ...alias.terms].map(normalize).filter(Boolean);
    if (group.includes(normalized)) group.forEach(term => terms.add(term));
  }
  const matches = windows.map(window => {
    const process = normalize(window.process_name ?? window.app.replaceAll('\\', '/').split('/').at(-1) ?? '');
    const title = normalize(window.title ?? '');
    const app = normalize(window.app);
    const score = Math.max(...[...terms].map(term => !term ? 0 : process.includes(term) ? 3 : title.includes(term) ? 2 : app.includes(term) ? 1 : 0));
    return { window, score };
  }).filter(item => item.score > 0).sort((a, b) => b.score - a.score || Number(!!b.window.is_foreground) - Number(!!a.window.is_foreground));
  return {
    query, matched: matches.length > 0, ambiguous: matches.length > 1, windows: matches.map(item => item.window),
    next_action: matches.length === 0 ? 'ask_user_to_show_window' : matches.length > 1 ? 'choose_from_candidates' : 'observe_returned_window',
    note: matches.length === 0
      ? 'No safely bound visible window matched. Ask the user to open/show the application, or provide its actual process/title. Do not invent a handle, launch a terminal, or change permissions.'
      : 'Select an exact returned window; title/process aliases are search hints, not authorization. Games may have no accessibility text: observe the screenshot and use window coordinates or scan-code keys.',
  };
}
