// --- Global per-book state store (namespace = reader::<bookKey>) ---
(function () {
  function _bk() {
    try { return window.bookKey || window.__bookKey || 'global'; } catch { return 'global'; }
  }
  window.readBookState = function () {
    try {
      const raw = localStorage.getItem(`reader::${_bk()}`);
      return raw ? JSON.parse(raw) : {};
    } catch { return {}; }
  };
  window.writeBookState = function (patch) {
    const key = (function _bk() {
      try { return window.bookKey || window.__bookKey || 'global'; } catch { return 'global'; }
    })();

    if (key === 'global') return patch || {};     // ⭐ 关键：bookKey 未就绪时不落盘

    const raw = localStorage.getItem(`reader::${key}`);
    const cur = raw ? (JSON.parse(raw) || {}) : {};
    const next = { ...cur, ...(patch || {}) };
    try { localStorage.setItem(`reader::${key}`, JSON.stringify(next)); } catch { }
    return next;
  };
})();

// === 字号缩放：Ctrl+(= / +) 放大；Ctrl+(-) 缩小；Ctrl+0 重置 ===
// 区间：16px ~ 28px；按书记忆 localStorage::fontPx::<bookKey>
(() => {
  const FONT_MIN = 16;
  const FONT_MAX = 28;
  const STEP = 1;


  // —— 项目常用命名：bookKey / statusBar / lightLockToChapter —— //
  const getBookKey = () => {
    try { return (window.bookKey || window.__bookKey || 'global'); } catch { return 'global'; }
  };
  const lsKey = () => `fontPx::${getBookKey()}`;

  // 让正文统一受一个 CSS 变量控制（不改你现有样式，只加变量入口）
  function ensureFontStyleHost() {
    const id = 'reader-fontsize-style';
    if (!document.getElementById(id)) {
      const s = document.createElement('style');
      s.id = id;
      // 使用项目中通用的正文容器：.chapter-body
      s.textContent = `.chapter-body { font-size: var(--content-font-size, 16px); }`;
      document.head.appendChild(s);
    }
  }

  // 轻量“中线锚定”，若你已有 lightLockToChapter 则优先用你的
  function withViewportLock(apply) {
    if (typeof window.lightLockToChapter === 'function') {
      // 取当前中线所在章节，做一次轻锁（200ms）
      const midY = Math.floor(window.innerHeight / 2);
      const midEl = document.elementFromPoint(Math.floor(window.innerWidth / 2), midY);
      // 找到最近的 .chapter 容器（保守写法）
      let sec = midEl;
      while (sec && !(sec.classList && sec.classList.contains('chapter'))) sec = sec.parentNode;
      apply?.();
      if (sec) window.lightLockToChapter(sec, 240);
      return;
    }
    // 兜底：差值法
    const cx = Math.floor(window.innerWidth / 2);
    const cy = Math.floor(window.innerHeight / 2);
    const anchor = document.elementFromPoint(cx, cy);
    if (!anchor) { apply?.(); return; }
    const beforeTop = anchor.getBoundingClientRect().top;
    const deltaToMid = cy - beforeTop;
    apply?.();
    requestAnimationFrame(() => {
      if (!document.contains(anchor)) return;
      const afterTop = anchor.getBoundingClientRect().top;
      const need = afterTop - (cy - deltaToMid);
      if (Math.abs(need) > 0.5) window.scrollBy(0, need);
    });
  }

  // function setFontPx(px, { toast = true } = {}) {
  //   const clamped = Math.max(FONT_MIN, Math.min(FONT_MAX, Math.round(px)));
  //   document.documentElement.style.setProperty('--content-font-size', clamped + 'px');
  //   try { localStorage.setItem(lsKey(), String(clamped)); } catch { }
  //   if (toast && window.statusBar?.hint) window.statusBar.hint(`字号：${clamped}px`, 1000);
  //   return clamped;
  // }

  // function readFontPx() {
  //   try {
  //     const v = localStorage.getItem(lsKey());
  //     const n = parseInt(v, 10);
  //     return Number.isFinite(n) ? n : FONT_MIN;
  //   } catch { return FONT_MIN; }
  // }

  const legacyFontKey = () => `fontPx::${getBookKey()}`;

  function setFontPx(px, { toast = true } = {}) {
    const clamped = Math.max(FONT_MIN, Math.min(FONT_MAX, Math.round(px)));
    document.documentElement.style.setProperty('--content-font-size', clamped + 'px');
    writeBookState({ fontPx: clamped }); // ← 统一写集中状态
    if (toast && window.statusBar?.hint) window.statusBar.hint(`字号：${clamped}px`, 1000);
    return clamped;
  }

  function readFontPx() {
    // 1) 新：集中状态
    const st = readBookState();
    if (Number.isFinite(st.fontPx)) return st.fontPx;
    return FONT_MIN;
  }

  function initForBook({ silent = true } = {}) {
    ensureFontStyleHost();
    setFontPx(readFontPx(), { toast: !silent });
  }

  function inc() {
    withViewportLock(() => {
      const cur = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--content-font-size')) || FONT_MIN;
      setFontPx(cur + STEP);
    });
  }
  function dec() {
    withViewportLock(() => {
      const cur = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--content-font-size')) || FONT_MIN;
      setFontPx(cur - STEP);
    });
  }
  function reset() {
    withViewportLock(() => setFontPx(FONT_MIN));
  }

  // 键盘：Ctrl + (= / + / NumpadAdd) 放大；Ctrl + (- / NumpadSubtract) 缩小；Ctrl + 0 重置
  function onKeydown(e) {
    if (!e.ctrlKey) return;
    const k = e.key;
    const code = e.code;
    if (k === '=' || k === '+' || code === 'NumpadAdd') {
      e.preventDefault(); inc();
    } else if (k === '-' || code === 'NumpadSubtract') {
      e.preventDefault(); dec();
    } else if (k === '0') {
      e.preventDefault(); reset();
    }
  }

  // （可选）锁死 Chromium 视觉缩放，避免 Ctrl+滚轮放大页面
  try {
    const { webFrame } = require?.('electron') ?? {};
    if (webFrame?.setVisualZoomLevelLimits) webFrame.setVisualZoomLevelLimits(1, 1);
  } catch { }

  // 对外显式 API（便于在 onBookLoaded / bootWithManifest 后手动调用）
  window.fontZoom = { initForBook, setFontPx, inc, dec, reset };

  // 只注册快捷键；真正的 init 在 bootWithManifest 里做
  const registerKeys = () => {
    window.addEventListener('keydown', onKeydown, { capture: true });
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', registerKeys, { once: true });
  } else {
    registerKeys();
  }

})();

// renderer.no-clear.scrolldown.js — 无清场 + 向下滚动补章 + 跳转置顶（极简稳态）
(() => {
  const $ = (sel, root = document) => root.querySelector(sel);

  // DOM refs
  const tocEl = $('#toc');
  const contentEl = $('#content');
  const scrollerEl = contentEl.closest('.content-wrap') || contentEl;
  const overlayTitle = $('#overlay-title');
  const statusEl = document.querySelector('#overlay-status');
  /**
   * 显示状态胶囊
   * @param {string} msg - 文案；传空/false 清空并隐藏
   * @param {object}  [opt]
   *   - ttl    自动隐藏毫秒数（默认 1600ms；0 表示不自动隐藏）
   *   - sticky 是否常驻（默认 false；true 时忽略 ttl）
   *   - level  'info' | 'warn' | 'error'（可用于加类名，下面留了钩子）
   */
  function setStatus(msg, opt = {}) {
    if (!statusEl) return;
    const text = String(msg || '');
    const level = opt.level || 'info';

    // 简单的“错误默认常驻”启发式（可删）
    const autoSticky = /失败|错误|error|failed/i.test(text);
    const sticky = opt.sticky ?? autoSticky;
    const ttl = Number.isFinite(opt.ttl) ? opt.ttl : 1600;

    // 清除上一个定时器
    if (__statusHideTimer) { clearTimeout(__statusHideTimer); __statusHideTimer = 0; }

    // 清空/隐藏
    if (!text) {
      statusEl.textContent = '';
      statusEl.classList.remove('is-visible');
      statusEl.removeAttribute('data-level');
      return;
    }

    // 显示
    statusEl.textContent = text;
    statusEl.dataset.level = level;              // 需要时可用 CSS 做不同配色
    statusEl.classList.add('is-visible');

    // 并发序号：只让最后一次调用生效定时器
    const mySeq = ++__statusSeq;

    if (!sticky && ttl > 0) {
      __statusHideTimer = setTimeout(() => {
        if (mySeq !== __statusSeq) return;       // 已被更新，放弃
        statusEl.classList.remove('is-visible');
        // 等淡出动画结束再抹掉文本，避免闪烁
        setTimeout(() => {
          if (mySeq === __statusSeq) statusEl.textContent = '';
        }, 180);
        __statusHideTimer = 0;
      }, ttl);
    }

    return mySeq; // 如需外部对比可用
  }

  // 便捷清空
  function clearStatus() { setStatus(''); }

  // 状态
  let manifest = null;
  let bookDir = null;
  let activeIdx = -1;

  // 已加载窗口边界（不清场 → 累加式）
  let headIdx = Infinity;  // 当前 DOM 中最小章节 idx（未加载则 Infinity）
  let tailIdx = -1;        // 当前 DOM 中最大章节 idx（未加载则 -1）
  let loading = false;     // 单通道加载锁（滚动/跳转共用）
  let scrollSaveTimer = null;  // ← 新增：滚动保存节流定时器

  let __statusHideTimer = 0;
  let __statusSeq = 0;

  // —— 中线高亮所需的最小状态 —— 
  let progScrolling = false;      // 程序化滚动时，暂停高亮器更新
  const MID_REF_RATIO = 0.5;      // 中线位置（内容容器高度的 50%）
  const HYSTERESIS = 0.10;        // 黏滞带（±10% 高度），减少抖动
  const SHORT_RATIO = 0.6;        // “短章”阈值：章高 < 0.6 * 视口高时优先靠上判断
  const TOP_BAND_PX = 80;         // 顶部判定带宽：短章贴近顶部时也视为激活

  // —— TOC 滚动持久化（每本书） —— //
  let __tocRestoreGuard = false;  // 恢复期间不记滚动
  let __tocSaveRaf = 0;           // rAF 节流句柄
  let restoring = false; // ← 新增：切书恢复期，禁止写入状态

  // —— 大跨度跳转：测试阈值 —— //
  const TOC_JUMP_K = 10;                 // 先用 3，验证后改 10
  let __tocNeedsAlign = false;          // 仅内存标记（不落盘）

  const NEAR_BOTTOM_PX = Math.max(600, window.innerHeight * 0.4); // 触底阈值

  const PIPELINE_VERSION = 'aot-v1';

  // 统一走主进程计算 SIG（优先 path→fromPath，其次 blob→fromBlob；不在 renderer 做哈希）
  // const PIPELINE_VERSION = 'aot-v1';
  // async function computeSigFromFile(file) {
  //   if (!window.sigAPI?.fromBlob) throw new Error('sigAPI.fromBlob 不可用');
  //   return await window.sigAPI.fromBlob(file, { pipelineVersion: PIPELINE_VERSION, chunkSize: 2 * 1024 * 1024 });
  // }

  // 最小可用版：只负责拖入文件 → 计算 sig → 匹配索引 → 打印结果
    function bindDrop() {
    const root = document.documentElement;

    ['dragover', 'drop'].forEach(t => {
      window.addEventListener(t, e => e.preventDefault(), true);
      document.addEventListener(t, e => e.preventDefault(), true);
    });

    document.addEventListener('dragover', () => {
      root.classList.add('is-dragover');
      typeof setStatus === 'function' && setStatus('拖入 .epub 或 manifest.json', { sticky: true });
    });
    document.addEventListener('dragleave', () => {
      root.classList.remove('is-dragover');
      typeof clearStatus === 'function' && clearStatus();
    });

    document.addEventListener('drop', async (e) => {
      e.preventDefault();
      root.classList.remove('is-dragover');

      try {
        const f0 = (e.dataTransfer?.files || [])[0];
        if (!f0) return;

        typeof setStatus === 'function' && setStatus('解析中（worker）…', { sticky: true });

        const { hash } = await window.parser.parseFile(f0);
        const sig = `${hash}.aot-v1`;

        // ② 用 sig 做索引匹配（main 读 JSON）
        let { matched, entry } = await window.sig.check(sig);

        console.log('[drop] sig:', sig, 'matched:', matched, entry || null);
        typeof clearStatus === 'function' && clearStatus();

        // ③ （可选）继续：命中旧书就 openFromIndexEntry(entry)，否则 freshParseFromFile(f0)
        if (matched && entry?.manifestPath) {
          await bootWithManifest(entry.manifestPath);
        } else {
          // 未命中缓存：启动 AOT 解析，并在解析完成后重试索引
          try {
            setStatus('未命中缓存，正在解析 EPUB…', { sticky: true });
            const res = await window.aot.parseEpub(f0);
            if (res?.ok) {
              // 解析完成后再次匹配索引
              const chk = await window.sig.check(sig);
              if (chk.matched && chk.entry?.manifestPath) {
                await bootWithManifest(chk.entry.manifestPath);
                return;
              }
            } else {
              console.warn('解析失败:', res?.error);
            }
            // 解析完成但仍未命中索引：提示用户
            setStatus(`解析完成，但未能匹配 manifest（sig=${sig}）`, { level: 'error', sticky: true });
          } catch (e) {
            console.error('AOT 解析出错:', e);
            setStatus('解析出错：' + (e?.message || e), { level: 'error', sticky: true });
          }
        }
      } catch { /* ignore errors */ }
      // 不再调用 openEntryUnified(f0.path || f0.name)，避免依赖文件路径
    });
  }

    bindDrop();

  // 工具
  function chapterPath(idx) { return manifest?.chapters?.[idx]?.file || ''; }

  function offsetTopWithin(el, container) {
    const er = el.getBoundingClientRect();
    const cr = container.getBoundingClientRect();
    return er.top - cr.top + container.scrollTop;
  }

  function restoreTocScrollTop() {
    if (!window.readBookState) return;
    __tocRestoreGuard = true;
    try {
      const st = readBookState() || {};
      const v = st?.toc?.scrollTop;
      if (Number.isFinite(v) && v >= 0) {
        // 注意：此时 tocEl 必须已渲染好且高度稳定
        tocEl.scrollTop = v;
      }
    } finally {
      // 给一点点缓冲，避免立即触发保存
      setTimeout(() => { __tocRestoreGuard = false; }, 80);
    }
  }

  function saveTocScrollTop() {
    if (!window.writeBookState || __tocRestoreGuard) return;
    const cur = (readBookState && readBookState()) || {};
    const patch = {
      toc: { ...(cur.toc || {}), scrollTop: Math.round(tocEl.scrollTop) }
    };
    // writeBookState 是“浅合并”，所以这里把 toc 自己合并好再写
    writeBookState(patch);
  }

  const isTocCollapsed = () =>
    document.documentElement.classList.contains('is-rail');

  // 利用你前面已加的恢复守门，避免对齐时立刻写入 scrollTop
  function revealActiveInTOC({ center = false } = {}) {
    const el = tocEl?.querySelector('.chap.active');
    if (!el) return;
    __tocRestoreGuard = true;
    el.scrollIntoView({ block: center ? 'center' : 'nearest', inline: 'nearest' });
    setTimeout(() => { __tocRestoreGuard = false; }, 80);
  }

  function maybeFlagTocAlign(nextIdx) {
    const prev = (Number.isFinite(activeIdx) && activeIdx >= 0) ? activeIdx : nextIdx;
    if (Math.abs(nextIdx - prev) >= TOC_JUMP_K && isTocCollapsed()) {
      __tocNeedsAlign = true;
    }
  }

  function chapterTitle(idx) {
    const c = manifest?.chapters?.[idx];
    return (c && (c.title || c.href)) || `第 ${idx + 1} 章`;
  }

  function makeBookKey(manifestPath, manifest) {
    const sig = manifest?.sig || manifest?.hash || manifest?.pipelineVersion || '';
    return sig ? `${manifestPath}#${sig}` : manifestPath;  // 和你进度键的风格一致
  }

  function spineCount() { return manifest?.spineCount ?? manifest?.chapters?.length ?? 0; }

  // 资源绝对化
  function assetUrlFromRel(rel) {
    let r = String(rel || '').replace(/^\.\/+/, '').replace(/^\/+/, '');
    // 折叠 ../../assets/xxx → assets/xxx
    r = r.replace(/^(?:\.\.\/)+assets\//, 'assets/');
    // 折叠 assets/assets/xxx → assets/xxx
    while (r.startsWith('assets/assets/')) r = r.replace(/^assets\/assets\//, 'assets/');
    // 已经是 assets/ 前缀就直接用；否则再补一次
    return r.startsWith('assets/') ? r : `assets/${r}`;
  }

  function absolutizeChapterHtml(html) {
    const tpl = document.createElement('template');
    tpl.innerHTML = html;
    const fix = (u) => assetUrlFromRel(u) || u;

    tpl.content.querySelectorAll('[src]').forEach(el => {
      const v = el.getAttribute('src'); if (v) el.setAttribute('src', fix(v));
    });
    tpl.content.querySelectorAll('[href]').forEach(el => {
      const v = el.getAttribute('href'); if (v && !v.startsWith('#')) el.setAttribute('href', fix(v));
    });
    tpl.content.querySelectorAll('[xlink\\:href]').forEach(el => {
      const v = el.getAttribute('xlink:href'); if (v && !v.startsWith('#')) el.setAttribute('xlink:href', fix(v));
    });
    tpl.content.querySelectorAll('[srcset]').forEach(el => {
      const v = el.getAttribute('srcset') || '';
      const parts = v.split(',').map(s => {
        const m = s.trim().split(/\s+/, 2);
        const url = m[0] || '';
        const desc = m[1] || '';
        return [fix(url), desc].filter(Boolean).join(' ');
      });
      el.setAttribute('srcset', parts.join(', '));
    });
    return tpl.innerHTML;
  }

  // —— 把任意 URL 规范成 'assets/<rel>'（去协议/域名/前缀/../、去 ?/#）——
  function canonAssetPath(url) {
    if (!url) return '';
    const s = decodeURIComponent(String(url));
    const clean = s.replace(/[?#].*$/, '');         // 去掉 query/hash
    const i = clean.lastIndexOf('assets/');        // 只认平级 assets
    return i >= 0 ? clean.slice(i) : '';
  }

  // —— 将 manifest.resources 里的尺寸写回 <img>（按 out 路径匹配）
  // —— 将 manifest.resources 的尺寸写回 <img>（按 'assets/<rel>' 匹配）——
  let __resByOut = null;
  function injectImgSizeAttrs(html) {
    if (!html) return html;
    const tpl = document.createElement('template');
    tpl.innerHTML = html;

    const byOut = __resByOut || new Map();
    tpl.content.querySelectorAll('img').forEach(img => {
      if (!img) return;
      if (img.hasAttribute('width') && img.hasAttribute('height')) return; // 已有则不改
      if (img.hasAttribute('srcset')) return; // 多源图先跳过，避免冲突

      const key = canonAssetPath(img.getAttribute('src') || '');
      if (!key) return;

      const meta = byOut.get(key);
      if (meta && meta.width && meta.height) {
        img.setAttribute('width', meta.width);
        img.setAttribute('height', meta.height);
      }
    });

    return tpl.innerHTML;
  }

  // 目录
  function buildTOC() {
    tocEl.innerHTML = '';
    const items = manifest?.toc?.length ? manifest.toc
      : (manifest?.chapters || []).map((c, i) => ({ idx: i, title: c.title || c.href || `第 ${i + 1} 章` }));

    if (!items.length) {
      const d = document.createElement('div');
      d.className = 'empty pad';
      d.textContent = '没有可用目录';
      tocEl.appendChild(d);
      return;
    }
    for (const t of items) {
      const div = document.createElement('div');
      div.className = 'chap';
      div.dataset.idx = String(t.idx);
      div.textContent = t.title || `第 ${t.idx + 1} 章`;

      div.innerHTML = `<span class="t">${t.title}</span>`;
      // div.addEventListener('click', () => jumpTo(t.idx));
      div.addEventListener('click', () => softClearJump(t.idx));
      tocEl.appendChild(div);
    }
    markActive(activeIdx);
  }

  function markActive(idx) {
    [...tocEl.querySelectorAll('.chap')].forEach(el => {
      el.classList.toggle('active', Number(el.dataset.idx) === idx);
    });
    // if (Number.isFinite(idx) && idx >= 0) writeBookState({ activeIdx: idx });
    if (!restoring && Number.isFinite(idx) && idx >= 0) {
      writeBookState({ activeIdx: idx });
    }
  }

  // 在正确位置插入一个“空壳”section；返回该节点
  function insertSectionShell(idx) {
    const sec = document.createElement('section');
    sec.className = 'chapter';
    sec.dataset.idx = String(idx);

    const all = [...contentEl.querySelectorAll('.chapter')];
    if (!all.length) {
      contentEl.appendChild(sec);
      headIdx = Math.min(headIdx, idx);
      tailIdx = Math.max(tailIdx, idx);
      return sec;
    }

    // 找到第一个 data-idx 大于 idx 的元素，插在它前面；否则 append
    const at = all.find(el => Number(el.dataset.idx) > idx);
    if (at) contentEl.insertBefore(sec, at);
    else contentEl.appendChild(sec);

    // 更新边界
    headIdx = Math.min(headIdx, idx);
    tailIdx = Math.max(tailIdx, idx);
    return sec;
  }

  // 确保 idx 对应的章节已加载到 DOM（就地填充）
  async function ensureSection(idx) {
    if (idx < 0 || idx >= spineCount()) return null;
    const existed = contentEl.querySelector(`.chapter[data-idx="${idx}"]`);
    const sec = existed || insertSectionShell(idx);

    // 如果已经有正文则不再重复读盘
    if (sec.querySelector('.chapter-body')?.getAttribute('data-ready') === '1') return sec;

    const file = chapterPath(idx);
    try {
      const raw = await window.eapi.readChapter(bookDir, file);
      const fixed = absolutizeChapterHtml(raw);
      const fixed2 = injectImgSizeAttrs(fixed);
      // 可能在等待期间被删除或移动，重新获取当前节点
      const now = contentEl.querySelector(`.chapter[data-idx="${idx}"]`);
      if (!now) return sec;

      let body = now.querySelector('.chapter-body');
      if (!body) {
        body = document.createElement('div');
        body.className = 'chapter-body';
        now.appendChild(body);
      }
      body.innerHTML = fixed2;
      body.setAttribute('data-ready', '1');
    } catch (e) {
      console.error('[ensureSection] readChapter failed:', e);
      const now = contentEl.querySelector(`.chapter[data-idx="${idx}"]`);
      if (now) {
        let body = now.querySelector('.chapter-body') || now.appendChild(document.createElement('div'));
        body.className = 'chapter-body';
        body.innerHTML = `<div class="empty pad">加载失败：${e?.message || e}</div>`;
        body.setAttribute('data-ready', '1');
      }
    }
    return sec;
  }

  // 章首置顶（不做动画，只做微调）
  function scrollChapterToTop(sec) {
    if (!sec) return;
    // const want = sec.offsetTop;
    const want = offsetTopWithin(sec, scrollerEl);
    progScrolling = true;              // ← 新增：开始程序化滚动（暂停高亮器）
    scrollerEl.scrollTop = want;
    // 双 rAF 微调一次，避免图片/字体回流带来的轻微偏差
    requestAnimationFrame(() => {
      const want2 = offsetTopWithin(sec, scrollerEl);
      const d = want2 - scrollerEl.scrollTop;
      // const d = sec.offsetTop - contentEl.scrollTop;
      if (Math.abs(d) > 2) scrollerEl.scrollTop += d;
      // 稍等一会儿再解除，给布局/图片一个缓冲
      setTimeout(() => { progScrolling = false; }, 300);   // ← 新增：结束程序化滚动
    });
  }

  // === 视口锁：在不改观感的前提下做 DOM 大改 ===
  function withViewportLock(anchorEl, mutate, options = {}) {
    const { unlockMs = 300, pinToTopEl = null, disableSmooth = true } = options;

    const prevBehavior = contentEl.style.scrollBehavior;
    if (disableSmooth) contentEl.style.scrollBehavior = 'auto';

    const pre = anchorEl ? (anchorEl.offsetTop - contentEl.scrollTop) : 0;

    progScrolling = true;
    scrollerEl.classList.add('jump-lock');   // 锁
    // contentEl.classList.add('jump-lock');   
    mutate(); // —— 在同一帧里做 DOM 变更 ——

    // ★ 关键：在首帧“立即把目标章顶到容器顶部”，避免先看到 A-1
    if (pinToTopEl) {
      const el = (typeof pinToTopEl === 'function') ? pinToTopEl() : pinToTopEl;
      if (el) contentEl.scrollTop = el.offsetTop;
    }

    requestAnimationFrame(() => {
      if (anchorEl) {
        // const post = anchorEl.offsetTop - contentEl.scrollTop;
        const post = anchorEl.getBoundingClientRect().top - scrollerEl.getBoundingClientRect().top;
        const delta = post - pre;
        // if (Math.abs(delta) > 0) contentEl.scrollTop += delta;
        if (delta) scrollerEl.scrollTop += delta;
      }
      setTimeout(() => {
        // contentEl.classList.remove('jump-lock'); 
        scrollerEl.classList.remove('jump-lock');
        progScrolling = false;
        // if (disableSmooth) contentEl.style.scrollBehavior = prevBehavior;
        if (disableSmooth) scrollerEl.style.scrollBehavior = prevBehavior;
      }, unlockMs);
    });
  }

  // 获取当前视口顶部最接近的章节（做锚点兜底）
  function topVisibleChapter() {
    // const rect = contentEl.getBoundingClientRect();
    // const list = [...contentEl.querySelectorAll('.chapter')];
    const rect = scrollerEl.getBoundingClientRect();
    const list = [...contentEl.querySelectorAll('.chapter')];
    let topEl = null, best = Infinity;
    for (const el of list) {
      const r = el.getBoundingClientRect();
      const nearTop = Math.abs(r.top - rect.top);
      const visible = r.bottom > rect.top && r.top < rect.bottom;
      if (visible && nearTop < best) { topEl = el; best = nearTop; }
    }
    return topEl || list[0] || null;
  }

  // 软清场跳转：离屏构建 A±1，原位替换，再异步填充正文
  // async function softClearJump(idx, radius = 1) {
  //   const total = spineCount();
  //   if (!total) return;
  //   idx = Math.max(0, Math.min(idx, total - 1));
  //   const start = Math.max(0, idx - radius);
  //   const end = Math.min(total - 1, idx + radius);

  //   // 离屏骨架
  //   const frag = document.createDocumentFragment();
  //   for (let i = start; i <= end; i++) {
  //     const sec = document.createElement('section');
  //     sec.className = 'chapter';
  //     sec.dataset.idx = String(i);
  //     frag.appendChild(sec);
  //   }

  //   // 用 pinToTopEl 在同一帧把 A 顶到容器顶部；anchorEl 可设为 null（不做旧锚补偿）
  //   withViewportLock(null, () => {
  //     contentEl.replaceChildren(frag);
  //     headIdx = start; tailIdx = end; activeIdx = idx; markActive(idx);
  //   }, {
  //     unlockMs: 350,
  //     pinToTopEl: () => contentEl.querySelector(`.chapter[data-idx="${idx}"]`),
  //     disableSmooth: true
  //   });

  //   // 异步填充正文（就地写入 .chapter-body）
  //   for (let i = start; i <= end; i++) {
  //     // eslint-disable-next-line no-await-in-loop
  //     await ensureSection(i);
  //   }
  // }

  // 向下补 1 章（若存在）——不清场

  // —— 软清场跳转：A → A+1 → A-1（避免先渲 A-1 顶走 A）——

  // 软清场跳转（默认仅向下窗口）：严格 A → A+1；不插 A-1，避免把 A 顶走
  // 想要三章窗口：softClearJump(idx, { up: 1, down: 1 })
  async function softClearJump(idx, opts = {}) {
    const total = spineCount();
    if (!total) return;

    idx = Math.max(0, Math.min(idx, total - 1));

    maybeFlagTocAlign(idx);             // ★ 新增

    const up = Number.isFinite(opts.up) ? Math.max(0, opts.up) : 0; // 默认不向上
    const down = Number.isFinite(opts.down) ? Math.max(0, opts.down) : 1; // 默认向下 1 章
    const start = Math.max(0, idx - up);
    const end = Math.min(total - 1, idx + down);

    // 离屏骨架：按 start..end 先挂空壳（顺序只影响空壳位置，不影响填充顺序）
    const frag = document.createDocumentFragment();
    for (let i = start; i <= end; i++) {
      const sec = document.createElement('section');
      sec.className = 'chapter';
      sec.dataset.idx = String(i);
      frag.appendChild(sec);
    }

    // 一帧内替换，并把 A 顶到容器顶部（首帧避免看到 A-1）
    withViewportLock(null, () => {
      contentEl.replaceChildren(frag);
      headIdx = start; tailIdx = end;
      activeIdx = idx; markActive(idx);
    }, {
      unlockMs: 350,
      pinToTopEl: () => contentEl.querySelector(`.chapter[data-idx="${idx}"]`),
      disableSmooth: true
    }); // 引用你现有的 withViewportLock。【14:​:contentReference[oaicite:2]{index=2}】

    // 1) 先渲 A（await，确保正文稳稳挂上）
    await ensureSection(idx); // 你现有的就地填充方法。【16:​:contentReference[oaicite:3]{index=3}】
    if (Number.isFinite(idx)) writeBookState({ activeIdx: idx });
    // 2) 再渲 A+1（不阻塞 UI）
    for (let j = idx + 1; j <= end; j++) {
      // 按需渲染到队尾
      // 无需 await，滚动快时由触底补章继续推进
      Promise.resolve().then(() => ensureSection(j));
    }

    // 3) （可选）最后补 A-1，并锚定到 A 做补偿，避免把 A 顶走
    for (let j = idx - 1; j >= start; j--) {
      // 只有当 up>0 时才会进入这里
      // const anchor = contentEl.querySelector(`.chapter[data-idx="${idx}"]`);
      // const pre = anchor ? (anchor.offsetTop - contentEl.scrollTop) : 0;
      const anchor = contentEl.querySelector(`.chapter[data-idx="${idx}"]`);
      const pre = anchor ? (anchor.getBoundingClientRect().top - scrollerEl.getBoundingClientRect().top) : 0;
      // 确保壳位于正确顺序（你已有的插壳函数）
      insertSectionShell(j); // 保序插入空壳。【13:​:contentReference[oaicite:4]{index=4}】

      // 真正填充正文（await）
      await ensureSection(j);

      // 锚点补偿：把 A 拉回原先的相对位置
      if (anchor) {
        // const post = anchor.offsetTop - contentEl.scrollTop;
        // const delta = post - pre;
        // if (delta !== 0) contentEl.scrollTop += delta;
        const post = anchor.getBoundingClientRect().top - scrollerEl.getBoundingClientRect().top;
        const delta = post - pre;
        if (delta) scrollerEl.scrollTop += delta;
      }
    }
  }

  async function appendNext() {
    if (loading) return;
    const total = spineCount();
    const nextIdx = (tailIdx >= 0 ? tailIdx + 1 : 0);
    if (nextIdx >= total) return;

    loading = true;
    await ensureSection(nextIdx);
    loading = false;
  }

  // 跳转：不清场；若未加载则顺序补到目标章；最后章首置顶
  async function jumpTo(idx) {
    const total = spineCount();
    if (!total) return;
    idx = Math.max(0, Math.min(idx, total - 1));

    // 若目标章在后面且还没加载：顺序补上去（维持 DOM 次序）
    if (tailIdx < idx) {
      for (let i = Math.max(0, tailIdx + 1); i <= idx; i++) {
        await ensureSection(i);
      }
    }
    // 若目标章在前面且还没加载（极少见）：从头补到目标章
    if (headIdx > idx) {
      for (let i = headIdx - 1; i >= idx; i--) {
        await ensureSection(i);
      }
    }

    const sec = contentEl.querySelector(`.chapter[data-idx="${idx}"]`) || await ensureSection(idx);
    scrollChapterToTop(sec);
    activeIdx = idx;
    markActive(idx);
    if (Number.isFinite(idx)) writeBookState({ activeIdx: idx });
  }

  function setupMidlineHighlighter({ container = contentEl, refRatio = MID_REF_RATIO } = {}) {
    function update() {
      if (progScrolling) return;  // 程序化滚动中，不抢章

      const rect = container.getBoundingClientRect();
      const midY = rect.top + rect.height * refRatio;
      const bandTop = rect.top + rect.height * (refRatio - HYSTERESIS);
      const bandBot = rect.top + rect.height * (refRatio + HYSTERESIS);
      const chapters = [...container.querySelectorAll('.chapter')];
      if (!chapters.length) return;

      // 1) 顶部的“短章”优先：贴近顶部的短章直接作为当前章
      for (const el of chapters) {
        const r = el.getBoundingClientRect();
        const isShort = r.height < rect.height * SHORT_RATIO;
        const nearTop = (r.top - rect.top) <= TOP_BAND_PX && r.bottom > rect.top;
        if (isShort && nearTop) {
          const idx = Number(el.dataset.idx);
          if (!Number.isNaN(idx) && idx !== activeIdx) {
            activeIdx = idx;
            markActive(idx);
          }
          return;
        }
      }

      // 2) 中线落点 + 黏滞带：只有完全穿过黏滞带时才切换，降低抖动
      for (const el of chapters) {
        const r = el.getBoundingClientRect();
        if (r.top <= midY && r.bottom >= midY) {
          const idx = Number(el.dataset.idx);
          if (!Number.isNaN(idx) && idx !== activeIdx) {
            if (r.top <= bandTop && r.bottom >= bandBot) { // 进入黏滞带才切换
              activeIdx = idx;
              markActive(idx);
            }
          }
          return;
        }
      }
    }

    const onScroll = () => requestAnimationFrame(update);
    container.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', update);
    // 首次计算
    requestAnimationFrame(update);
  }

  // 记忆最近书 & 会话当前书
  function rememberOpenedBook(manifestPath, manifest) {
    try {
      const rec = {
        path: manifestPath,
        sig: manifest?.sig || manifest?.hash || manifest?.pipelineVersion || '',
        title: manifest?.metadata?.title || '',
        openedAt: Date.now()
      };
      // 冷启动用：最近一本
      localStorage.setItem('reader::last', JSON.stringify(rec));
      // 供索引定位：最近一次的 manifestPath
      try {
        window.__lastManifestPath = manifestPath;
        localStorage.setItem('lastManifestPath', manifestPath);
      } catch { }

      // LRU：最近多本（可选）
      const key = (r) => `${r.path}#${r.sig || ''}`;
      const list = JSON.parse(localStorage.getItem('reader::recentV1') || '[]');
      const next = [rec, ...list.filter(x => key(x) !== key(rec))].slice(0, 12);
      localStorage.setItem('reader::recentV1', JSON.stringify(next));

      // 热启动用：当前会话
      sessionStorage.setItem('reader::current', manifestPath);
    } catch { }
  }

  // 按当前书状态应用抽屉
  function applyDrawerFromState() {
    const root = document.documentElement;

    const main = document.querySelector('.viewport > main');
    if (main) main.style.transition = 'none';   // 先关动画（只针对这一帧）
    const st = (typeof readBookState === 'function') ? (readBookState() || {}) : {};
    if (st.drawer === 'rail') root.classList.add('is-rail');
    else root.classList.remove('is-rail');

    if (main) {
      // 强制回流，确保这一帧不动画
      void main.offsetHeight;
      main.style.transition = '';               // 恢复由 CSS 控制
    }
  }

  // 启动时自动打开
  async function tryBoot(path) {
    if (!path) return false;
    try {
      // 先快速校验可读性（存在且 JSON 正常）
      await window.eapi.readJSON(path);
      await bootWithManifest(path);
      return true;
    } catch (e) {
      console.warn('[autoBoot] bad manifest, remove and fallback:', e);
      // 清理坏记录
      try {
        const last = JSON.parse(localStorage.getItem('reader::last') || 'null');
        if (last?.path === path) localStorage.removeItem('reader::last');
      } catch { }
      if (sessionStorage.getItem('reader::current') === path) {
        sessionStorage.removeItem('reader::current');
      }
      return false;
    }
  }

  async function autoBootOnStart() {
    // 1) 热启动：优先会话内记录
    const hot = sessionStorage.getItem('reader::current');
    if (await tryBoot(hot)) return true;

    // 2) 冷启动：最近一本
    let coldPath = null;
    try { coldPath = JSON.parse(localStorage.getItem('reader::last') || 'null')?.path || null; } catch { }
    if (await tryBoot(coldPath)) return true;

    // 3) 回退（可选：自动弹出对话框，或仅提示用户 Ctrl/Cmd+O）
    // await openViaDialog(); // 如果你想自动弹
    return false;
  }

  // 启动
  async function bootWithManifest(manifestPath) {
    try {
      restoring = true;                 // ← 切书一开始就拉闸（免得早期滚动落盘）

      setStatus('加载 manifest…', { sticky: true });
      const json = await window.eapi.readJSON(manifestPath);
      manifest = json;
      // 建立 out → 资源元数据 的快速索引
      __resByOut = new Map(
        Object.values(manifest?.resources || {})
          .map(r => [canonAssetPath(r.out), r])
      );

      bookDir = window.eapi.dirname(manifestPath);

      let sig = manifest?.sig || manifest?.hash || manifest?.pipelineVersion || '';
      window.bookKey = sig ? `epub:${sig}` : `epub:${manifestPath}`;  // ← 固定命名
      window.__bookKey = window.bookKey;
      console.log('[bookKey set]', window.bookKey);  // 自检：冷启动必须先打出这行

      // ☆ 立刻按本书状态应用抽屉（此时 bookKey 已就绪）
      applyDrawerFromState();

      if (window.fontZoom?.initForBook) window.fontZoom.initForBook({ silent: true });

      // if (overlayTitle) overlayTitle.textContent = manifest?.metadata?.title || '未命名';
      window.eapi.setTitle(`${manifest?.metadata?.title || '未命名'}`);
      console.log(`${manifest?.metadata?.title || '未命名'}`);

      buildTOC();

      rememberOpenedBook(manifestPath, manifest);

      const had = readBookState()?.toc?.scrollTop;
      if (!Number.isFinite(had)) revealActiveInTOC({ center: true });

      restoreTocScrollTop();   // ← 恢复目录滚动位置
    } catch (err) {
      console.error('[bootWithManifest] error:', err);
      setStatus('加载失败：路径不存在', { level: 'error' });
    }

    // —— 恢复阅读位置：先渲目标章，再加回相对偏移 —— //
    const st = readBookState() || {};

    const targetIdx = Number.isFinite(st.activeIdx) ? st.activeIdx : 0;

    // 先把目标章（及其相邻一章）挂上，目标章置顶
    await softClearJump(targetIdx, { down: 1 });

    // 再启动高亮器
    setupMidlineHighlighter({ container: contentEl, refRatio: MID_REF_RATIO });

    // 若有相对偏移（相对“目标章顶”），再加回去
    if (Number.isFinite(st.activeIdx)) {
      const idx = st.activeIdx;
      // 确保目标章已填充（防止等待中被移位）
      await ensureSection(idx);
      const sec = contentEl.querySelector(`.chapter[data-idx="${idx}"]`);
      if (sec && Number.isFinite(st.scrollTop) && st.scrollTop > 0) {
        const base = offsetTopWithin(sec, scrollerEl); // 章首在容器内的位置
        const rel = Math.max(0, st.scrollTop);       // 保存的是相对章首的偏移
        scrollerEl.scrollTop = base + rel;
        // 微调一帧，避免图片/字体回流造成的细小偏差
        requestAnimationFrame(() => {
          const want = offsetTopWithin(sec, scrollerEl) + rel;
          const d = want - scrollerEl.scrollTop;
          if (Math.abs(d) > 1) scrollerEl.scrollTop += d;
        });
      }
      // 同步高亮状态
      activeIdx = idx;
      markActive(idx);
    }
    // ——首跳 & 偏移都完成后，放闸——
    setTimeout(() => { restoring = false; }, 300); // 给图片/字体回流一点缓冲

    setStatus('加载完成', { ttl: 2000 });
  }
  window.bootWithManifest = bootWithManifest;

  /**
   * 统一入口：文件类型校验 + 旧书命中（sig） + 分派
   * @param {string} filePath 绝对路径（.epub 或 manifest.json）
   */
  async function openEntryUnified(filePath) {
    if (!filePath) return;
    const p = String(filePath);
    const lower = p.toLowerCase();
    try {
      // A) manifest.json：直接打开
      if (lower.endsWith('.epub')) {
        setStatus('计算 EPUB 签名…', { sticky: true });

        // 读取二进制 → 计算 hash
        const bytes = await window.eapi.readFileAsBytes(p);
        const { hash } = await window.parser.parseFile(new Blob([bytes]));
        const sig = `${hash}.${PIPELINE_VERSION}`;

        // 索引匹配
        let { matched, entry } = await window.sig.check(sig);
        if (matched && entry?.manifestPath && await window.eapi.exists(entry.manifestPath)) {
          setStatus('命中缓存，正在打开…', { sticky: true });
          await bootWithManifest(entry.manifestPath);
          clearStatus?.();
          return;
        }

        // 未命中：尝试解析并更新索引
        setStatus('未命中缓存，正在解析 EPUB…', { sticky: true });
        try {
          const res = await window.aot.parseEpub(new Blob([bytes]));
          if (res?.ok) {
            // 再次检查索引
            const chk = await window.sig.check(sig);
            if (chk.matched && chk.entry?.manifestPath &&
              await window.eapi.exists(chk.entry.manifestPath)) {
              await bootWithManifest(chk.entry.manifestPath);
              clearStatus?.();
              return;
            }
          } else {
            console.warn('解析失败:', res?.error);
          }
        } catch (err) {
          console.error('AOT 解析出错:', err);
        }

        // 最终仍未找到：提示解析完成但无匹配
        setStatus(`解析完成，但未能匹配 manifest（sig=${sig}）`, { level: 'error', sticky: true });
        return;
      }

      // 其它类型
      setStatus('请选择 .epub 或 manifest.json');
    } catch (err) {
      console.error('[openEntryUnified] failed:', err);
      setStatus('打开失败：' + (err?.message || err), { level: 'error', sticky: true });
    }
  }
  // 可选：暴露到 window 以便调试
  // window.openEntryUnified = openEntryUnified;


  // renderer — 允许选择 .epub 或 manifest.json；
  // 选 .epub：计算 sig → 若命中缓存则直接 boot；未命中只输出 sig
  // 选 .json：直接 bootWithManifest
  window.openViaDialog = async function openViaDialog() {
    if (!window.eapi) { setStatus('缺少 eapi（preload 未注入）'); return; }

    try {
      setStatus('选择文件…');
      const picked = await window.eapi.pickBookOrManifest();
      // 1) 更通用的选择器：允许 epub / manifest / 目录
      let p = null;
      if (window.eapi.pickBookOrManifest) {
        p = (typeof picked === 'string') ? picked : (picked?.path || picked?.filePath || '');
        // 如果用户选的是“目录”，尝试补 /manifest.json
        if (p && !p.toLowerCase().endsWith('.epub') && !p.toLowerCase().endsWith('.json')) {
          const mp = window.eapi.join(p, 'manifest.json');
          if (await window.eapi.exists(mp)) p = mp;
        }
      } else {
        // 兼容旧桥：只允许选 manifest.json
        p = await window.eapi.pickManifestViaDialog();
      }

      if (!p) { setStatus('未选择文件'); return; }

      // 统一入口：类型校验 + 旧书命中 + 分派
      await openEntryUnified(p);
    } catch (err) {
      console.error(err);
      setStatus('加载失败：' + (err?.message || err));
    }
  };

  // 滚动：接近底部则补 1 章（无清理，无向上补）
  // contentEl.addEventListener('scroll', () => {
  //   const remaining = contentEl.scrollHeight - contentEl.clientHeight - contentEl.scrollTop;
  //   if (remaining < NEAR_BOTTOM_PX) appendNext();
  // }, { passive: true });
  scrollerEl.addEventListener('scroll', () => {
    const remaining = scrollerEl.scrollHeight - scrollerEl.clientHeight - scrollerEl.scrollTop;
    if (remaining < NEAR_BOTTOM_PX) appendNext();

    if (progScrolling || restoring) return;  // ← 新增：恢复期也不保存

    if (scrollSaveTimer) clearTimeout(scrollSaveTimer);
    scrollSaveTimer = setTimeout(() => {
      // 选一个“当前章”：优先 .active，其次视口顶部最靠近的章节
      // let idx = Number.isFinite(activeIdx) ? activeIdx : 0;
      let idx = (Number.isFinite(activeIdx) && activeIdx >= 0) ? activeIdx : 0;

      const topEl = contentEl.querySelector('.chap.active') || topVisibleChapter();
      if (topEl) idx = Number(topEl.dataset.idx) || idx;

      const sec = contentEl.querySelector(`.chapter[data-idx="${idx}"]`);
      const base = sec ? offsetTopWithin(sec, scrollerEl) : 0;  // 当前章顶在容器内的位置
      const rel = Math.max(0, Math.round(scrollerEl.scrollTop - base));  // 相对偏移

      writeBookState({ activeIdx: idx, scrollTop: rel });
    }, 600); // 节流 600ms
  }, { passive: true });

  // “打开文件”按钮
  window.addEventListener('DOMContentLoaded', () => {
    document.documentElement.classList.add('ready');
    setupMidlineHighlighter({ container: scrollerEl, refRatio: MID_REF_RATIO });
    document.addEventListener('keydown', (e) => {
      const isOpen = (e.key === 'o' || e.key === 'O');
      if (isOpen && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        openViaDialog();
      }
      const tocEl = document.getElementById('toc');
      if (tocEl && !tocEl.__tocBound) {
        tocEl.__tocBound = true; // 防重复绑定
        tocEl.addEventListener('scroll', () => {
          if (__tocSaveRaf) cancelAnimationFrame(__tocSaveRaf);
          __tocSaveRaf = requestAnimationFrame(() => {
            __tocSaveRaf = 0;
            saveTocScrollTop();   // ← 落盘当前 toc.scrollTop
          });
        }, { passive: true });
      }
    });

    // const root = document.documentElement;
    // const status = document.getElementById("overlay-status");
    // const KEY = 'reader:drawer-state';
    // const last = localStorage.getItem(KEY);
    // if (last === 'rail') root.classList.add('is-rail');

    // const toggleBtn = document.querySelector('.toc-toggle');
    // if (toggleBtn) {
    //   toggleBtn.addEventListener('click', () => {
    //     root.classList.toggle('is-rail');
    //     if (status) status.remove();
    //     localStorage.setItem(KEY, root.classList.contains('is-rail') ? 'rail' : 'open');
    //     window.dispatchEvent(new Event('resize')); // 通知布局重算
    //   });
    // }

    const root = document.documentElement;
    const status = document.getElementById("overlay-status");

    // —— 优先读集中状态；兼容迁移旧 KEY：'reader:drawer-state' —— 
    (function initDrawerByBook() {
      const st = readBookState();
      let mode = st.drawer; // 'open' | 'rail' | undefined

      // 旧键迁移（一次性）
      // const LEGACY_KEY = 'reader:drawer-state';
      // try {
      //   const legacy = localStorage.getItem(LEGACY_KEY);
      //   if (!mode && (legacy === 'rail' || legacy === 'open')) {
      //     mode = legacy;
      //     writeBookState({ drawer: mode });
      //   }
      // } catch { }

      // if (mode === 'rail') root.classList.add('is-rail');
      // else root.classList.remove('is-rail');
    })();

    const toggleBtn = document.querySelector('.toc-toggle');
    if (toggleBtn) {
      toggleBtn.addEventListener('click', () => {
        root.classList.toggle('is-rail');
        if (status) status.remove();
        writeBookState({ drawer: root.classList.contains('is-rail') ? 'rail' : 'open' });

        // ★ 新增：目录从“收起”→“展开”且存在标记时，对齐一次
        const nowCollapsed = root.classList.contains('is-rail');
        if (!nowCollapsed && __tocNeedsAlign) {
          revealActiveInTOC({ center: false }); // 用 nearest，最小位移
          __tocNeedsAlign = false;
        }

        window.dispatchEvent(new Event('resize')); // 通知布局重算
      });
    }
    autoBootOnStart();
    console.log('autoBootOnStart');

  });
})();
