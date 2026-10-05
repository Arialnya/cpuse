import { createComputerUse } from '../lib/client.js';

const sky = createComputerUse({ screenshots: false });
try {
  const apps = await sky.list_apps();
  if (!process.env.CPUSE_APP) {
    console.log(JSON.stringify(apps.map(app => ({ id: app.id, name: app.displayName, windows: app.windows.length })), null, 2));
  } else {
    const candidates = apps.filter(app => app.id.toLowerCase() === process.env.CPUSE_APP.toLowerCase())
      .flatMap(app => app.windows).filter(window => !process.env.CPUSE_TITLE || window.title === process.env.CPUSE_TITLE);
    if (candidates.length !== 1) throw new Error(`Expected exactly one target; found ${candidates.length}. Set CPUSE_TITLE if needed.`);
    const state = await sky.get_window_state({ window: candidates[0], include_screenshot: false, include_text: true });
    console.log(JSON.stringify(state, null, 2));
  }
} finally { await sky.dispose(); }
