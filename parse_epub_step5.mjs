import fs from 'fs';
import os from 'os';
import fsp from 'fs/promises';
import path from 'path';
import { createHash } from 'crypto';
import unzipper from 'unzipper';
import { XMLParser } from 'fast-xml-parser';
import mime from 'mime-types';
// import crypto from 'crypto';
import crypto from 'node:crypto';

const PIPELINE_VERSION = 'aot-v1';
// const STEP_BUILD = 'step4-idempotent-1.0';
const STEP_BUILD = 'step4-idempotent-1.1-css-hoist';

// ---------- 工具 ----------
const posix = path.posix; // 统一使用 posix 路径（EPUB 内部规范更贴近 posix）

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

// 只做保留，不参与drop计算
export async function computeSigFromPath(filePath, pipelineVersion = 'aot-v1') {
  return await new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(filePath);
    s.on('error', reject);
    s.on('data', (chunk) => h.update(chunk));
    s.on('end', () => {
      const hex = h.digest('hex');
      resolve(`${hex}.${pipelineVersion}`);
    });
  });
}


export async function fileHashFromBytes(bytes) {
  // bytes: Buffer | Uint8Array | ArrayBuffer
  const buf = Buffer.isBuffer(bytes)
    ? bytes
    : Buffer.from(bytes.buffer ? bytes.buffer : bytes);
  const hash = crypto.createHash('sha256').update(buf).digest('hex');
  return hash;
}

// ---------- 索引(JSON)：路径 & 读写 ----------
const INDEX_SCHEMA_VERSION = 1;
const APP_ID = 'epub-local-reader';
function getIndexDir() {
  if (process.platform === 'win32') {
    const base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(base, APP_ID);
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', APP_ID);
  }
  // linux / others
  return path.join(os.homedir(), '.config', APP_ID);
}
// 优先用“书库根目录(outRoot)”本地索引；缺省再退回 APPDATA
function getIndexPaths(preferredRootDir) {
  let dir;
  if (preferredRootDir) {
    // 放在 <outRoot>/.epub-index/library-index.json
    dir = path.join(path.resolve(preferredRootDir), '.epub-index');
  } else {
    dir = getIndexDir();
  }
  const file = path.join(dir, 'library-index.json');
  return { dir, file, tmp: file + '.tmp', bak: file + '.bak' };
}

async function readJsonSafe(p) {
  try { return JSON.parse(await fsp.readFile(p, 'utf8')); } catch { return null; }
}
async function loadLibraryIndex(preferredRootDir) {
  const { dir, file, bak } = getIndexPaths(preferredRootDir);
  await fsp.mkdir(dir, { recursive: true });
  const cur = await readJsonSafe(file);
  if (cur && cur.items && typeof cur.items === 'object') return cur;
  const backup = await readJsonSafe(bak);
  if (backup && backup.items && typeof backup.items === 'object') return backup;
  return { schemaVersion: INDEX_SCHEMA_VERSION, updatedAt: new Date().toISOString(), items: {} };
}
async function saveLibraryIndex(idx, preferredRootDir) {
  const { file, tmp, bak } = getIndexPaths(preferredRootDir);
  const data = JSON.stringify({ ...idx, schemaVersion: INDEX_SCHEMA_VERSION, updatedAt: new Date().toISOString() }, null, 2);
  // 原子写：tmp → 备份旧 → 覆盖正本
  await fsp.writeFile(tmp, data, 'utf8');
  try { await fsp.copyFile(file, bak); } catch { }
  await fsp.rename(tmp, file);
}
// 规范化作者为字符串
function normalizeAuthor(meta) {
  const v = meta?.creator ?? meta?.author ?? '';
  if (Array.isArray(v)) {
    return v.map(x => (typeof x === 'string' ? x : (x?.['#text'] || x?.name || ''))).filter(Boolean).join('; ');
  }
  if (v && typeof v === 'object') return v['#text'] || v.name || '';
  return String(v || '');
}
async function upsertLibraryIndex(entry, preferredRootDir) {
  // entry: { sig, pipelineVersion, manifestPath, title, author, spineCount, status }
  if (!entry || !entry.sig) return;
  const idx = await loadLibraryIndex(preferredRootDir);
  const prev = idx.items[entry.sig] || {};
  idx.items[entry.sig] = {
    sig: entry.sig,
    pipelineVersion: entry.pipelineVersion,
    manifestPath: entry.manifestPath,
    title: entry.title || prev.title || '',
    author: normalizeAuthor({ creator: entry.author }) || prev.author || '',
    spineCount: Number.isFinite(entry.spineCount) ? entry.spineCount : (prev.spineCount || 0),
    status: entry.status || prev.status || 'ready',
    openCount: prev.openCount || 0,
    lastOpenedAt: prev.lastOpenedAt || null
  };
  await saveLibraryIndex(idx, preferredRootDir);
  return idx;
}


// 入口：返回 { width, height, type, orientationSwapped }
export function getImageSize(buf, mime = '', path = '') {
  const mt = (mime || guessMimeFromPath(path)).toLowerCase();
  try {
    if (mt.includes('jpeg') || /\.jpe?g$/i.test(path)) return parseJPEG(buf);
    if (mt.includes('png') || /\.png$/i.test(path)) return parsePNG(buf);
    if (mt.includes('gif') || /\.gif$/i.test(path)) return parseGIF(buf);
    if (mt.includes('webp') || /\.webp$/i.test(path)) return parseWEBP(buf);
    if (mt.includes('svg') || /\.svg$/i.test(path)) return parseSVG(buf);
  } catch (_) { }
  return null;
}

function guessMimeFromPath(p = '') {
  const ext = (p.split('.').pop() || '').toLowerCase();
  return ({
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
    gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml'
  })[ext] || '';
}

function parseJPEG(buf) {
  if (buf[0] !== 0xFF || buf[1] !== 0xD8) throw new Error('not JPEG');
  let w = 0, h = 0, orient = 1;
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xFF) { i++; continue; }
    const marker = buf[i + 1];
    const len = (buf[i + 2] << 8) + buf[i + 3];
    if (marker === 0xE1 && buf.slice(i + 4, i + 10).toString() === 'Exif\0\0') {
      // EXIF → 解析 Orientation
      try {
        const view = buf.slice(i + 10, i + 2 + len);
        const bo = view.slice(0, 2).toString(); // 'II' or 'MM'
        const le = (bo === 'II');
        const rd16 = (o) => le ? view.readUInt16LE(o) : view.readUInt16BE(o);
        const rd32 = (o) => le ? view.readUInt32LE(o) : view.readUInt32BE(o);
        const ifd0 = rd32(4);
        const cnt = rd16(ifd0);
        for (let k = 0; k < cnt; k++) {
          const off = ifd0 + 2 + k * 12;
          const tag = rd16(off);
          if (tag === 0x0112) { // Orientation
            const vOff = off + 8;
            orient = le ? view.readUInt16LE(vOff) : view.readUInt16BE(vOff);
            break;
          }
        }
      } catch { }
    }
    // SOF0/1/2 等
    if ((marker >= 0xC0 && marker <= 0xC3) || (marker >= 0xC5 && marker <= 0xC7) ||
      (marker >= 0xC9 && marker <= 0xCB) || (marker >= 0xCD && marker <= 0xCF)) {
      h = (buf[i + 5] << 8) + buf[i + 6];
      w = (buf[i + 7] << 8) + buf[i + 8];
      break;
    }
    i += 2 + len;
  }
  if (!w || !h) throw new Error('jpeg size not found');
  const rotated = (orient >= 5 && orient <= 8);
  if (rotated) [w, h] = [h, w];
  return { width: w, height: h, type: 'jpeg', orientationSwapped: rotated };
}

function parsePNG(buf) {
  const sig = '89504e470d0a1a0a';
  if (buf.slice(0, 8).toString('hex') !== sig) throw new Error('not PNG');
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
  return { width: w, height: h, type: 'png' };
}

function parseGIF(buf) {
  const hdr = buf.slice(0, 6).toString();
  if (hdr !== 'GIF87a' && hdr !== 'GIF89a') throw new Error('not GIF');
  const w = buf.readUInt16LE(6), h = buf.readUInt16LE(8);
  return { width: w, height: h, type: 'gif' };
}

function parseWEBP(buf) {
  if (buf.slice(0, 4).toString() !== 'RIFF' || buf.slice(8, 12).toString() !== 'WEBP')
    throw new Error('not WEBP');
  let p = 12;
  while (p + 8 <= buf.length) {
    const fourCC = buf.slice(p, p + 4).toString();
    const size = buf.readUInt32LE(p + 4);
    const data = buf.slice(p + 8, p + 8 + size);
    if (fourCC === 'VP8X') {
      // 0:flags,1..3:resv, 4..6:width-1, 7..9:height-1  (LE 24-bit)
      const w = 1 + (data[4] | (data[5] << 8) | (data[6] << 16));
      const h = 1 + (data[7] | (data[8] << 8) | (data[9] << 16));
      return { width: w, height: h, type: 'webp' };
    }
    if (fourCC === 'VP8L') {
      // Lossless: https://developers.google.com/speed/webp/docs/riff_container#simple_file_format_lossless
      const b0 = data[1], b1 = data[2], b2 = data[3], b3 = data[4];
      const w = 1 + (((b0) | ((b1 & 0x3F) << 8)));
      const h = 1 + ((((b1 & 0xC0) >> 6) | (b2 << 2) | ((b3 & 0x0F) << 10)));
      return { width: w, height: h, type: 'webp' };
    }
    if (fourCC === 'VP8 ') {
      // Lossy: find 0x9d 0x01 0x2a
      const sig = data.indexOf(Buffer.from([0x9d, 0x01, 0x2a]));
      if (sig >= 0 && sig + 7 < data.length) {
        const w = data.readUInt16LE(sig + 3) & 0x3FFF;
        const h = data.readUInt16LE(sig + 5) & 0x3FFF;
        return { width: w, height: h, type: 'webp' };
      }
    }
    p += 8 + ((size + 1) & ~1); // chunks are padded to even
  }
  throw new Error('webp size not found');
}

function parseSVG(buf) {
  const s = buf.toString('utf8');
  const w = attrNumber(s, 'width');
  const h = attrNumber(s, 'height');
  const vb = viewBox(s); // [minx, miny, w, h]
  if (w && h) return { width: w, height: h, type: 'svg' };
  if (vb && vb[2] && vb[3]) return { width: vb[2], height: vb[3], type: 'svg' };
  // 只拿到比例时，返回 height=100 为基准
  if (vb && vb[2] && vb[3]) {
    const ratio = vb[2] / vb[3];
    return { width: ratio * 100, height: 100, type: 'svg' };
  }
  throw new Error('svg size not found');
}

function attrNumber(xml, name) {
  const m = new RegExp(name + '\\s*=\\s*"([^"]+)"', 'i').exec(xml);
  if (!m) return 0;
  const v = m[1].trim();
  // 支持 px / pt / cm / mm（按 96dpi）
  const num = parseFloat(v);
  if (!isFinite(num)) return 0;
  if (/px$/i.test(v) || /^[0-9.]+$/.test(v)) return num;
  if (/pt$/i.test(v)) return num * (96 / 72);
  if (/cm$/i.test(v)) return num * (96 / 2.54);
  if (/mm$/i.test(v)) return num * (96 / 25.4);
  if (/in$/i.test(v)) return num * 96;
  return num; // 其他单位按 px 近似
}

function viewBox(xml) {
  const m = /viewBox\s*=\s*"([^"]+)"/i.exec(xml);
  if (!m) return null;
  const a = m[1].trim().split(/[\s,]+/).map(Number);
  if (a.length === 4 && a.every(x => isFinite(x))) return a;
  return null;
}

async function ensureDir(p) {
  await fsp.mkdir(p, { recursive: true });
}

async function writeFileIfAbsent(p, buf) {
  try {
    await fsp.access(p, fs.constants.F_OK);
    return false; // 已存在
  } catch {
    await ensureDir(path.dirname(p));
    await fsp.writeFile(p, buf);
    return true;
  }
}

async function fileHash(file) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    const s = fs.createReadStream(file);
    s.on('data', d => h.update(d));
    s.on('end', () => resolve(h.digest('hex')));
    s.on('error', reject);
  });
}

// 简易 argv 解析（保留原有 <in.epub> <outRoot> 位置参数）
function parseFlags(argv) {
  const flags = { force: false, retry: 2, dryRun: false, validate: true, verbose: true };
  for (let i = 4; i < argv.length; i++) {
    const a = argv[i];
    if (!a || a[0] !== '-') continue;
    if (a === '--force') flags.force = true;
    else if (a === '--no-validate') flags.validate = false;
    else if (a === '--quiet') flags.verbose = false;
    else if (a === '--dry-run') flags.dryRun = true;
    else if (a.startsWith('--retry=')) {
      const n = parseInt(a.split('=')[1], 10);
      if (Number.isFinite(n) && n >= 0) flags.retry = n;
    }
  }
  return flags;
}

// 带重试的 entryBuffer
async function entryBuffer(entry, retry = 0) {
  const attempt = async () => {
    const chunks = [];
    return await new Promise((resolve, reject) => {
      entry.stream()
        .on('data', c => chunks.push(c))
        .on('end', () => resolve(Buffer.concat(chunks)))
        .on('error', reject);
    });
  };
  let lastErr;
  for (let i = 0; i <= retry; i++) {
    try {
      return await attempt();
    } catch (e) {
      lastErr = e;
      if (i < retry) await new Promise(r => setTimeout(r, 40 * (i + 1)));
    }
  }
  throw lastErr;
}

// 解析 XML（返回 JS 对象）
function parseXml(xml) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
  });
  return parser.parse(xml);
}


// —— 提取章节标题（从已清洗的 HTML）——
function stripTags(s) { return String(s || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim(); }
function extractTitleFromHtml(html) {
  if (!html) return '';
  // 先找 h1~h3
  let m = html.match(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i);
  if (m) return stripTags(m[1]).slice(0, 120);
  // 再找 <title>
  m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (m) return stripTags(m[1]).slice(0, 120);
  // 再找 strong / 首段
  m = html.match(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/i);
  if (m) return stripTags(m[2]).slice(0, 120);
  m = html.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
  if (m) return stripTags(m[1]).slice(0, 120);
  return '';
}

// 解析 container.xml → 找到 OPF 路径
function getOpfPath(containerXml) {
  const obj = parseXml(containerXml.toString('utf8'));
  const rootfiles = obj?.container?.rootfiles?.rootfile;
  if (!rootfiles) throw new Error('container.xml 缺少 rootfile');
  const r = Array.isArray(rootfiles) ? rootfiles[0] : rootfiles;
  const fullPath = r['full-path'];
  if (!fullPath) throw new Error('rootfile 缺少 full-path');
  return fullPath.replace(/\\/g, '/');
}

// 解析 OPF（manifest + spine + metadata）
function parseOpf(opfBuf, opfPath) {
  const obj = parseXml(opfBuf.toString('utf8'));
  const pkg = obj.package || obj['opf:package'];
  if (!pkg) throw new Error('OPF 解析失败');

  const metadataRaw = pkg.metadata || {};
  const manifest = pkg.manifest?.item || [];
  const spine = pkg.spine?.itemref || [];

  const opfDir = posix.dirname(opfPath);

  const items = Array.isArray(manifest) ? manifest : [manifest];
  const itemByFullHref = new Map();
  const itemById = new Map();

  for (const it of items) {
    if (!it) continue;
    const id = it.id;
    const href = (it.href || '').replace(/\\/g, '/');
    const mediaType = it['media-type'] || it.mediaType || '';
    const props = (it.properties || '').split(/\s+/).filter(Boolean);
    const full = posix.normalize(posix.join(opfDir, href));
    const rec = { id, href, full, mediaType, props };
    itemById.set(id, rec);
    itemByFullHref.set(full, rec);
  }

  const spineIds = Array.isArray(spine) ? spine : [spine];
  const spineItems = spineIds
    .map(s => s?.idref && itemById.get(s.idref))
    .filter(Boolean);

  // 提取基础元数据
  const title = (
    metadataRaw['dc:title'] || metadataRaw.title || metadataRaw['opf:title'] || 'Untitled'
  );
  let creator = metadataRaw['dc:creator'] || metadataRaw.creator || '';
  if (Array.isArray(creator)) creator = creator[0];
  const language = metadataRaw['dc:language'] || metadataRaw.language || '';

  const metadata = { title, creator, language };

  return { opfDir, itemById, itemByFullHref, spineItems, metadata };
}

// 解析 EPUB3 nav.xhtml：从 <nav epub:type="toc"> 里抓 <a>
async function parseNavXhtmlTOC(ctx) {
  if (!ctx || !(ctx.itemById instanceof Map) || !(ctx.entryByPath instanceof Map)) return null;
  const { itemById, entryByPath, flags } = ctx;
  const navItem = [...itemById.values()].find(it => (it.props || []).includes('nav'));
  if (!navItem) return null;
  const entry = entryByPath.get(navItem.full);
  if (!entry) return null;
  const s = (await entryBuffer(entry, flags?.retry || 0)).toString('utf8');

  const navBlock = (s.match(/<nav[^>]*epub:type=["']toc["'][^>]*>([\s\S]*?)<\/nav>/i) || [])[1];
  if (!navBlock) return null;

  const out = [];
  const linkRe = /<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = linkRe.exec(navBlock))) {
    const href = m[1].replace(/#.*/, '');
    const text = stripTags(m[2]);
    out.push({ href, text, level: 1 });
  }
  return out;
}

// 解析 EPUB2 toc.ncx（navMap/navPoint）
async function parseNcxTOC(ctx) {
  if (!ctx || !(ctx.itemById instanceof Map) || !(ctx.entryByPath instanceof Map)) return null;
  const { itemById, entryByPath, flags } = ctx;
  const ncxItem = [...itemById.values()].find(it => /x-dtbncx\+xml$/i.test(it.mediaType));
  if (!ncxItem) return null;
  const entry = entryByPath.get(ncxItem.full);
  if (!entry) return null;
  const xml = (await entryBuffer(entry, flags?.retry || 0)).toString('utf8');
  const obj = parseXml(xml);
  const ncx = obj.ncx || obj['ncx:ncx'];
  if (!ncx) return null;
  const navMap = ncx.navMap || ncx['ncx:navMap'];
  if (!navMap) return null;
  const points = navMap.navPoint || navMap['ncx:navPoint'];
  if (!points) return null;

  const arr = [];
  function walk(nodes, level = 1) {
    const list = Array.isArray(nodes) ? nodes : [nodes];
    for (const p of list) {
      const label = p.navLabel?.text || p['ncx:navLabel']?.text || '';
      const content = p.content?.src || p['ncx:content']?.src || '';
      const href = String(content || '').replace(/#.*/, '');
      const text = stripTags(label);
      if (href) arr.push({ href, text, level });
      if (p.navPoint || p['ncx:navPoint']) walk(p.navPoint || p['ncx:navPoint'], level + 1);
    }
  }
  walk(points, 1);
  return arr;
}

// 统一入口
async function parseTOC(ctx) {
  return (await parseNavXhtmlTOC(ctx)) || (await parseNcxTOC(ctx)) || [];
}

// 把 href 映射到 spine 索引
function hrefToSpineIdx(ctx, href) {
  if (!ctx || !(ctx.itemByFullHref instanceof Map) || !Array.isArray(ctx.spineItems)) return -1;
  const { opfDir, itemByFullHref, spineItems } = ctx;
  if (!href) return -1;
  const cleaned = href.replace(/[#?].*$/, '');
  const full = posix.normalize(posix.join(opfDir, cleaned));
  // 1) 通过 manifest 的 full 路径精确匹配
  const rec = itemByFullHref.get(full);
  if (rec) {
    const idx = spineItems.findIndex(s => s.id === rec.id);
    return idx >= 0 ? idx : -1;
  }
  // 2) 兜底：用 basename 容错
  const base = posix.basename(full);
  const idx2 = spineItems.findIndex(s => posix.basename(s.full) === base);
  return idx2 >= 0 ? idx2 : -1;
}

// 把 HTML 里的资源 URL 重写成 assets/<hash>.<ext>（兼容单双引号 + 无引号）
function rewriteHtmlResources(html, chapterFull, mapToAsset) {
  const baseDir = posix.dirname(chapterFull);

  const normalizeAssetsRel = (p) => {
    let s = String(p).replace(/^\.\/+/, '');
    s = s.replace(/^(?:\.\.\/)+assets\//, 'assets/'); // ../../assets → assets
    while (s.startsWith('assets/assets/')) s = s.replace(/^assets\/assets\//, 'assets/'); // 防 double
    return s;
  };

  const rewriteOne = (url) => {
    const cleaned = String(url).replace(/[#?].*$/, '');
    if (!cleaned || /^(data:|https?:|app:|blob:|mailto:|#)/i.test(cleaned)) return url;
    const full = posix.normalize(posix.join(baseDir, cleaned));
    const mapped = mapToAsset(full);  // 期望已是 "assets/<hash>.<ext>"
    if (!mapped) { console.warn('[MISS]', { from: cleaned, full }); return url; }
    const out = normalizeAssetsRel(mapped);
    console.log('[REWRITE]', { from: cleaned, to: out });
    return out;
  };

  // 通用 attr 重写器：保持原引号风格；无引号则输出无引号
  const attrAnyQ = (_m, pre, d, s, u) => {
    const val = d || s || u;           // 选中哪组就是哪组
    const out = rewriteOne(val);
    if (d !== undefined) return pre + '"' + out + '"';
    if (s !== undefined) return pre + "'" + out + "'";
    return pre + out;                   // 无引号
  };

  // srcset 重写（只匹配有引号的常见写法）
  const attrSrcsetQ = (_m, pre, q, list) => {
    const out = String(list).split(',')
      .map(part => {
        const seg = part.trim(); if (!seg) return seg;
        const [u, ...rest] = seg.split(/\s+/);
        return [rewriteOne(u), ...rest].join(' ');
      })
      .join(', ');
    return pre + q + out + q;
  };

  return html
    // <img|audio|video|source ... src=…>（支持命名空间前缀 & 三种赋值风格）
    .replace(/(<(?:[a-zA-Z]+:)?(?:img|audio|video|source)\b[^>]*?\bsrc\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s"'<>]+))/gi, attrAnyQ)

    // <link rel="stylesheet" href=…>
    .replace(/(<link[^>]+rel=["']stylesheet["'][^>]*?\bhref\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s"'<>]+))/gi, attrAnyQ)

    // SVG: <image|use ... (xlink:href|href)=…>
    .replace(/(<(?:[a-zA-Z]+:)?(?:image|use)\b[^>]*?\b(?:xlink:href|href)\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s"'<>]+))/gi, attrAnyQ)

    // srcset（<img> 或 <picture>/<source>）
    .replace(/(\bsrcset\s*=\s*)(['"])([^'"]+)\2/gi, attrSrcsetQ)

    // 清理脚本与内联 on*
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/\son[a-z]+\s*=\s*(['"])[\s\S]*?\1/gi, '');
}

// 简单重写：HTML 文档中的资源链接（img/src, link/href 等）
// function rewriteHtmlResources(html, chapterFull, mapToAsset) {
//   const baseDir = posix.dirname(chapterFull);

//   const rewriteOne = (url) => {
//     const cleaned = String(url).replace(/[#?].*$/, '');
//     if (!cleaned || /^(data:|https?:|app:|blob:|mailto:|#)/i.test(cleaned)) return url;
//     const full = posix.normalize(posix.join(baseDir, cleaned));
//     const mapped = mapToAsset(full);           // 这里已是 "assets/<hash>.<ext>"
//     if (!mapped) { console.warn('[MISS]', { from: cleaned, full }); return url; }
//     let out = String(mapped).replace(/^(?:\.\.\/)+assets\//, 'assets/');
//     while (out.startsWith('assets/assets/')) out = out.replace(/^assets\/assets\//, 'assets/');
//     console.log('[REWRITE]', { from: cleaned, to: out });
//     return out;
//   };

//   // attr="…" / attr='…'：保持原引号
//   const attrQ = (_m, pre, q, url) => pre + q + rewriteOne(url) + q;

//   // srcset 同理
//   const attrSrcsetQ = (_m, pre, q, list) => {
//     const out = String(list).split(',')
//       .map(part => {
//         const seg = part.trim(); if (!seg) return seg;
//         const [u, ...rest] = seg.split(/\s+/);
//         return [rewriteOne(u), ...rest].join(' ');
//       })
//       .join(', ');
//     return pre + q + out + q;
//   };

//   return html
//     // <img|audio|video|source ... src=…>（可带命名空间前缀）
//     .replace(/(<(?:[a-zA-Z]+:)?(?:img|audio|video|source)\b[^>]*?\bsrc\s*=\s*)(['"])([^'"]+)\2/gi, attrQ)

//     // <link rel="stylesheet" href=…>
//     .replace(/(<link[^>]+rel=["']stylesheet["'][^>]*?\bhref\s*=\s*)(['"])([^'"]+)\2/gi, attrQ)

//     // SVG: <image|use ... (xlink:href|href)=…>（可带命名空间前缀）
//     .replace(/(<(?:[a-zA-Z]+:)?(?:image|use)\b[^>]*?\b(?:xlink:href|href)\s*=\s*)(['"])([^'"]+)\2/gi, attrQ)

//     // srcset
//     .replace(/(\bsrcset\s*=\s*)(['"])([^'"]+)\2/gi, attrSrcsetQ)

//     // 清理
//     .replace(/<script[\s\S]*?<\/script>/gi, '')
//     .replace(/\son[a-z]+\s*=\s*(['"])[\s\S]*?\1/gi, '');
// }




// —— 剔除章节内样式表（只删 <link rel="stylesheet"> / <style>…</style> / xml-stylesheet）——
function stripChapterStyles(html) {
  if (!html) return html;
  return String(html)
    .replace(/<\?xml-stylesheet[\s\S]*?\?>/gi, '') // 处理 PI
    // 任意顺序/空格/单双引号/self-closing 的 link rel=stylesheet
    .replace(/<link\b[^>]*?\brel\s*=\s*['"]?\s*stylesheet\b[^>]*?>/gi, '')
    // 任意 style 块（含 @font-face）
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
}

// 重写 CSS 中的 url(...) 引用
function rewriteCssUrls(css, cssFullPath, mapToAsset) {
  const baseDir = posix.dirname(cssFullPath);
  return css.replace(/url\(([^)]+)\)/gi, (m, raw) => {
    let url = raw.trim().replace(/^['"]|['"]$/g, '');
    const cleaned = url.replace(/[#?].*$/, '');
    if (!cleaned || /^(data:|https?:|app:|blob:)/i.test(cleaned)) return m;
    const full = posix.normalize(posix.join(baseDir, cleaned));
    const mapped = mapToAsset(full);
    return mapped ? `url(${mapped})` : m;
  });
}

// ---------- 主流程 ----------
async function main() {
  const inFile = process.argv[2];
  const outRoot = process.argv[3] || process.cwd();
  const flags = parseFlags(process.argv);
  if (!inFile) {
    console.error('用法: node parse_epub.mjs <in.epub> <outRootDir> [--force] [--retry=2] [--dry-run] [--no-validate] [--quiet]');
    process.exit(1);
  }

  await ensureDir(outRoot);

  // 书签名（含 pipeline）
  const bookHash = await fileHash(inFile);
  const sig = `${bookHash}.${PIPELINE_VERSION}`;

  // 全局 assets 目录（固定一次）
  const assetsDir = path.join(outRoot, 'assets');
  await ensureDir(assetsDir);

  // 打开 ZIP
  const zip = await unzipper.Open.file(inFile);
  const entryByPath = new Map();
  for (const e of zip.files) entryByPath.set(e.path.replace(/\\/g, '/'), e);

  // container.xml → opf
  const containerEntry = entryByPath.get('META-INF/container.xml');
  if (!containerEntry) throw new Error('缺少 META-INF/container.xml');
  const containerXml = await entryBuffer(containerEntry, flags.retry);
  const opfPath = getOpfPath(containerXml);
  const opfEntry = entryByPath.get(opfPath);
  if (!opfEntry) throw new Error(`找不到 OPF: ${opfPath}`);
  const opfBuf = await entryBuffer(opfEntry, flags.retry);

  const { opfDir, itemById, itemByFullHref, spineItems, metadata } = parseOpf(opfBuf, opfPath);

  // —— 建立上下文，传给需要的解析函数 ——
  const ctx = { opfDir, itemById, itemByFullHref, spineItems, entryByPath, flags };

  // 给书生成安全文件夹名（标题 + 短哈希，避免重名）
  const short = bookHash.slice(0, 8);
  const safeTitle =
    (metadata.title || 'untitled')
      .replace(/[\\/:*?"<>|]+/g, '_')
      .slice(0, 40);
  const bookDirName = `${safeTitle}__${short}`;
  const bookDir = path.join(outRoot, 'books', bookDirName);
  const chaptersDir = path.join(bookDir, 'chapters');
  await ensureDir(chaptersDir);

  // === Step 4：幂等 / 断点续跑 / 校验 ===
  // 如果已存在 manifest.json 且 sig 相同：
  //  - 若 --force 未开启且校验通过 → 直接跳过（快速返回）
  //  - 否则尝试修补缺失文件（资源/章节），最后重写 manifest
  let prior = null;
  const manifestPath = path.join(bookDir, 'manifest.json');
  try {
    const raw = await fsp.readFile(manifestPath, 'utf8');
    prior = JSON.parse(raw);
  } catch { }

  const fullToAssetPath = new Map();
  const fullToAssetAbs = new Map();
  const assetsManifest = [];

  // const relAssets = (fn) => posix.join('..', '..', 'assets', fn);
  // 路径修正版（平级）：统一生成 assets/<file>
  const relAssets = (fn) => posix.join('assets', fn);
  const mapToAsset = (full) => fullToAssetPath.get(full) || null;

  // ★ 新增：按 full 路径把任意资源“补录”到 /assets（若尚未存在）
  async function ensureAsset(full, { originalHint = null } = {}) {
    if (!full || fullToAssetPath.has(full)) return fullToAssetPath.get(full) || null;
    const entry = entryByPath.get(full);
    if (!entry) return null; // zip 里都没有，跳过
    const buf = await entryBuffer(entry, flags.retry);
    const mt = (mime.lookup(full) || guessMimeFromPath(full) || 'application/octet-stream').toLowerCase();
    const h = sha256(buf);
    const ext = posix.extname(full) || '.' + (mime.extension(mt) || 'bin');
    const assetFile = `${h}${ext}`;
    const outRel = relAssets(assetFile);
    const outAbs = path.join(assetsDir, assetFile);
    await writeFileIfAbsent(outAbs, buf);
    fullToAssetPath.set(full, outRel);
    fullToAssetAbs.set(full, outAbs);
    // 尺寸（jpg/png/gif/webp/svg 均可，含 jpg/jpeg）【见 getImageSize 入口】
    const dim = getImageSize(buf, mt, full);
    const meta = {
      original: originalHint ?? posix.relative(opfDir, full),
      full, hash: h, size: buf.length, mime: mt, out: outRel
    };
    if (dim && dim.width && dim.height) { meta.width = dim.width; meta.height = dim.height; }
    assetsManifest.push(meta);
    return outRel;
  }

  // ★ 新增：从章节 HTML 中提取可能的资源 URL，并调用 ensureAsset
  // —— 在 parse_epub_step4.mjs 里整段替换 ——
  // 扫描章节 HTML 中的资源引用并 ensureAsset（支持 "…"、'…'、以及无引号值）
  async function hoistRefsFromHtml(html, chapterFull) {
    const baseDir = posix.dirname(chapterFull);
    const seen = new Set();
    const push = async (u) => {
      if (!u) return;
      const cleaned = String(u).replace(/[#?].*$/, '');
      if (!cleaned || /^(data:|https?:|app:|blob:|mailto:|#)/i.test(cleaned)) return;
      const full = posix.normalize(posix.join(baseDir, cleaned));
      if (seen.has(full)) return; seen.add(full);
      await ensureAsset(full);
    };

    // src = "…" | '…' | 无引号
    String(html).replace(/\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>]+))/gi,
      (_m, d, s, u) => { push(d || s || u); return _m; });

    // xlink:href / href = …（排除锚点）— 同样支持三种写法
    String(html).replace(/\b(xlink:href|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>]+))/gi,
      (_m, _a, d, s, u) => { const v = d || s || u; if (!/^#/.test(v)) push(v); return _m; });

    // srcset = …（允许 '…' 或 "…"；无引号情况很少见，这里忽略）
    String(html).replace(/\bsrcset\s*=\s*(['"])([^'"]+)\1/gi, (_m, _q, list) => {
      String(list).split(',').forEach(part => {
        const u = String(part).trim().split(/\s+/, 1)[0] || '';
        push(u);
      });
      return _m;
    });

    // <link rel="stylesheet" href=…> 三种写法
    String(html).replace(/<link[^>]+rel=["']stylesheet["'][^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>]+))/gi,
      (_m, d, s, u) => { push(d || s || u); return _m; });
  }

  async function hoistRefsFromHtml(html, chapterFull) {
    const baseDir = posix.dirname(chapterFull);
    const seen = new Set();
    const push = async (u) => {
      if (!u) return;
      const cleaned = String(u).replace(/[#?].*$/, '');
      if (!cleaned || /^(data:|https?:|app:|blob:|mailto:|#)/i.test(cleaned)) return;
      const full = posix.normalize(posix.join(baseDir, cleaned));
      if (seen.has(full)) return; seen.add(full);
      await ensureAsset(full);
    };

    // src="…" 或 src='…'
    String(html).replace(/\bsrc\s*=\s*(['"])([^'"]+)\1/gi, (m, q, u) => { push(u); return m; });

    // xlink:href / href（单双引号；排除锚点）
    String(html).replace(/\b(xlink:href|href)\s*=\s*(['"])([^'"]+)\2/gi,
      (m, _a, q, u) => { if (!/^#/.test(u)) push(u); return m; });

    // srcset="a 1x, b 2x" 或 srcset='…'
    String(html).replace(/\bsrcset\s*=\s*(['"])([^'"]+)\1/gi, (m, q, list) => {
      String(list).split(',').forEach(part => {
        const u = String(part).trim().split(/\s+/, 1)[0] || '';
        push(u);
      });
      return m;
    });

    // <link rel=stylesheet href="…"> / '…'
    String(html).replace(/<link[^>]+rel=["']stylesheet["'][^>]*?\bhref\s*=\s*(['"])([^'"]+)\1/gi,
      (m, q, u) => { push(u); return m; });
  }

  // 如果有历史 manifest，先吸收映射，便于增量修复
  if (prior && prior.sig === sig && Array.isArray(prior.resources)) {
    for (const r of prior.resources) {
      if (!r || !r.full || !r.out) continue;
      fullToAssetPath.set(r.full, r.out);
      fullToAssetAbs.set(r.full, path.join(bookDir, r.out).replace(/[/\\]books[/\\][^/\\]+[/\\]\.\.[/\\]\.\.[/\\]/, path.sep)); // 粗略还原绝对路径
    }
  }

  // —— 校验函数 ——
  const exists = async (p) => !!(await fsp.access(p).then(() => true).catch(() => false));

  async function validateAll(pr) {
    if (!pr) return false;
    // 资源存在性
    if (Array.isArray(pr.resources)) {
      for (const r of pr.resources) {
        if (!r || !r.out) continue;
        const abs = path.resolve(bookDir, r.out);
        if (!(await exists(abs))) return false;
      }
    }
    // 章节存在性
    if (Array.isArray(pr.chapters)) {
      for (const c of pr.chapters) {
        const abs = path.join(bookDir, c.file);
        if (!(await exists(abs))) return false;
      }
    }
    return true;
  }

  if (prior && prior.sig === sig && flags.validate) {
    const ok = await validateAll(prior);
    if (ok && !flags.force) {
      if (flags.verbose) {
        console.log(`\n== 跳过（已存在相同签名）==`);
        console.log('书名       :', metadata.title);
        console.log('输出目录   :', bookDir);
        console.log('签名       :', sig);
        console.log('构建       :', STEP_BUILD);
      }
      // 命中旧书 → 也更新/生成一次“全局索引”（就地：<outRoot>/.epub-index）
      if (!flags.dryRun) {
        await upsertLibraryIndex({
          sig,
          pipelineVersion: PIPELINE_VERSION,
          manifestPath,
          title: metadata.title || prior?.metadata?.title || '',
          author: metadata.creator || prior?.metadata?.creator || '',
          spineCount: spineItems.length || prior?.spineCount || 0,
          status: 'ready'
        }, outRoot);
        const { file } = getIndexPaths(outRoot);
        if (flags.verbose) console.log('索引已更新  :', file);
      }
      return;
    }
  }

  // === 三段式落地（可增量修补）===
  // 1) 非 HTML/CSS 资源
  let assetsCount = 0, assetsReused = 0;
  for (const it of [...itemById.values()]) {
    const mt = (it.mediaType || '').toLowerCase();
    if (mt === 'application/xhtml+xml' || mt === 'text/css') continue;
    const entry = entryByPath.get(it.full);
    if (!entry) continue;

    // 若已有映射且文件存在，则复用
    const prevOutRel = fullToAssetPath.get(it.full);
    const prevAbs = prevOutRel ? path.join(bookDir, prevOutRel) : null;
    if (prevAbs && await exists(prevAbs) && !flags.force) {
      assetsReused++;
      // 如果是图片，读取已有文件拿到尺寸（AOT 期间写入 manifest）
      let imgMeta = null;
      if (mt.startsWith('image/')) {
        try {
          const buf0 = await fsp.readFile(prevAbs);
          imgMeta = getImageSize(buf0, mt, it.full) || null;
        } catch (_) { }
      }
      assetsManifest.push({
        original: it.href, full: it.full, hash: null, size: null, mime: mt, out: prevOutRel,
        ...(imgMeta ? {
          width: imgMeta.width, height: imgMeta.height,
          orientationSwapped: !!imgMeta.orientationSwapped
        } : {})
      });
      continue;
    }

    const buf = await entryBuffer(entry, flags.retry);
    const h = sha256(buf);
    const ext = posix.extname(it.full) || '.' + (mime.extension(mt) || 'bin');
    const assetFile = `${h}${ext}`;
    const outRel = relAssets(assetFile);
    const outAbs = path.join(assetsDir, assetFile);
    await writeFileIfAbsent(outAbs, buf);
    fullToAssetPath.set(it.full, outRel);
    fullToAssetAbs.set(it.full, outAbs);
    // 如果是图片，解析尺寸并写入 manifest
    let imgMeta = null;
    if (mt.startsWith('image/')) {
      try { imgMeta = getImageSize(buf, mt, it.full) || null; } catch (_) { }
    }
    assetsManifest.push({
      original: it.href, full: it.full, hash: h, size: buf.length, mime: mt, out: outRel,
      ...(imgMeta ? {
        width: imgMeta.width, height: imgMeta.height,
        orientationSwapped: !!imgMeta.orientationSwapped
      } : {})
    });
    assetsCount++;
  }

  // 2) CSS：重写 url(...) → assets，并将 CSS 自身也按 hash 放入 /assets
  let cssBuilt = 0, cssReused = 0;
  const cssAbsList = [];
  const cssRelList = [];
  for (const it of [...itemById.values()]) {
    const mt = (it.mediaType || '').toLowerCase();
    if (mt !== 'text/css') continue;
    const entry = entryByPath.get(it.full);
    if (!entry) continue;

    // 复用逻辑
    const prevOutRel = fullToAssetPath.get(it.full);
    const prevAbs = prevOutRel ? path.join(bookDir, prevOutRel) : null;
    if (prevAbs && await exists(prevAbs) && !flags.force) {
      cssReused++;
      assetsManifest.push({ original: it.href, full: it.full, hash: null, size: null, mime: mt, out: prevOutRel });
      cssAbsList.push(prevAbs);
      cssRelList.push(prevOutRel);
      continue;
    }

    const rawCss = (await entryBuffer(entry, flags.retry)).toString('utf8');
    const rewritten = rewriteCssUrls(rawCss, it.full, mapToAsset);
    const buf = Buffer.from(rewritten, 'utf8');
    const h = sha256(buf);
    const assetFile = `${h}.css`;
    const outRel = relAssets(assetFile);
    const outAbs = path.join(assetsDir, assetFile);
    await writeFileIfAbsent(outAbs, buf);
    fullToAssetPath.set(it.full, outRel);
    fullToAssetAbs.set(it.full, outAbs);
    assetsManifest.push({ original: it.href, full: it.full, hash: h, size: buf.length, mime: mt, out: outRel });
    cssAbsList.push(outAbs);
    cssRelList.push(outRel);
    cssBuilt++;
  }

  // —— 合并一本书 CSS 为单文件（保持出现顺序；去掉多余 @charset）——
  let cssBundleRel = null;
  if (cssAbsList.length) {
    const parts = await Promise.all(cssAbsList.map(p => fsp.readFile(p, 'utf8')));
    // 清 BOM/零宽字符 + 剔除 @font-face 整块
    const cleanedParts = parts.map(s =>
      s.replace(/^\uFEFF/, '')
        .replace(/\uFEFF|\u200B|\u200E|\u200F/g, '')
        .replace(/@font-face\s*\{[\s\S]*?\}\s*/gi, '')
    );

    const merged = cleanedParts.join('\n\n/* ---- split ---- */\n\n')
      .replace(/@charset[^;]+;?/gi, '');
    // const merged = parts.join('\n\n/* ---- split ---- */\n\n').replace(/@charset[^;]+;?/gi, '');
    const mbuf = Buffer.from(merged, 'utf8');
    const mh = sha256(mbuf);
    const mfile = `${mh}.css`;
    const mAbs = path.join(assetsDir, mfile);
    cssBundleRel = relAssets(mfile);
    await writeFileIfAbsent(mAbs, mbuf);
  }

  // 3) HTML（spine）：重写资源引用并落地（仅重建缺失或强制）
  const chapters = [];
  let chaptersBuilt = 0, chaptersReused = 0;
  for (let i = 0; i < spineItems.length; i++) {
    const it = spineItems[i];
    const outName = `${String(i).padStart(3, '0')}.html`;
    const outAbs = path.join(chaptersDir, outName);
    const outRel = posix.join('chapters', outName);

    if (!flags.force) {
      // 如果已有且存在：复用并从 prior 读取元信息（若可用）
      if (await exists(outAbs) && prior && Array.isArray(prior.chapters) && prior.chapters[i] && prior.chapters[i].file === outRel) {
        chapters.push(prior.chapters[i]);
        chaptersReused++;
        continue;
      }
      if (await exists(outAbs) && !prior) {
        // 无 prior 也复用，但需要重新生成元信息
        const st = await fsp.stat(outAbs);
        chapters.push({
          idx: i,
          href: it.href,
          full: it.full,
          file: outRel,
          title: null,
          bytes: st.size,
          sha256: null
        });
        chaptersReused++;
        continue;
      }
    }

    const entry = entryByPath.get(it.full);
    if (!entry) continue;
    const raw = (await entryBuffer(entry, flags.retry)).toString('utf8');

    // ★ 先把章节里用到、但不在 manifest 的资源补录到 /assets（含 <img>、<svg><image>、srcset）
    await hoistRefsFromHtml(raw, it.full);

    // ★ 再走你原来的流程：重写 → 去样式
    const cleaned = rewriteHtmlResources(raw, it.full, mapToAsset);
    const stripped = stripChapterStyles(cleaned);
    // await fsp.writeFile(outAbs, cleaned);
    // ★ 强制写盘（不要用 writeFileIfAbsent）
    await fsp.mkdir(path.dirname(outAbs), { recursive: true });
    await fsp.writeFile(outAbs, stripped, 'utf8');
    const stat = await fsp.stat(outAbs);
    // const guessTitle = extractTitleFromHtml(cleaned);
    const guessTitle = extractTitleFromHtml(stripped);

    chapters.push({
      idx: i,
      href: it.href,
      full: it.full,
      file: outRel,
      title: guessTitle || null,
      bytes: stat.size,
      // sha256: sha256(Buffer.from(cleaned)),
      sha256: sha256(Buffer.from(stripped)),
    });
    chaptersBuilt++;
  }

  // —— 解析 TOC，并将 TOC 标题合并到章节 —— 
  const tocEntries = await parseTOC(ctx); // [{ href, text, level }]
  const toc = [];
  for (const t of tocEntries) {
    const idx = hrefToSpineIdx(ctx, t.href);
    if (idx >= 0 && chapters[idx]) {
      toc.push({ idx, title: t.text || chapters[idx]?.title || `第 ${idx + 1} 章`, level: t.level || 1, href: t.href });
      if (!chapters[idx].title) chapters[idx].title = t.text || chapters[idx].title;
    }
  }

  // 兜底标题
  for (const c of chapters) {
    if (!c.title) c.title = c.href || `第 ${c.idx + 1} 章`;
  }

  const manifest = {
    pipelineVersion: PIPELINE_VERSION,
    build: STEP_BUILD,
    sig,
    source: path.resolve(inFile),
    metadata,
    opf: { path: opfPath, dir: opfDir },
    spineCount: spineItems.length,
    chapters,
    toc,
    resources: assetsManifest,
    cssBundle: cssBundleRel ? { out: cssBundleRel, parts: cssRelList } : null,
    size: {
      chaptersBytes: chapters.reduce((a, b) => a + (b.bytes || 0), 0),
      assetsBytes: assetsManifest.reduce((a, b) => a + (b.size || 0), 0),
      approxManifestBytes: 0,
      approxTotalBytes: 0
    },
    createdAt: new Date().toISOString(),
  };
  manifest.size.approxManifestBytes = JSON.stringify({ ...manifest, size: undefined }).length;
  manifest.size.approxTotalBytes =
    manifest.size.chaptersBytes + manifest.size.assetsBytes + manifest.size.approxManifestBytes;

  if (!flags.dryRun) {
    await ensureDir(bookDir);
    await fsp.writeFile(path.join(bookDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

    // 写出 book manifest 后，更新/生成全局索引（就地：<outRoot>/.epub-index）
    await upsertLibraryIndex({
      sig,
      pipelineVersion: PIPELINE_VERSION,
      manifestPath,
      title: metadata.title || '',
      author: metadata.creator || '',
      spineCount: spineItems.length,
      status: 'ready'
    }, outRoot);
    const { file } = getIndexPaths(outRoot);
    if (flags.verbose) console.log('索引已更新  :', file);
  }

  if (flags.verbose) {
    console.log('\n== AOT 完成 ==');
    console.log('书名       :', metadata.title);
    console.log('输出目录   :', bookDir);
    console.log('签名       :', sig);
    console.log('构建       :', STEP_BUILD);
    console.log('复用       : 资源', assetsReused, '个  /  CSS', cssReused, '个  /  章节', chaptersReused, '个');
    console.log('重建       : 资源', assetsCount, '个  /  CSS', cssBuilt, '个  /  章节', chaptersBuilt, '个');
  }
}

main().catch(err => {
  console.error('解析失败:', err);
  process.exit(1);
});
