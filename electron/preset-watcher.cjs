// Watches a folder for Resolume preset (.xml) changes. When the user clicks
// Save in Resolume's Shortcut UI, the file's mtime updates and we emit a
// change event to the renderer so it can show a "Resolume just saved this
// preset" reload banner.
//
// Uses chokidar (mature, cross-platform). Falls back to fs.watch if chokidar
// fails to load (e.g. native binding mismatch on Windows).

const path = require('path');

let chokidar = null;
try {
  chokidar = require('chokidar');
} catch {
  chokidar = null;
}

const fs = require('fs');

const state = {
  watcher: null,
  folder: null,
  fallback: null, // { fsWatcher, debounceTimer }
  onChange: null,
};

function setChangeListener(fn) {
  state.onChange = fn;
}

function emit(filePath, kind) {
  console.log(`[watcher] ${kind} ${filePath}`);
  if (state.onChange) {
    try {
      state.onChange({ path: filePath, kind, timestamp: Date.now() });
    } catch { /* noop */ }
  }
}

function watch(folder) {
  unwatch();
  if (!folder || typeof folder !== 'string') return false;
  state.folder = path.normalize(folder);

  if (!fs.existsSync(state.folder)) return false;

  if (chokidar) {
    try {
      console.log(`[watcher] chokidar watching ${state.folder}`);
      // chokidar v4 dropped glob support — we watch the folder directly and
      // filter events to .xml files in the handlers. Using polling because
      // fsevents on macOS misses Resolume's write pattern for some saves.
      const w = chokidar.watch(state.folder, {
        ignoreInitial: true,
        depth: 0, // only direct children of the folder
        usePolling: true,
        interval: 500,
        binaryInterval: 1000,
        awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
      });
      const isXml = (p) => p.toLowerCase().endsWith('.xml');
      w.on('ready', () => console.log('[watcher] ready'));
      w.on('change', (p) => { if (isXml(p)) emit(path.normalize(p), 'change'); });
      w.on('add', (p) => { if (isXml(p)) emit(path.normalize(p), 'add'); });
      w.on('unlink', (p) => { if (isXml(p)) emit(path.normalize(p), 'unlink'); });
      w.on('error', (err) => console.error('[watcher] error', err));
      state.watcher = w;
      return true;
    } catch (err) {
      console.error('[watcher] chokidar setup failed', err);
      // fall through to fs.watch
    }
  }

  // fs.watch fallback. Less reliable on Windows for renames but adequate.
  try {
    let timer = null;
    const fsWatcher = fs.watch(state.folder, (event, filename) => {
      if (!filename || !filename.endsWith('.xml')) return;
      const full = path.normalize(path.join(state.folder, filename));
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => emit(full, event === 'rename' ? 'add' : 'change'), 200);
    });
    state.fallback = { fsWatcher, debounceTimer: timer };
    return true;
  } catch {
    return false;
  }
}

function unwatch() {
  if (state.watcher) {
    try { state.watcher.close(); } catch { /* noop */ }
    state.watcher = null;
  }
  if (state.fallback) {
    try { state.fallback.fsWatcher.close(); } catch { /* noop */ }
    state.fallback = null;
  }
  state.folder = null;
}

function shutdown() {
  unwatch();
  state.onChange = null;
}

module.exports = {
  watch,
  unwatch,
  setChangeListener,
  shutdown,
};
