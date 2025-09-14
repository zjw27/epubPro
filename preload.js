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
  },
  readFileAsBytes: async (absPath) => {
    // 返回 Uint8Array，用于传递给 worker
    return new Uint8Array(await fsp.readFile(absPath));
  },

})

contextBridge.exposeInMainWorld('epubSig', {
  // drop 禁用
  // computeFromPath(filePath) {
  //   return ipcRenderer.invoke('sig:from-path', filePath);
  // },
  // 从 File/Blob 计算 sig，并返回匹配结果（不经由路径）
  async computeFromFile(fileOrBlob) {
    const u8 = new Uint8Array(await fileOrBlob.arrayBuffer());
    return ipcRenderer.invoke('sig:from-bytes-check', u8);
  },
});

contextBridge.exposeInMainWorld('sigAPI', {
  fromBlob: async (blob, { pipelineVersion = 'aot-v1', chunkSize = 2 * 1024 * 1024 } = {}) => {
    const id = `h_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const done = new Promise((resolve, reject) => {
      const onDone = (_e, data) => { if (data?.id !== id) return; cleanup(); resolve(data.sig); };
      const onErr = (_e, data) => { if (data?.id !== id) return; cleanup(); reject(new Error(data?.error || 'hash failed')); };
      const cleanup = () => {
        ipcRenderer.removeListener('sig:hash-done', onDone);
        ipcRenderer.removeListener('sig:hash-error', onErr);
      };
      ipcRenderer.on('sig:hash-done', onDone);
      ipcRenderer.on('sig:hash-error', onErr);
    });

    // 开始 + 分块  
    ipcRenderer.send('sig:hash-begin', { id, pipelineVersion });

    let off = 0;
    while (off < blob.size) {
      const end = Math.min(off + chunkSize, blob.size);
      const ab = await blob.slice(off, end).arrayBuffer();
      const buf = Buffer.from(ab);
      ipcRenderer.send('sig:hash-chunk', { id, chunk: buf });
      off = end;
    }
    ipcRenderer.send('sig:hash-end', { id });

    return await done;
  },
});

contextBridge.exposeInMainWorld('parser', {
  /** 把 File/Blob 发给 main → worker 执行重活，返回 {hash, …} */
  async parseFile(fileOrBlob, opts = {}) {
    const u8 = new Uint8Array(await fileOrBlob.arrayBuffer());
    const { ok, result, error } = await ipcRenderer.invoke('worker:parse', u8, opts);
    if (!ok) throw new Error(error || 'parse failed');
    return result; // {hash, …}
  },
});

contextBridge.exposeInMainWorld('sig', {
  /** 只做索引匹配 */
  check: (sig) => ipcRenderer.invoke('sig:check', sig),
});

