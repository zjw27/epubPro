// parser.worker.js — Node worker 线程：只和主进程通信，不碰 UI
const { parentPort } = require('node:worker_threads');
const path = require('node:path');
const fs = require('node:fs');
// 启动探针（看清 worker 目录和是否能看到 parser.cjs）
try {
    parentPort.postMessage({ type: 'boot', dir: __dirname, files: fs.readdirSync(__dirname) });
} catch { }

let parser;
try {
    parser = require(path.join(__dirname, 'parser.cjs'));
} catch (e) {
    parentPort.postMessage({ type: 'error', message: 'require parser.cjs failed: ' + (e && e.message) });
    return; // 让主进程收到 error 后结束，不要裸崩
}

process.on('unhandledRejection', (r) => parentPort.postMessage({ type: 'error', message: String(r) }));
process.on('uncaughtException', (e) => parentPort.postMessage({ type: 'error', message: String(e?.message || e) }));

parentPort.on('message', async (msg) => {
    try {
        const { task = 'parse', buffer, opts = {} } = msg || {};
        // 来的是 ArrayBuffer（transferable），重建 Buffer
        const buf = (buffer?.byteLength != null) ? Buffer.from(buffer) : Buffer.alloc(0);
        parentPort.postMessage({ type: 'progress', phase: 'recv', pct: 0, byteLength: buf.length });
        if (buf.length === 0) {
            parentPort.postMessage({ type: 'error', message: 'empty buffer' });
            return;
        }
        if (task === 'hash') {
            const hash = await parser.hashBytes(buf);
            parentPort.postMessage({ type: 'done', result: { hash } });
            return;
        }

        // task === 'parse'（默认）
        parentPort.postMessage({ type: 'progress', phase: 'hash', pct: 10 });
        const { hash } = await parser.parseEpub(buf, opts);
        parentPort.postMessage({ type: 'progress', phase: 'parse', pct: 80 });
        // …（你将来在 parseEpub 里细化各阶段并上报进度）

        parentPort.postMessage({ type: 'done', result: { hash } });
    } catch (err) {
        parentPort.postMessage({ type: 'error', message: String(err?.message || err) });
    }
});
