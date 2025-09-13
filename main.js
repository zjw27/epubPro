// main.js
const { app, BrowserWindow, dialog, Menu, ipcMain, nativeTheme } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const pipelineVersion = 'aot-v1';


ipcMain.handle('sig:from-path', async (_evt, filePath) => {
  if (!filePath || !fs.existsSync(filePath)) throw new Error('Invalid path');
  const res = await computeSigAndCheck(filePath);
  console.log('[ipc] sig:from-path =>', res);
  return res;
});

// 动态引入 mjs
async function computeSigAndCheck(filePath) {
  const { fileHash } = await import('./parse_epub_step5.mjs');
  const hash = await fileHash(filePath);       // ← 用流式哈希替换原 sha256File
  const sig = `${hash}.aot-v1`;                // 保持你原来的 pipelineVersion
  return { hash, sig, matched: false };        // 示例：保持返回对象结构
}


// 开发期兜底：关沙箱（放最前面更稳）
app.commandLine.appendSwitch('no-sandbox');

const isMac = process.platform === 'darwin';

let win;

function overlayColors() {
  const dark = nativeTheme.shouldUseDarkColors;
  return {
    color: dark ? '#202020CC' : '#F3F3F3CC', // 半透明更容易看出效果
    symbolColor: dark ? '#FFFFFF' : '#000000',
    height: 24,
  };
}

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 760,
    show: false,
    useContentSize: true,
    autoHideMenuBar: true,

    show: false,                 // 先不显示，避免启动阶段露出系统材质
    frame: true,                 // 保留系统按钮
    // titleBarStyle: 'hidden',     
    // titleBarOverlay: false,
    transparent: false,
    backgroundColor: '#FAFAFB',  // 启动背景：你自己的纯色（可换）
    icon: path.join(__dirname, 'app.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      enableRemoteModule: false,
      sandbox: false,
    },
  });
  buildMenu(win);
  // 只保留一种加载方式（本地 index.html）
  win.loadFile(path.join(__dirname, 'index.html'));

  win.on('page-title-updated', (e) => {
    e.preventDefault();
    win.setTitle('EPUB for Javen');  // 可省略，已在构造器里设过
  });

  // 首帧就绪后再显示 —— 不会出现“只有外框”的情况
  win.once('ready-to-show', () => {
    win.show();
  });

  // --- [main] menu: “打开 EPUB…” ---
  function buildMenu(win) {
    const template = [
      {
        label: '文件',
        submenu: [
          {
            label: '打开 EPUB…',
            accelerator: 'CommandOrControl+O',
            click: () => {
              if (win && !win.isDestroyed()) {
                win.webContents.send('open-epub');
              }
            }
          },
          { type: 'separator' },
          process.platform === 'darwin' ? { role: 'close' } : { role: 'quit' }
        ]
      },
      ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : [])
    ];

    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  }


  // 菜单（Ctrl/⌘ + O）
  // const menu = Menu.buildFromTemplate([
  //   {
  //     label: 'File',
  //     submenu: [
  //       {
  //         label: '打开 EPUB',
  //         accelerator: 'CommandOrControl+O',
  //         click: () => win.webContents.send('open-epub'),
  //       },
  //       { type: 'separator' },
  //       isMac ? { role: 'close' } : { role: 'quit' },
  //     ],
  //   },
  //   ...(isMac ? [{ role: 'appMenu' }] : []),
  // ]);
  // Menu.setApplicationMenu(menu);

  // DevTools 字体注入（只在打开时注入一次）
  const injectDevtoolsCSS = () => {
    const devtools =
      (win.webContents.getDevToolsWebContents &&
        win.webContents.getDevToolsWebContents()) ||
      win.webContents.devToolsWebContents;
    if (!devtools) return;

    const inject = () => {
      devtools
        .executeJavaScript(`
          (function () {
            if (document.getElementById('__custom-devtools-font')) return;
            const style = document.createElement('style');
            style.id = '__custom-devtools-font';
            style.textContent = \`
              :root {
                --monospace-font-family:
                  "JetBrainsMono Nerd Font Mono",
                  "JetBrainsMono NF",
                  "JetBrains Mono",
                  Consolas,
                  monospace !important;
                --source-code-font-family: var(--monospace-font-family) !important;
              }
              .source-code, .CodeMirror, .cm-editor, .monaco-editor, .monospace {
                font-family: var(--monospace-font-family) !important;
                font-size: 15px !important;
                font-weight: 400 !important;
              }
            \`;
            document.documentElement.appendChild(style);
          })();
        `)
        .catch(() => { });
    };

    devtools.once?.('dom-ready', inject);
    try { inject(); } catch { }
  };

  win.webContents.on('devtools-opened', injectDevtoolsCSS);
  win.webContents.on('did-open-devtools', injectDevtoolsCSS);

  // 常用快捷键（开发期）
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;

    // F12 → DevTools
    if (input.key === 'F12' && !input.alt && !input.control && !input.meta && !input.shift) {
      win.webContents.toggleDevTools();
      event.preventDefault();
      return;
    }
    // Ctrl+Shift+R → 强刷（忽略缓存）
    if (input.key?.toLowerCase() === 'r' && input.control && input.shift && !input.alt && !input.meta) {
      win.webContents.reloadIgnoringCache();
      event.preventDefault();
      return;
    }
    // Ctrl+R / F5 → 普通刷新
    if ((input.key?.toLowerCase() === 'r' && input.control) || input.key === 'F5') {
      win.webContents.reload();
      event.preventDefault();
      return;
    }
  });
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (!isMac) app.quit();
});

// 监听渲染进程事件并触发相关操作
ipcMain.on('open-epub', async (evt) => {
  const win = BrowserWindow.fromWebContents(evt.sender);
  // …对话框/解析…
  const payload = await parseEpub(file);   // <- 你真实的解析
  win.webContents.send('book:loaded', payload);  // <- 补这一行
});

ipcMain.handle('pick-epub', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: '选择 EPUB 文件',
    filters: [{ name: 'EPUB', extensions: ['epub'] }],
    properties: ['openFile']
  });
  console.log('[MAIN] pick-epub ->', { canceled, path: filePaths?.[0] });
  if (canceled || !filePaths?.[0]) return null;
  return filePaths[0];
});

ipcMain.on('app:set-title', (evt, t) => {
  const bw = BrowserWindow.fromWebContents(evt.sender);
  if (!bw || bw.isDestroyed()) return;
  const title = (t ?? '').toString().trim();
  bw.setTitle(title || 'EPUB Reader');
});

ipcMain.handle('pick-manifest', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: '选择 manifest.json',
    properties: ['openFile'],               // ← 只允许选文件
    filters: [{ name: 'Manifest', extensions: ['json'] }]
  });
  if (canceled || !filePaths?.[0]) return null;
  const p = filePaths[0];
  return p.toLowerCase().endsWith('manifest.json') ? p : null;
});

// ① 新增：通用选择器（允许 .epub 和 .json）
ipcMain.handle('pick:book-or-manifest', async (evt) => {
  const win = BrowserWindow.fromWebContents(evt.sender);
  const r = await dialog.showOpenDialog(win, {
    title: '选择 EPUB 或 manifest.json',
    filters: [
      { name: 'EPUB 或 Manifest', extensions: ['epub', 'json'] },
      { name: 'EPUB 电子书', extensions: ['epub'] },
      { name: '解析清单 (manifest.json)', extensions: ['json'] },
    ],
    properties: ['openFile']
  });
  if (r.canceled || !r.filePaths?.[0]) return null;
  return r.filePaths[0];
});

const _activeHashers = new Map(); // id -> { h, pv, wc }

ipcMain.on('sig:hash-begin', (evt, { id, pipelineVersion }) => {
  if (!id) return;
  _activeHashers.set(id, { h: crypto.createHash('sha256'), pv: pipelineVersion || 'aot-v1', wc: evt.sender });
});

ipcMain.on('sig:hash-chunk', (_evt, { id, chunk }) => {
  const hs = _activeHashers.get(id);
  if (!hs || !chunk) return;
  // 既兼容 Buffer，也兼容 ArrayBuffer
  hs.h.update(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
});

ipcMain.on('sig:hash-end', (_evt, { id }) => {
  const hs = _activeHashers.get(id);
  if (!hs) return;
  try {
    const hex = hs.h.digest('hex');
    hs.wc.send('sig:hash-done', { id, sig: `${hex}.${hs.pv}` });
  } catch (e) {
    hs.wc.send('sig:hash-error', { id, error: String(e && e.message || e) });
  } finally {
    _activeHashers.delete(id);
  }
});
