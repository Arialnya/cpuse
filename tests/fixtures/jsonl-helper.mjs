import { createInterface } from 'node:readline';

// Protocol-only fixture: never enumerates windows or sends desktop input.
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
const respond = (id, result) => process.stdout.write(JSON.stringify({ id, result }) + '\n');
const window = { id: 101, app: 'C:\\Apps\\editor.exe', title: 'Fixture editor' };
const calls = [];
let observation = 0;
lines.on('line', line => {
  const { id, method, params } = JSON.parse(line);
  calls.push({ method, params });
  if (method === 'list_windows') { respond(id, [window]); return; }
  if (method === 'list_apps') { respond(id, [{ id: window.app, displayName: 'Fixture editor', windows: [window] }]); return; }
  if (method === 'get_window') { respond(id, window); return; }
  if (method === 'get_window_state') {
    const serial = ++observation;
    const screenshot = { id: `image-${serial}`, url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', width: 1, height: 1, originX: 0, originY: 0, zIndex: 0 };
    respond(id, { window, observation_id: `observation-${serial}`, accessibility: params.include_text ? { tree: '[0] Edit', focused_element: '[0] Edit' } : null, screenshots: params.include_screenshot ? [screenshot] : [] });
    return;
  }
  if (method === 'capabilities') { respond(id, { target: 'windows', fixture_calls: calls }); return; }
  if (['click', 'press_key', 'type_text', 'scroll', 'set_value', 'drag', 'perform_secondary_action', 'activate_window', 'launch_app'].includes(method)) {
    if (params.text === 'fixture-error') process.stdout.write(JSON.stringify({ id, error: { code: 'FIXTURE_ERROR', message: 'fixture rejection' } }) + '\n');
    else respond(id, null);
    return;
  }
  if (method === 'silent') return;
  if (method === 'exit') { process.exit(7); return; }
  if (method === 'corrupt') { process.stdout.write('not-json\n'); return; }
  if (method === 'native_error') {
    process.stdout.write(JSON.stringify({ id, error: { code: 'FIXTURE_ERROR', message: 'native rejection' } }) + '\n');
    return;
  }
  if (method === 'fragmented') {
    const response = JSON.stringify({ id, result: { params, pid: process.pid } });
    process.stdout.write('\r\n' + JSON.stringify({ id: -1, result: 'ignored' }) + '\n' + response.slice(0, 4));
    setTimeout(() => process.stdout.write(response.slice(4) + '\r\n'), 5);
    return;
  }
  if (method === 'delayed') {
    setTimeout(() => respond(id, { params, pid: process.pid }), params.delayMs ?? 10);
    return;
  }
  respond(id, { params, pid: process.pid });
});
