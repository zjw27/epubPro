// preload.js — minimal bridge
// CommonJS 以兼容大部分 Electron 预设
const { contextBridge, ipcRenderer } = require('electron');
const { pathToFileURL } = require('url');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

async function exists(p) {
  try { await fsp.access(p, fs.constants.F_OK); return true; } catch { return false; }
}

contextBridge.exposeInMainWorld('eapi', {
  // 基础 fs
  exists,
  readText: async (absPath) => await fsp.readFile(absPath, 'utf8'),
  readJSON: async (absPath) => JSON.parse(await fsp.readFile(absPath, 'utf8')),
  dirname: (p) => path.dirname(p),
  join: (...a) => path.join(...a),
  setTitle: (t) => ipcRenderer.send('app:set-title', t),

  // 便捷：从 manifest 路径读取 json
  openManifestByPath: async (manifestPath) => {
    if (!(await exists(manifestPath))) {
      throw new Error('manifest 不存在: ' + manifestPath);
    }
    const raw = await fsp.readFile(manifestPath, 'utf8');
    return JSON.parse(raw);
  },

  // 读取章节（基于书目录 + 章节相对路径）
  readChapter: async (bookDirAbs, chapterRel) => {
    const abs = path.join(bookDirAbs, chapterRel);
    return await fsp.readFile(abs, 'utf8');
  },

  // 新通用选择器
  pickBookOrManifest: () => ipcRenderer.invoke('pick:book-or-manifest'),

  pickManifestViaDialog: () => ipcRenderer.invoke('pick-manifest'),
  toFileUrl: (absPath) => pathToFileURL(absPath).href,

  // 从 path list 中挑选 manifest（DnD 用）
  pickManifestPath: async (paths) => {
    if (!Array.isArray(paths)) return null;
    for (const p of paths) {
      if (typeof p === 'string' && p.toLowerCase().endsWith('manifest.json')) return p;
      // 如果拖拽的是书目录
      const mp = path.join(p, 'manifest.json');
      if (await exists(mp)) return mp;
    }
    return null;
  }
})

contextBridge.exposeInMainWorld('epubSig', {
  // 拖拽/自定义入口：传入文件路径，返回 { hash, sig, matched, ... }
  computeFromPath(filePath) {
    return ipcRenderer.invoke('sig:from-path', filePath);
  },
  // 订阅主进程“打开 EPUB…”/macOS open-file 的异步结果
  onReport(cb) {
    const listener = (_e, info) => cb?.(info);
    ipcRenderer.on('sig:report', listener);
    ipcRenderer.on('open-epub', async () => {
      if (window.openViaDialog) window.openViaDialog();
    });
    return () => ipcRenderer.removeListener('sig:report', listener);
  }
});

