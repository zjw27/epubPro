// v-0914-10
const { app, BrowserWindow, dialog, Menu, ipcMain, nativeTheme } = require('electron');
const path = require('path');
const crypto = require('crypto');
const pipelineVersion = 'aot-v1';
const fsp = require('fs/promises');
const { Worker } = require('node:worker_threads');
const fs = require('node:fs');
const { log } = require('node:console');
const { spawn } = require('child_process');
const os = require('os');


// 开发期兜底：关沙箱（放最前面更稳）
app.commandLine.appendSwitch('no-sandbox');

// 通过文件路径计算 sig，并匹配索引
// ipcMain.handle('sig:from-path', async (_evt, filePath) => {
//   if (!filePath || !fs.existsSync(filePath)) throw new Error('Invalid path');

//   // 1) 读取文件内容并计算 SHA‑256 哈希
//   const buf = await fsp.readFile(filePath);
//   const hash = crypto.createHash('sha256').update(buf).digest('hex');
//   const sig = `${hash}.aot-v1`;

//   // 2) 在用户数据目录的 .epub-index/library-index.json 中查找该 sig
//   const indexPath = path.join(app.getPath('userData'), '.epub-index', 'library-index.json');
//   let matched = false;
//   let entry = null;
//   try {
//     const arr = JSON.parse(await fsp.readFile(indexPath, 'utf8'));
//     if (Array.isArray(arr)) {
//       entry = arr.find(x => x && x.sig === sig) || null;
//       matched = !!entry;
//     }
//   } catch {
//     // 缺少索引文件或解析失败时认为未命中
//   }

//   return { sig, matched, entry };
// });

// 动态引入 mjs
async function computeSigAndCheck(filePath) {
  const { fileHash } = await import('./parser before.cjs');
  const hash = await fileHash(filePath);       // ← 用流式哈希替换原 sha256File
  const sig = `${hash}.aot-v1`;                // 保持你原来的 pipelineVersion

  // 读取用户数据目录下的 .epub-index\library-index.json
  const indexPath = path.join(app.getPath('userData'), '.epub-index', 'library-index.json');
  let matched = false, entry = null;
  try {
    const txt = await fsp.readFile(indexPath, 'utf8');
    const arr = JSON.parse(txt);
    console.log(txt);

    entry = Array.isArray(arr) ? arr.find(x => x && x.sig === sig) : null;
    matched = !!entry;
  } catch (_) {
    // 没有索引文件或解析失败就当没命中
  }
  return { hash, sig, matched, entry }
}

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
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
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

  return win;
}

/** 跑一次 worker 任务（每次启动一个，简单稳妥；后续可做池化） */
function runParseInWorker(bufferLike, task = 'parse', opts = {}) {
  return new Promise((resolve, reject) => {
    const workerPath = path.join(__dirname, 'parser.worker.cjs');
    console.log('[worker path]', workerPath, fs.existsSync(workerPath));
    if (!fs.existsSync(workerPath)) {
      return reject(new Error('worker file not found: ' + workerPath));
    }
    const worker = new Worker(workerPath, { workerData: {} });

    let settled = false;
    const cleanup = () => worker.terminate().catch(() => { });
    const settle = (fn, val) => { if (settled) return; settled = true; clearTimeout(timer); cleanup(); fn(val); };
    const timer = setTimeout(() => settle(reject, new Error('worker timeout')), 60000);

    worker.once('error', (err) => settle(reject, err));
    worker.once('exit', (code) => {
      if (!settled && code !== 0) {
        console.error('[worker] exit with code', code);
        settle(reject, new Error('worker exited:' + code));
      }
    });

    worker.on('message', (msg) => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'boot') {
        console.log('[worker boot]', msg.dir, msg.files);
      } else if (msg.type === 'progress') {
        console.log('[worker progress]', msg.phase, msg.pct, msg.byteLength ?? '');
      } else if (msg.type === 'done') {
        settle(resolve, msg.result);
      } else if (msg.type === 'error') {
        console.error('[worker error]', msg.message);
        settle(reject, new Error(msg.message || 'worker error'));
      }
    });

    // 规范化为 ArrayBuffer（transferable），避免把 Node Buffer 直接塞进 transferList
    let u8;
    if (Buffer.isBuffer(bufferLike)) {
      u8 = new Uint8Array(bufferLike.buffer, bufferLike.byteOffset, bufferLike.byteLength);
    } else if (bufferLike?.buffer instanceof ArrayBuffer) {
      u8 = new Uint8Array(bufferLike.buffer, bufferLike.byteOffset || 0, bufferLike.byteLength ?? bufferLike.length ?? 0);
      if (u8.byteLength === 0) u8 = new Uint8Array(bufferLike); // 兜底
    } else {
      u8 = new Uint8Array(bufferLike || []);
    }
    const ab = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength); // 独立的 ArrayBuffer
    try { worker.postMessage({ task, buffer: ab, opts }, [ab]); }
    catch { worker.postMessage({ task, buffer: ab, opts }); }
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

// 新：从字节数组计算 sig 并做索引匹配（drop 正解桥）
// ipcMain.handle('sig:from-bytes-check', async (_evt, u8arr) => {
//   try {
//     // 1) 规范化 Buffer（避免结构化克隆后的类型差异）
//     const buf = Buffer.isBuffer(u8arr)
//       ? u8arr
//       : (u8arr?.buffer instanceof ArrayBuffer)
//         ? Buffer.from(u8arr.buffer)
//         : Buffer.from(u8arr || []);

//     // 2) 直接用 node:crypto 算 SHA-256，避免 mjs 动态 import 带来的不确定性
//     const hash = require('crypto').createHash('sha256').update(buf).digest('hex');
//     const sig = `${hash}.aot-v1`;

//     // 3) 匹配索引（任何异常都吞掉，仅当未命中处理）
//     const indexPath = path.join(app.getPath('userData'), '.epub-index', 'library-index.json');
//     let matched = false, entry = null;
//     try {
//       const txt = await fsp.readFile(indexPath, 'utf8');
//       const arr = JSON.parse(txt);
//       if (Array.isArray(arr)) {
//         entry = arr.find(x => x && x.sig === sig) || null;
//         matched = !!entry;
//       }
//     } catch { }

//     return { sig, matched, entry };
//   } catch (err) {
//     console.error('[sig:from-bytes-check] failed:', err);
//     return { sig: null, matched: false, entry: null, error: String(err?.message || err) };
//   }
// });

// —— IPC：renderer 调用，让 worker 干重活（hash/parse）——
ipcMain.handle('worker:parse', async (_evt, u8arr, opts = {}) => {
  try {
    const result = await runParseInWorker(u8arr, 'parse', opts);
    return { ok: true, result };
  } catch (err) {
    console.error('[worker:parse] failed:', err);
    return { ok: false, error: String(err?.message || err) };
  }
});

// —— IPC：只做 sig 匹配（读 userData/.epub-index/library-index.json）——
ipcMain.handle('sig:check', async (_evt, sig) => {
  const searchDirs = [
    app.getPath('userData'),              // 旧目录
    app.getAppPath(),                     // 应用目录（AOT 索引通常写在这里）
  ];
  let matched = false, entry = null;
  for (const root of searchDirs) {
    const indexPath = path.join(root, '.epub-index', 'library-index.json');
    try {
      const txt = await fsp.readFile(indexPath, 'utf8');
      const data = JSON.parse(txt);
      entry = Array.isArray(data)
        ? data.find(x => x && x.sig === sig)
        : (data?.items?.[sig] || null);
      if (entry) { matched = true; break; }
    } catch { /* 忽略错误，继续下一个目录 */ }
  }
  return { matched, entry };
});

ipcMain.handle('aot:parse-epub', async (_evt, u8arr) => {
  try {
    const buf = Buffer.from(u8arr);
    const tmpPath = path.join(os.tmpdir(), `aot_${Date.now()}.epub`);
    await fsp.writeFile(tmpPath, buf);

    const outRoot = app.getPath('userData'); // 与 sig:check 读取位置保持一致
    await new Promise((resolve, reject) => {
      const proc = spawn(process.execPath,
        [path.join(__dirname, 'parser.cjs'), tmpPath, outRoot],
        { stdio: ['ignore', 'inherit', 'inherit'] });
      proc.on('error', reject);
      proc.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`parser exit ${code}`))));
    });

    return { ok: true };
  } catch (err) {
    console.error('[aot:parse-epub] failed:', err);
    return { ok: false, error: String(err?.message || err) };
  }
});





