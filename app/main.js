// ExamAutoAnswer — Electron shell around the exam-auto-answer scripts.
// The scripts stay the source of truth: this app only spawns them and streams their output.
const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const WORK_DIR = path.join(app.getPath('userData'), 'work');
const SCRIPTS = app.isPackaged
  ? path.join(process.resourcesPath, 'scripts')
  : path.join(__dirname, '..', 'scripts');

let win = null;

function ensureWorkDir() {
  fs.mkdirSync(WORK_DIR, { recursive: true });
  return WORK_DIR;
}

function log(chunk) {
  if (win && !win.isDestroyed()) win.webContents.send('log', String(chunk));
}

function child(proc, label) {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => { const s = d.toString(); out += s; log(s); });
    proc.stderr.on('data', (d) => { const s = d.toString(); err += s; log(s); });
    proc.on('error', (e) => resolve({ ok: false, code: -1, out, err: err + '\n' + e.message, label }));
    proc.on('close', (code) => resolve({ ok: code === 0, code, out, err, label }));
  });
}

function runNode(script, args) {
  ensureWorkDir();
  const file = path.join(SCRIPTS, script);
  if (!fs.existsSync(file)) return Promise.resolve({ ok: false, code: -1, out: '', err: `missing ${file}`, label: script });
  log(`\n$ node ${script} ${args.join(' ')}\n`);
  return child(spawn(process.execPath, [file, ...args], {
    cwd: WORK_DIR,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  }), script);
}

function runBrowser(action, extra) {
  ensureWorkDir();
  const file = path.join(SCRIPTS, 'browser.ps1');
  if (!fs.existsSync(file)) return Promise.resolve({ ok: false, code: -1, out: '', err: `missing ${file}`, label: 'browser.ps1' });
  log(`\n$ browser.ps1 ${action} ${extra.join(' ')}\n`);
  return child(spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file, '-Action', action, ...extra], {
    cwd: WORK_DIR,
  }), `browser.ps1 ${action}`);
}

// --- individual steps -------------------------------------------------------
const STEPS = {
  async launch(o) {
    const args = ['-Port', String(o.port || 9223)];
    if (o.url) args.push('-Url', o.url);
    return runBrowser('launch', args);
  },
  status: (o) => runNode('exam.mjs', ['status', '--port', String(o.port || 9223)]),
  probe: (o) => runNode('exam.mjs', ['probe', '--port', String(o.port || 9223)]),
  harvest: (o) => runNode('exam.mjs', ['harvest', '--port', String(o.port || 9223), '--out', 'questions.json']),
  answer: (o) => runNode('answer.mjs', ['--questions', 'questions.json', '--out', 'answers.json']),
  apply: (o) => runNode('exam.mjs', ['apply', '--port', String(o.port || 9223), '--map', 'answers.json']),
  verify: (o) => runNode('exam.mjs', ['verify', '--port', String(o.port || 9223), '--map', 'answers.json']),
  submit: (o) => runNode('exam.mjs', ['submit', '--port', String(o.port || 9223)]),
  saveKey: (o) => {
    const args = ['--set-key', String(o.key || '').trim()];
    if (o.baseUrl) args.push('--base-url', o.baseUrl);
    if (o.model) args.push('--model', o.model);
    return runNode('answer.mjs', args);
  },
  checkKey: () => runNode('answer.mjs', ['--check']),
  async browse() {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
    return { ok: !r.canceled, code: r.canceled ? 1 : 0, out: r.canceled ? '' : r.filePaths[0], err: '', label: 'browse' };
  },
};

ipcMain.handle('run', async (_e, { step, opts }) => {
  const fn = STEPS[step];
  if (!fn) return { ok: false, code: 2, out: '', err: `unknown step ${step}`, label: step };
  try {
    return await fn(opts || {});
  } catch (e) {
    log(`\n[error] ${e.message}\n`);
    return { ok: false, code: -1, out: '', err: e.message, label: step };
  }
});

ipcMain.handle('openWorkDir', async () => {
  ensureWorkDir();
  await shell.openPath(WORK_DIR);
  return true;
});

ipcMain.handle('readFile', async (_e, name) => {
  try {
    return fs.readFileSync(path.join(WORK_DIR, name), 'utf8');
  } catch {
    return null;
  }
});

function createWindow() {
  win = new BrowserWindow({
    width: 1060,
    height: 760,
    minWidth: 820,
    minHeight: 560,
    backgroundColor: '#0f1115',
    title: 'ExamAutoAnswer',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(() => {
  ensureWorkDir();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
