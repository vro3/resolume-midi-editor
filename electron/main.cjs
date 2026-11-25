// Electron main process for the Preset Editor for Resolume.
// Updated: 2026-06-09 v1.1 (audit) — preset/sidecar writes are now atomic
// (temp file + fsync + rename) so a crash or power loss mid-save can no
// longer leave a truncated preset where Resolume expects a valid one.
const { app, BrowserWindow, Menu, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const fsSync = require('fs');
const os = require('os');
const { pathToFileURL } = require('node:url');
const midiEngine = require('./midi-engine.cjs');
const presetWatcher = require('./preset-watcher.cjs');
const { writeFileAtomic, createPresetSaver } = require('./atomic-file.cjs');
const savePreset = createPresetSaver();

// --- Local error log (append-only, best-effort, never throws) ---

const ERROR_LOG_MAX_BYTES = 1024 * 1024; // 1MB — overwritten with a rotation marker past this size.

function errorLogPath() {
  return path.join(app.getPath('userData'), 'error.log');
}

async function appendErrorLog(line) {
  try {
    const p = errorLogPath();
    await fs.mkdir(path.dirname(p), { recursive: true });
    let shouldRotate = false;
    try {
      const stat = await fs.stat(p);
      if (stat.size > ERROR_LOG_MAX_BYTES) shouldRotate = true;
    } catch {
      // No existing log yet — nothing to rotate.
    }
    if (shouldRotate) {
      await fs.writeFile(p, `[${new Date().toISOString()}] log rotated (exceeded ${ERROR_LOG_MAX_BYTES} bytes)\n`, 'utf8');
    }
    const text = line.endsWith('\n') ? line : `${line}\n`;
    await fs.appendFile(p, text, 'utf8');
  } catch {
    // Best-effort logging only — a failure here must never crash the app
    // or mask the original error.
  }
}

process.on('uncaughtException', (err) => {
  console.error('[main] uncaughtException', err);
  appendErrorLog(`[${new Date().toISOString()}] uncaughtException: ${err && err.stack ? err.stack : String(err)}`);
});
process.on('unhandledRejection', (reason) => {
  console.error('[main] unhandledRejection', reason);
  appendErrorLog(`[${new Date().toISOString()}] unhandledRejection: ${reason instanceof Error ? reason.stack : String(reason)}`);
});

// One-way: renderer reports a caught error/rejection for the local log.
// Validated and truncated here — never trust renderer-supplied strings to
// be a sane size.
ipcMain.on('log:renderer-error', (_e, payload) => {
  if (!payload || typeof payload !== 'object' || typeof payload.message !== 'string') return;
  const message = payload.message.slice(0, 4000);
  const stack = typeof payload.stack === 'string' ? payload.stack.slice(0, 4000) : '';
  const line = `[${new Date().toISOString()}] renderer-error: ${message}${stack ? '\n' + stack : ''}`;
  appendErrorLog(line);
});

const isDev = process.env.NODE_ENV === 'development';
let mainWindow = null;

// Session-only set of directories the renderer is allowed to read/write
// files in. Seeded with the auto-detected Resolume shortcut folder(s) and
// grown with the containing directory of any file the user picks via the
// native (main-side-trusted) open dialog.
const allowedDirs = new Set();

function trustDirectory(dir) {
  allowedDirs.add(fsSync.realpathSync(dir));
}

async function isPathAllowed(targetPath) {
  try {
    const dir = await fs.realpath(path.dirname(targetPath));
    if (!allowedDirs.has(dir)) return false;
    const stat = await fs.lstat(targetPath);
    return stat.isFile();
  } catch (error) {
    return error.code === 'ENOENT' && allowedDirs.has(
      await fs.realpath(path.dirname(targetPath)).catch(() => null)
    );
  }
}

const MAX_FILE_BYTES = 10 * 1024 * 1024;

async function isFileTooLarge(filePath) {
  try {
    const stat = await fs.stat(filePath);
    return stat.size > MAX_FILE_BYTES;
  } catch {
    // Let the subsequent read fail (and be caught) with its own error shape.
    return false;
  }
}

// Mirror of the renderer's unsaved-changes flag. The renderer's own
// `beforeunload` guard covers reload, but app quit (Cmd+Q) and the titlebar
// close button need main-process interception to show a real prompt —
// Electron blocks `beforeunload`-cancelled closes silently, which reads as
// a dead close button.
let rendererDirty = false;
ipcMain.on('app:set-dirty', (_e, dirty) => { rendererDirty = !!dirty; });

function defaultResolumeShortcutsFolder() {
  // ~/Documents/Resolume Arena/Shortcuts/MIDI by default. Cross-platform via
  // os.homedir() — Resolume uses the same path layout on macOS and Windows.
  const candidates = [
    path.join(os.homedir(), 'Documents', 'Resolume Arena', 'Shortcuts', 'MIDI'),
    path.join(os.homedir(), 'Documents', 'Resolume Arena 7', 'Shortcuts', 'MIDI'),
    path.join(os.homedir(), 'Documents', 'Resolume Avenue', 'Shortcuts', 'MIDI'),
  ];
  for (const c of candidates) {
    if (fsSync.existsSync(c)) trustDirectory(c);
  }
  return candidates.find((c) => fsSync.existsSync(c)) ?? candidates[0];
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: 'Preset Editor for Resolume',
    backgroundColor: '#111116',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });
  mainWindow = win;

  // Navigation lockdown: only allow the app's own origin to navigate/open.
  const allowedOrigin = isDev
    ? 'http://localhost:3457'
    : pathToFileURL(path.join(__dirname, '../dist/index.html')).href;
  win.webContents.on('will-navigate', (e, url) => {
    const target = new URL(url);
    target.hash = '';
    if (isDev ? target.origin !== allowedOrigin : target.href !== allowedOrigin) {
      e.preventDefault();
    }
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  // Intercept close (titlebar button, Cmd+W, and each window during Cmd+Q /
  // app quit) when there are unsaved edits. On Discard we destroy() the
  // window, which skips the renderer's beforeunload guard that would
  // otherwise silently re-block the close.
  win.on('close', (e) => {
    if (!rendererDirty) return;
    e.preventDefault();
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Discard Changes', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: 'You have unsaved changes.',
      detail: 'Close without saving them?',
    });
    if (choice === 0) {
      rendererDirty = false;
      win.destroy();
    }
  });
  win.on('closed', () => { rendererDirty = false; });

  midiEngine.setMessageListener((payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('midi:message', payload);
    }
  });

  presetWatcher.setChangeListener((evt) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('watcher:change', evt);
    }
  });

  // Start watching the default Resolume folder right away. The renderer can
  // ask main to switch folders via 'watcher:watch' if the user picks a
  // different one.
  const defaultFolder = defaultResolumeShortcutsFolder();
  presetWatcher.watch(defaultFolder);

  if (isDev) {
    win.loadURL('http://localhost:3457');
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    win.loadFile(path.join(__dirname, '../dist/index.html'));
  }
}

// --- Resolume preset I/O ---

ipcMain.handle('resolume:open-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Open Resolume Preset',
    defaultPath: defaultResolumeShortcutsFolder(),
    properties: ['openFile'],
    filters: [
      { name: 'Resolume MIDI Preset', extensions: ['xml'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const filePath = path.normalize(result.filePaths[0]);
  // The user just picked this file in a native, main-side-trusted dialog —
  // trust its containing directory for future renderer-initiated I/O.
  trustDirectory(path.dirname(filePath));
  if (await isFileTooLarge(filePath)) return null;
  const text = await fs.readFile(filePath, 'utf8');
  return { path: filePath, text };
});

ipcMain.handle('resolume:open-path', async (_e, filePath) => {
  if (!filePath || typeof filePath !== 'string') return null;
  const normalized = path.normalize(filePath);
  if (!normalized.toLowerCase().endsWith('.xml') || !await isPathAllowed(normalized)) return null;
  if (await isFileTooLarge(normalized)) return null;
  try {
    const text = await fs.readFile(normalized, 'utf8');
    return { path: normalized, text };
  } catch {
    return null;
  }
});

ipcMain.handle('resolume:save-file', async (_e, targetPath, text) => {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_FILE_BYTES) {
    throw new Error('Preset must be text no larger than 10 MB.');
  }
  let outPath = targetPath ? path.normalize(targetPath) : null;
  if (!outPath) {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Save Resolume Preset',
      defaultPath: path.join(defaultResolumeShortcutsFolder(), 'preset.xml'),
      filters: [{ name: 'Resolume MIDI Preset', extensions: ['xml'] }],
    });
    if (result.canceled || !result.filePath) return null;
    outPath = path.normalize(result.filePath);
    trustDirectory(path.dirname(outPath));
  }
  if (!outPath.toLowerCase().endsWith('.xml')) throw new Error('Choose an XML filename.');
  if (!await isPathAllowed(outPath)) throw new Error('Choose an authorized preset location using Save As.');
  if (!await isPathAllowed(outPath + '.bak')) throw new Error('Unsafe backup destination.');
  const canonicalDir = await fs.realpath(path.dirname(outPath));
  await savePreset(path.join(canonicalDir, path.basename(outPath)), text);
  return { path: outPath };
});

ipcMain.handle('resolume:list-presets', async () => {
  const folder = defaultResolumeShortcutsFolder();
  try {
    const entries = await fs.readdir(folder);
    const xmls = entries.filter((e) => e.toLowerCase().endsWith('.xml'));
    const withMtime = await Promise.all(
      xmls.map(async (name) => {
        const full = path.normalize(path.join(folder, name));
        const stat = await fs.stat(full).catch(() => null);
        return { name, path: full, mtime: stat?.mtimeMs ?? 0 };
      })
    );
    withMtime.sort((a, b) => b.mtime - a.mtime);
    return { folder, presets: withMtime.map(({ name, path: p }) => ({ name, path: p })) };
  } catch {
    return { folder, presets: [] };
  }
});

// --- Sidecar JSON for clerical Labels ---

function sidecarPathFor(presetPath) {
  // Foo.xml -> Foo.midibrain.json (alongside the preset)
  const dir = path.dirname(presetPath);
  const base = path.basename(presetPath, path.extname(presetPath));
  return path.join(dir, `${base}.midibrain.json`);
}

ipcMain.handle('sidecar:read', async (_e, presetPath) => {
  if (typeof presetPath !== 'string' || !presetPath.toLowerCase().endsWith('.xml')) return null;
  const p = sidecarPathFor(path.normalize(presetPath));
  if (!await isPathAllowed(p)) return null;
  if (await isFileTooLarge(p)) return null;
  try {
    const text = await fs.readFile(p, 'utf8');
    return JSON.parse(text);
  } catch {
    return null;
  }
});

ipcMain.handle('sidecar:write', async (_e, presetPath, data) => {
  if (typeof presetPath !== 'string' || !presetPath.toLowerCase().endsWith('.xml')) return false;
  const p = sidecarPathFor(path.normalize(presetPath));
  if (!await isPathAllowed(p)) return false;
  try {
    const text = JSON.stringify(data, null, 2);
    if (Buffer.byteLength(text, 'utf8') > MAX_FILE_BYTES) return false;
    await writeFileAtomic(p, text);
    return true;
  } catch {
    return false;
  }
});

// --- Folder watcher ---

ipcMain.handle('watcher:watch', async (_e, folder) => {
  if (!folder || typeof folder !== 'string') return false;
  const resolved = path.resolve(path.normalize(folder));
  // No renderer call site sends an arbitrary folder here today (confirmed by
  // grep), so this stays confined to already-trusted directories rather than
  // trusting whatever the renderer sends.
  if (!allowedDirs.has(await fs.realpath(resolved).catch(() => null))) return false;
  return presetWatcher.watch(folder);
});
ipcMain.handle('watcher:unwatch', () => { presetWatcher.unwatch(); return true; });
ipcMain.handle('watcher:default-folder', () => defaultResolumeShortcutsFolder());

// --- MIDI input subscription ---

ipcMain.handle('midi:list-inputs', () => midiEngine.listInputs());
ipcMain.handle('midi:open-input', (_e, name) => midiEngine.openInput(name));
ipcMain.handle('midi:close-input', (_e, name) => midiEngine.closeInput(name));

// --- Application menu ---

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const sendToFocused = (channel) => {
    const win = BrowserWindow.getFocusedWindow() ?? mainWindow;
    if (win && !win.isDestroyed()) win.webContents.send(channel);
  };

  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'Open Preset…',
          accelerator: 'CmdOrCtrl+O',
          click: () => sendToFocused('menu:open'),
        },
        {
          label: 'Save',
          accelerator: 'CmdOrCtrl+S',
          click: () => sendToFocused('menu:save'),
        },
        {
          label: 'Save As…',
          accelerator: 'CmdOrCtrl+Shift+S',
          click: () => sendToFocused('menu:save-as'),
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: () => sendToFocused('menu:undo') },
        { label: 'Redo', accelerator: 'CmdOrCtrl+Shift+Z', click: () => sendToFocused('menu:redo') },
        { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ],
    },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  buildMenu();
  createWindow();
});

app.on('window-all-closed', () => {
  midiEngine.shutdown();
  presetWatcher.shutdown();
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
