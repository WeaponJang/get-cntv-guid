// ==UserScript==
// @name:en-US        CCTV-ENC2-HLS
// @name              CCTV视频解析-ENC2
// @description:en-US resolve cctv enc2 (udrm) m3u8 url, probe manifest, stream-merge segments
// @description       解析 CCTV 接口返回的 enc2（UDRM 加密）m3u8：清单与分片只走 http，按切片序号流式合并下载密文
// @namespace         https://greasyfork.org/users/135090
// @version           0.0.1
// @author            [ZWB](https://greasyfork.org/zh-CN/users/863179) + enc2
// @license           CC
// @grant             GM_xmlhttpRequest
// @connect           *
// @run-at            document-end
// @match             *://live.ipanda.com/*/*/*/V*.shtml*
// @match             *://*.cctv.com/*/*/*/V*.shtml*
// @match             *://*.cctv.com/*/*/*/A*.shtml*
// @match             *://*.cctv.cn/*/*/*/V*.shtml*
// @match             *://*.cctv.cn/*/*/*/A*.shtml*
// @match             *://*.cntv.cn/program/*/*/*.shtml*
// @match             *://vdn.apps.cntv.cn/api/getHttpVideoInfo*
// @icon              https://tv.cctv.cn/favicon.ico
// ==/UserScript==

'use strict';

/* 加了 GM_ 授权后脚本跑在沙箱里，页面自己挂上去的全局变量（flashPlayerList 等）
   要从 unsafeWindow 上取，否则播放页分支会一个都读不到。 */
const W = (typeof unsafeWindow !== 'undefined' && unsafeWindow) || window;

/* 流式写盘只做 Chromium 系（File System Access）：真实火狐不支持 */
const IS_FIREFOX = /firefox/i.test(navigator.userAgent) ||
    (/gecko/i.test(navigator.userAgent) && !/chrome/i.test(navigator.userAgent));

/* -------------------- 工具：简易通知 -------------------- */
function showNotice(msg, type = 'error') {
    const el = document.createElement('div');
    el.textContent = msg;
    el.style.cssText = `
    position:fixed; z-index:99999; right:20px; bottom:20px;
    max-width:420px; padding:12px 14px; font-size:14px; line-height:1.6;
    color:#fff; background:${type === 'error' ? '#d93025' : '#188038'};
    border-radius:8px; box-shadow:0 4px 16px rgba(0,0,0,.3);`;
    document.body.appendChild(el);
    if (type !== 'error') setTimeout(() => el.remove(), 5000);
    return el;
}

/* -------------------- 工具：结果卡片 -------------------- */
function buildCard({ title = 'CCTV ENC2 解析', status = 'ok' } = {}) {
    const card = document.createElement('div');
    card.id = 'cctv-enc2-card';
    card.style.cssText = `
    position:fixed; z-index:99998; right:24px; bottom:24px;
    width:560px; max-width:calc(100vw - 48px);
    font-family:system-ui,-apple-system,"Segoe UI",sans-serif;
    background:#fff; color:#202124; border-radius:12px; overflow:hidden;
    box-shadow:0 8px 32px rgba(0,0,0,.25); font-size:14px; line-height:1.6;`;
    const accent = status === 'error' ? '#d93025' : '#1a73e8';
    const head = document.createElement('div');
    head.style.cssText = `
    display:flex; align-items:center; justify-content:space-between;
    padding:12px 16px; background:${accent}; color:#fff; font-weight:600;`;
    const headTitle = document.createElement('span');
    headTitle.textContent = title;
    // 最小化：只收起卡片主体，标题栏留在原地可再展开
    const minBtn = document.createElement('span');
    minBtn.textContent = '—';
    minBtn.title = '最小化 / 展开';
    minBtn.style.cssText = 'cursor:pointer; font-size:18px; line-height:1; padding:0 6px;';
    let minimized = false;
    const body = document.createElement('div');
    minBtn.onclick = () => {
        minimized = !minimized;
        body.style.display = minimized ? 'none' : '';
        minBtn.textContent = minimized ? '▢' : '—';
        card.style.width = minimized ? 'auto' : '';
    };
    head.append(headTitle, minBtn);
    body.className = 'cctv-enc2-body';
    body.style.cssText = 'padding:14px 16px; word-break:break-all; max-height:60vh; overflow:auto;';
    card.append(head, body);
    (document.body || document.documentElement).appendChild(card);
    return { card, body };
}

function cardRow(body, label, value, href) {
    const row = document.createElement('div');
    row.style.cssText = 'margin:8px 0;';
    const lab = document.createElement('div');
    lab.textContent = label;
    lab.style.cssText = 'color:#5f6368; font-size:12px; margin-bottom:2px;';
    const val = document.createElement(href ? 'a' : 'div');
    val.textContent = value;
    if (href) {
        val.href = href;
        val.target = '_blank';
        val.style.cssText = 'color:#1a73e8; text-decoration:none;';
    } else {
        val.style.color = '#202124';
    }
    row.append(lab, val);
    body.appendChild(row);
    return val;
}

function cardSection(body, text) {
    const sec = document.createElement('div');
    sec.style.cssText = 'margin:14px 0 6px; padding-top:10px; border-top:1px solid #e0e0e0; font-weight:600;';
    sec.textContent = text;
    body.appendChild(sec);
    return sec;
}

function cardLine(body, text, color) {
    const line = document.createElement('div');
    line.textContent = text;
    line.style.cssText = 'margin:4px 0; font-size:12px; color:' + (color || '#5f6368') + ';';
    body.appendChild(line);
    return line;
}

function cardBar(body) {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'height:6px; border-radius:3px; background:#e8eaed; overflow:hidden; margin:6px 0;';
    const fill = document.createElement('i');
    fill.style.cssText = 'display:block; height:100%; width:0; background:#1a73e8; transition:width .2s;';
    wrap.appendChild(fill);
    body.appendChild(wrap);
    return {
        wrap, fill, set(done, total) {
            const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
            fill.style.width = pct + '%';
        }
    };
}

function mkBtn(label, bg, onclick) {
    const btn = document.createElement('button');
    btn.textContent = label;
    btn.style.cssText = 'margin:4px 8px 4px 0; padding:6px 14px; border:none; border-radius:6px;' +
        'background:' + bg + '; color:#fff; font-size:13px; cursor:pointer;';
    btn.onclick = onclick;
    return btn;
}

function copyText(text, btn, label) {
    const done = () => {
        btn.textContent = '✓ 已复制';
        setTimeout(() => { btn.textContent = label; }, 1500);
    };
    const fallback = () => {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed; opacity:0;';
        document.body.appendChild(ta);
        ta.select();
        let ok = false;
        try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
        ta.remove();
        if (ok) done(); else showNotice('复制失败，请手动复制');
    };
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done, fallback);
    else fallback();
}

/* 清单原文用 data URI 在新窗口打开（同项目既有的展示习惯） */
function openTextWindow(text) {
    if (!text) { showNotice('还没有取到清单内容'); return; }
    if (text.length > 300000) { showNotice('清单过大，已跳过新窗口展示'); return; }
    const bytes = new TextEncoder().encode(text);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    window.open('data:text/plain;charset=utf-8;base64,' + btoa(bin), '_blank');
}

/* -------------------- 小工具 -------------------- */
const fmtBytes = (n) => {
    if (!n) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
    return (n / Math.pow(1024, i)).toFixed(i ? 2 : 0) + ' ' + units[i];
};

// 文件名非法字符（含会被隐式转半角的全角字符）统一换成下划线
const safeName = (s) => String(s).replace(/[\/\\:*?"'<>|\s　＂＇]/g, '_').slice(0, 80) || 'video';

/* -------------------- 网络层：GM 优先 -------------------- */
/* enc2 的清单/分片只提供 http，本脚本又跑在 https 的接口页上，
   直接用 fetch 会被浏览器按混合内容拦掉，所以一律先用 GM_xmlhttpRequest。 */
const Net = (() => {
    const hasGM = typeof GM_xmlhttpRequest === 'function';

    // 各脚本管理器对 arraybuffer 的实现不一：ArrayBuffer / Blob / TypedArray 都要归一
    async function toArrayBuffer(v) {
        if (v instanceof ArrayBuffer) return v;
        if (v && typeof v.arrayBuffer === 'function') return v.arrayBuffer();
        if (v && v.buffer) return v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength);
        return new TextEncoder().encode(String(v)).buffer;
    }

    function gm(url, responseType, signal) {
        return new Promise((resolve, reject) => {
            const handle = GM_xmlhttpRequest({
                method: 'GET',
                url,
                timeout: 120000,
                responseType,
                signal,
                onload: (r) => {
                    if (r.status < 200 || r.status >= 400) {
                        reject(new Error('HTTP ' + r.status + ' ← ' + url));
                        return;
                    }
                    const v = (r.response !== undefined && r.response !== null) ? r.response : r.responseText;
                    resolve(v === undefined || v === null ? '' : v);
                },
                onerror: () => reject(new Error('请求失败（DNS/CDN 拒绝）：' + url)),
                ontimeout: () => reject(new Error('请求超时：' + url))
            });
            // 老版本 GM_xmlhttpRequest 不认 signal，靠 handle.abort() 取消
            if (handle && typeof handle.abort === 'function' && signal) {
                if (signal.aborted) handle.abort();
                else signal.addEventListener('abort', () => { try { handle.abort(); } catch (e) { } });
            }
        });
    }

    async function fetchReq(url, responseType, signal) {
        const r = await fetch(url, { signal });
        if (!r.ok) throw new Error('HTTP ' + r.status + ' ← ' + url);
        return responseType === 'text' ? r.text() : r.arrayBuffer();
    }

    async function get(url, responseType, signal) {
        if (hasGM) {
            try {
                return await gm(url, responseType, signal);
            } catch (e) {
                if ((signal && signal.aborted) || /^HTTP \d+/.test(e.message)) throw e;
                console.warn('[CCTV ENC2] GM 请求失败，改用 fetch 兜底:', url, e.message);
            }
        }
        return fetchReq(url, responseType, signal);
    }

    async function getText(url, signal) {
        const v = await get(url, 'text', signal);
        if (typeof v === 'string') return v;
        return new TextDecoder().decode(await toArrayBuffer(v));
    }

    // 单片最多试 3 次：CDN 偶发 5xx/断连；4xx 重试没意义，直接抛
    async function getSeg(url, signal) {
        let lastErr;
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                return await toArrayBuffer(await get(url, 'arraybuffer', signal));
            } catch (e) {
                if ((signal && signal.aborted) || /^HTTP 4\d\d/.test(e.message)) throw e;
                lastErr = e;
            }
        }
        throw lastErr;
    }

    return { hasGM, get, getText, getSeg };
})();

/* -------------------- HLS 清单解析 -------------------- */
const absUrl = (uri, base) => {
    try { return new URL(uri, base).toString(); } catch (e) { return uri; }
};

// EXT-X-* 的 KEY="value",... 解析，值里可能带逗号（引号内）
function splitAttrs(s) {
    const out = {};
    const re = /([A-Za-z0-9-]+)=("[^"]*"|[^,]*)/g;
    let m;
    while ((m = re.exec(s))) {
        out[m[1].toUpperCase()] = m[2].replace(/^"|"$/g, '');
    }
    return out;
}

/* 原脚本只按 tsindex 猜切片，这里补上真解析：
   enc2 的清单能拿到 EXT-X-MAP(fMP4 init) / EXT-X-KEY / 精确分片表。 */
function parseManifest(text, baseUrl) {
    const out = {
        isMaster: false, variants: [], segments: [], map: null,
        keys: [], targetDuration: 0, endList: false
    };
    let dur = 0;
    let pendingVariant = null;
    for (const raw of String(text).split(/\r?\n/)) {
        const line = raw.trim();
        if (!line) continue;
        if (line.startsWith('#EXT-X-STREAM-INF:')) {
            out.isMaster = true;
            pendingVariant = splitAttrs(line.slice(18));
            continue;
        }
        if (line.startsWith('#EXT-X-KEY:')) {
            out.keys.push(splitAttrs(line.slice(11)));
            continue;
        }
        if (line.startsWith('#EXT-X-MAP:')) {
            const a = splitAttrs(line.slice(11));
            if (a.URI) out.map = absUrl(a.URI, baseUrl);
            continue;
        }
        if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) continue;
        if (line.startsWith('#EXT-X-TARGETDURATION:')) {
            out.targetDuration = Number(line.split(':')[1]) || 0;
            continue;
        }
        if (line.startsWith('#EXT-X-ENDLIST')) { out.endList = true; continue; }
        if (line.startsWith('#EXTINF:')) { dur = parseFloat(line.slice(8)) || 0; continue; }
        if (line.startsWith('#')) continue;

        const url = absUrl(line, baseUrl);
        if (pendingVariant) {
            out.variants.push({
                url,
                bandwidth: Number(pendingVariant.BANDWIDTH || 0),
                resolution: pendingVariant.RESOLUTION || '',
                name: pendingVariant.NAME || ''
            });
            pendingVariant = null;
        } else {
            out.segments.push({ url, duration: dur });
            dur = 0;
        }
    }
    return out;
}

// 清单文件名改写成 tsindex 模板：解析失败时按总时长推算切片数兜底
function buildTemplate(m3u8Url) {
    const u = new URL(m3u8Url);
    u.search = '';
    const parts = u.pathname.split('/');
    parts[parts.length - 1] = 'tsindex.ts';
    u.pathname = parts.join('/');
    return u.toString();
}

/* -------------------- 流式写盘 -------------------- */
const canSave = typeof W.showSaveFilePicker === 'function' && !IS_FIREFOX;

async function openSink(outName, ext) {
    const fh = await W.showSaveFilePicker({
        suggestedName: outName,
        types: [{
            description: ext === '.mp4' ? 'MP4' : 'MPEG-TS',
            accept: { [ext === '.mp4' ? 'video/mp4' : 'video/mp2t']: [ext] }
        }]
    });
    const w = await fh.createWritable();
    return {
        write: (buf) => w.write(buf),
        close: () => w.close(),
        abort: async () => { try { await w.abort(); } catch (e) { } }
    };
}

/* urls 已是最终顺序（含 EXT-X-MAP 时的 init 段在最前）：
   抓取可以并发，落盘严格按序号顺序（见下面连续写窗口）。 */
async function streamMerge(urls, opts) {
    const { signal, sink, onProgress } = opts;
    const total = urls.length;
    const slots = new Array(total);
    let nextFetch = 0;
    let nextWrite = 0;
    let bytes = 0;
    let failure = null;
    const stopped = () => (signal && signal.aborted) || !!failure;

    async function worker() {
        while (!stopped()) {
            const i = nextFetch++;
            if (i >= total) return;
            try {
                slots[i] = await Net.getSeg(urls[i], signal);
            } catch (e) {
                e.message = '第 ' + i + ' 段获取失败：' + e.message;
                if (!failure) failure = e;
                return;
            }
            // 只写「从下一格开始连续就绪」的部分，所以后完成的段不一定是先写的
            while (nextWrite < total && slots[nextWrite] && !stopped()) {
                const chunk = slots[nextWrite];
                slots[nextWrite] = null;
                await sink.write(chunk);
                bytes += chunk.byteLength;
                onProgress && onProgress(++nextWrite, bytes);
            }
        }
    }

    await Promise.all(Array.from({ length: Math.min(4, total) }, worker));

    // 取消/出错时把已经就绪的连续段也刷完，尽量留下可播的前半段
    while (stopped() && nextWrite < total && slots[nextWrite]) {
        const chunk = slots[nextWrite];
        slots[nextWrite] = null;
        await sink.write(chunk);
        bytes += chunk.byteLength;
        nextWrite++;
    }

    const cancelled = !!(signal && signal.aborted);
    if (cancelled || failure || nextWrite !== total) {
        await sink.abort();
        if (failure && !cancelled) {
            failure.written = nextWrite;
            throw failure;
        }
        const err = new Error(cancelled
            ? '已取消，已写入 ' + nextWrite + '/' + total + ' 段'
            : '写入 ' + nextWrite + '/' + total + ' 段，与预期对不上');
        if (cancelled) err.cancelled = true;
        throw err;
    }
    await sink.close();
    return { count: nextWrite, bytes };
}

/* -------------------- 接口页：取 enc2 地址 -------------------- */
const API_BASE = 'https://vdn.apps.cntv.cn/api/getHttpVideoInfo.do';
const BITRATES = [450, 850, 1200, 2000, 4000, 3000];
const BR_LABELS = ['流畅', '标清', '高清', '全高清', '超清 4K', '超清'];
// validChapterNum(1..5) -> 码率下标：版权受限(403)时的降级档位
const FALLBACK_INDEX = new Map([[1, 0], [2, 1], [3, 1], [4, 3], [5, 3]]);
// enc2 只给 http；换 CDN 域名时可以在这里加候选（探测失败时提供一键重试）
const CDN_FALLBACK_HOST = 'drm.cntv.vod.dnsv1.com';

function forceHttp(raw) {
    try {
        const u = new URL(raw);
        u.protocol = 'http:';
        return u.toString();
    } catch (e) {
        return String(raw);
    }
}

function swapHost(url, host) {
    try {
        const u = new URL(url);
        u.hostname = host;
        return u.toString();
    } catch (e) {
        return url;
    }
}

async function apiPage() {
    let data;
    try {
        const prebody = document?.body?.querySelector('pre')?.textContent || document?.body?.textContent || '';
        if (!prebody.trim()) throw new Error('接口返回体为空');
        data = JSON.parse(prebody);
    } catch (e) {
        const { body } = buildCard({ status: 'error', title: 'CCTV ENC2 解析 - 失败' });
        cardRow(body, '错误信息', '接口返回不是合法 JSON（可能被限流/返回了 HTML）：' + e.message);
        return;
    }

    const rawEnc2 = data?.manifest?.hls_enc2_url;
    const rawH5e = data?.manifest?.hls_h5e_url;
    const title = String(data?.title || 'video').replaceAll(' ', '');
    const channel = String(data?.play_channel || '');
    const guid = String(data?.guid || '');
    const totalLengthSec = Number(data?.video?.totalLength || 0);
    const brtnum = Number(data?.video?.validChapterNum || 0);

    if (!rawEnc2 && !rawH5e) {
        const { body } = buildCard({ status: 'error', title: 'CCTV ENC2 解析 - 失败' });
        cardRow(body, '错误信息', '接口既没有 hls_enc2_url 也没有 hls_h5e_url，无法继续。');
        return;
    }

    const baseUrl = forceHttp(rawEnc2 || rawH5e);
    // 地址里没有 main 时改写码率无效，下面的码率按钮就当"同一地址"处理
    const hasMainSeg = baseUrl.includes('main');
    const candAt = (i) => (hasMainSeg ? baseUrl.replaceAll('main', String(BITRATES[i])) : baseUrl);

    let bi = FALLBACK_INDEX.has(brtnum) ? FALLBACK_INDEX.get(brtnum) : 1;
    if (channel.indexOf('CCTV-4K') === 0) bi = 4;
    else if (channel.indexOf('CCTV-16') === 0) bi = 5;

    let currentUrl = candAt(bi);
    let currentManifest = null;   // parseManifest 结果
    let currentText = '';         // 清单原文（供新窗口查看）

    const { body } = buildCard({ title: 'CCTV 视频解析 - ENC2' });
    const official = guid ? 'https://app.cctv.com/special/m/livevod/index.html?guid=' + guid + '&vtype=2' : '';
    if (official) cardRow(body, '标题', title, official);
    else cardRow(body, '标题', title);
    cardRow(body, '频道', channel || '(无)');
    cardRow(body, 'GUID', guid || '(data.guid 未给出)');

    if (!rawEnc2) {
        cardLine(body, '接口未返回 hls_enc2_url，已回退到 hls_h5e_url', '#e6a23c');
    }

    /* ---- 地址区 ---- */
    const addrTitle = document.createElement('div');
    addrTitle.textContent = 'ENC2 清单地址（http，GM 请求）：';
    addrTitle.style.cssText = 'margin:14px 0 6px; font-weight:600;';
    body.appendChild(addrTitle);

    const addrVal = cardRow(body, '', currentUrl, currentUrl);

    const addrBtns = document.createElement('div');
    addrBtns.style.cssText = 'margin:6px 0 4px;';
    let btnCopy;
    btnCopy = mkBtn('复制当前地址', '#1a73e8', () => copyText(currentUrl, btnCopy, '复制当前地址'));
    const btnOpen = mkBtn('在新标签页打开', '#5f6368', () => window.open(currentUrl, '_blank'));
    const btnView = mkBtn('查看清单原文', '#7c4dff', () => openTextWindow(currentText));
    addrBtns.append(btnCopy, btnOpen, btnView);
    body.appendChild(addrBtns);

    /* ---- 码率切换 ---- */
    if (hasMainSeg) {
        const brBar = document.createElement('div');
        brBar.style.cssText = 'margin:6px 0 2px; display:flex; flex-wrap:wrap; gap:6px;';
        body.appendChild(brBar);
        BITRATES.forEach((br, i) => {
            const b = document.createElement('button');
            b.textContent = br + 'k';
            b.title = BR_LABELS[i];
            b.style.cssText = 'padding:5px 10px; border:1px solid #dadce0; border-radius:6px;' +
                'background:#fff; color:#202124; font-size:12px; cursor:pointer;';
            b.onclick = () => {
                if (probing) return; // 上一次探测没结束就先不动，避免地址和清单对不上
                bi = i;
                setCurrentUrl(candAt(i));
                probe();
            };
            brBar.appendChild(b);
        });
    }

    /* ---- 当前地址的同步点：链接、复制、探测 ---- */
    function setCurrentUrl(url) {
        currentUrl = url;
        addrVal.textContent = url;
        addrVal.href = url;
        currentManifest = null;
        currentText = '';
    }

    /* ---- 探测区 ---- */
    cardSection(body, '清单探测');
    const statusLine = cardLine(body, '等待探测…');
    const infoLine = cardLine(body, '');
    // KEY / MAP 单独一个容器：既排在探测信息下面，又不会和码率分支抢位置
    const keyBox = document.createElement('div');
    keyBox.style.cssText = 'margin:4px 0;';
    body.appendChild(keyBox);
    const variantBox = document.createElement('div');
    variantBox.style.cssText = 'margin:6px 0;';
    body.appendChild(variantBox);
    const cdnBtnBar = document.createElement('div');
    cdnBtnBar.style.cssText = 'margin:6px 0; display:none;';
    body.appendChild(cdnBtnBar);

    const setStatus = (msg, color) => { statusLine.textContent = msg; statusLine.style.color = color || '#5f6368'; };

    function renderManifest(info) {
        const parts = [];
        if (info.isMaster) parts.push('master 清单 · ' + info.variants.length + ' 个码率分支');
        else {
            parts.push('media 清单 · ' + info.segments.length + ' 段');
            if (info.targetDuration) parts.push('单片 ≤' + info.targetDuration + 's');
            if (!info.endList) parts.push('未 ENDLIST（直播/未收尾）');
        }
        if (info.map) parts.push('EXT-X-MAP（fMP4 init）');
        const keyMethods = info.keys
            .map((k) => (k.METHOD || 'NONE').toUpperCase())
            .filter((m) => m && m !== 'NONE');
        parts.push(keyMethods.length ? 'EXT-X-KEY ' + keyMethods.join('/') : '无 EXT-X-KEY');
        infoLine.textContent = parts.join(' · ');
        infoLine.style.color = '#5f6368';

        // KEY 的 URI / IV / KID 逐个列出，方便对着解密工具填参
        keyBox.replaceChildren();
        info.keys.forEach((k) => {
            if ((k.METHOD || 'NONE').toUpperCase() === 'NONE') return;
            const desc = [k.METHOD, k.URI ? 'URI=' + k.URI : '', k.IV ? 'IV=' + k.IV : '', k.KEYFORMAT || '']
                .filter(Boolean).join(' · ');
            cardLine(keyBox, 'KEY：' + desc, '#e6a23c');
        });
        if (info.map) cardLine(keyBox, 'MAP：' + info.map, '#5f6368');
    }

    function renderVariants(info, activeUrl) {
        // 非 master 时不清空：master 被自动递归探测后，分支列表还要留着给用户切
        if (!info.isMaster || !info.variants.length) return;
        variantBox.replaceChildren();
        const sorted = info.variants.slice().sort((a, b) => b.bandwidth - a.bandwidth);
        const head = document.createElement('div');
        head.textContent = '码率分支（已探测最高档）：';
        head.style.cssText = 'font-size:12px; color:#5f6368; margin:4px 0;';
        variantBox.appendChild(head);
        sorted.forEach((v) => {
            const row = document.createElement('div');
            row.style.cssText = 'margin:4px 0; font-size:12px; display:flex; gap:8px; align-items:center; flex-wrap:wrap;';
            const label = document.createElement('span');
            label.textContent = (v.bandwidth ? Math.round(v.bandwidth / 1000) + 'kbps ' : '') +
                (v.resolution || v.name || '') + (v.url === activeUrl ? ' ← 当前' : '');
            label.style.cssText = 'color:#202124;';
            const useBtn = mkBtn('探测此分支', '#1a73e8', () => {
                setCurrentUrl(v.url);
                probe(v.url);
            });
            useBtn.style.cssText = useBtn.style.cssText.replace('margin:4px 8px 4px 0;', '');
            const cp = mkBtn('复制', '#5f6368', () => copyText(v.url, cp, '复制'));
            cp.style.cssText = cp.style.cssText.replace('margin:4px 8px 4px 0;', '');
            row.append(label, useBtn, cp);
            variantBox.appendChild(row);
        });
    }

    function renderCdnFallback(url) {
        cdnBtnBar.replaceChildren();
        if (url.indexOf(CDN_FALLBACK_HOST) > -1) return; // 已经是备用域名，不再给兜底入口
        const b = mkBtn('换 CDN 域名重试（' + CDN_FALLBACK_HOST + '）', '#e6a23c', () => {
            const alt = swapHost(url, CDN_FALLBACK_HOST);
            setCurrentUrl(alt);
            probe(alt);
        });
        cdnBtnBar.appendChild(b);
        cdnBtnBar.style.display = '';
    }

    let probing = false;
    async function probe(url = currentUrl) {
        if (probing) return;
        probing = true;
        setStatus('正在通过 GM 请求拉取清单…');
        infoLine.textContent = '';
        keyBox.replaceChildren();
        cdnBtnBar.style.display = 'none';
        try {
            const text = await Net.getText(url);
            currentText = text;
            const info = parseManifest(text, url);
            currentManifest = info;
            if (!info.segments.length && !info.variants.length) {
                throw new Error('清单里既没有分片也没有码率分支（可能是错误页/占位清单）');
            }
            setStatus('探测成功 · ' + text.length + ' 字节', '#188038');
            renderManifest(info);
            renderVariants(info, url);
            // master 清单先自动跳到最高档，用户不用手动点
            if (info.isMaster && info.variants.length) {
                const best = info.variants.slice().sort((a, b) => b.bandwidth - a.bandwidth)[0];
                probing = false;
                await probe(best.url);
                return;
            }
        } catch (e) {
            setStatus('探测失败：' + e.message, '#d93025');
            infoLine.textContent = '清单拉不到就无法解析分片，下载会退回 tsindex 模板推算（依赖接口给的总时长）。';
            keyBox.replaceChildren();
            variantBox.replaceChildren();
            renderCdnFallback(url);
            console.error('[CCTV ENC2 探测]', e);
        } finally {
            probing = false;
        }
    }

    /* ---- 下载区 ---- */
    cardSection(body, '下载（密文，未解密）');
    const dlInfo = cardLine(body, '');
    const dlBar = cardBar(body);
    dlBar.wrap.style.display = 'none';
    const dlBtns = document.createElement('div');
    dlBtns.style.cssText = 'margin:6px 0 2px; display:flex; flex-wrap:wrap; gap:6px;';
    body.appendChild(dlBtns);

    const btnDl = mkBtn('流式下载合并', '#188038', onDownload);
    dlBtns.appendChild(btnDl);
    if (!canSave) {
        btnDl.disabled = true;
        btnDl.style.opacity = '.5';
        dlInfo.textContent = '当前浏览器不支持流式写盘（需 Chrome/Edge 等 Chromium 系）';
        dlInfo.style.color = '#d93025';
    } else {
        dlInfo.textContent = '按清单分片顺序合并；清单拉取失败时退回 tsindex 模板（总时长 ÷10 秒/片）';
    }

    function collectUrls(info) {
        if (!info || info.isMaster || !info.segments.length) return null;
        const urls = [];
        if (info.map) urls.push(info.map);
        info.segments.forEach((s) => urls.push(s.url));
        return urls;
    }

    const segExt = (info) => {
        if (!info || !info.segments.length) return '.ts';
        if (info.map || /\.m4s(\?|$)/i.test(info.segments[0].url)) return '.mp4';
        return '.ts';
    };

    let running = false;
    async function onDownload() {
        if (running || !canSave) return;

        let urls = collectUrls(currentManifest);
        const ext = segExt(currentManifest);
        if (!urls) {
            const total = totalLengthSec > 0 ? Math.max(1, Math.ceil(totalLengthSec / 10)) : 0;
            if (!total) {
                dlInfo.textContent = '清单没解析出分片，接口也没给视频总时长，无法推算切片数';
                dlInfo.style.color = '#d93025';
                return;
            }
            const tpl = buildTemplate(currentUrl);
            urls = Array.from({ length: total }, (_, i) => tpl.replace('tsindex', String(i)));
        }

        running = true;
        btnDl.disabled = true;
        dlBar.wrap.style.display = '';
        dlBar.set(0, urls.length);
        let btnCancel = null;
        let ctrl = null;
        try {
            // 保存对话框必须在点击的第一时间弹出：晚于网络请求就没有用户激活态了
            const outName = safeName(title + '_' + channel) + '_' + BITRATES[bi] + 'k_enc2密文' + ext;
            const sink = await openSink(outName, ext);
            ctrl = new AbortController();
            btnCancel = mkBtn('取消下载', '#d93025', () => {
                ctrl.abort();
                btnCancel.textContent = '正在取消…';
                btnCancel.disabled = true;
            });
            dlBtns.appendChild(btnCancel);
            dlInfo.textContent = '下载中…';
            dlInfo.style.color = '#5f6368';
            const res = await streamMerge(urls, {
                signal: ctrl.signal,
                sink,
                onProgress: (done, bytes) => {
                    dlBar.set(done, urls.length);
                    dlInfo.textContent = '已合并 ' + done + '/' + urls.length + ' 段 · ' + fmtBytes(bytes) + '（按序号写入）';
                }
            });
            dlBar.fill.style.background = '#188038';
            dlInfo.textContent = '完成：' + res.count + ' 段 / ' + fmtBytes(res.bytes) + ' → ' + outName + '（密文，未解密）';
            dlInfo.style.color = '#188038';
        } catch (e) {
            dlBar.fill.style.background = '#e6a23c';
            if (e.cancelled) {
                dlInfo.textContent = e.message + '，本次输出已丢弃';
                dlInfo.style.color = '#e6a23c';
            } else if (e.name === 'AbortError') {
                dlInfo.textContent = '已取消选择保存位置';
                dlInfo.style.color = '#5f6368';
            } else {
                dlInfo.textContent = '下载失败：' + e.message + (e.written ? '（已写 ' + e.written + ' 段）' : '');
                dlInfo.style.color = '#d93025';
            }
            console.error('[CCTV ENC2 下载]', e);
        } finally {
            if (btnCancel) btnCancel.remove();
            running = false;
            btnDl.disabled = false;
        }
    }

    probe();
}

/* -------------------- 播放页：给出解析入口 -------------------- */
async function playerPage() {
    const READY_KEY = '__cctv_enc2_ready__';
    if (!W[READY_KEY]) W[READY_KEY] = 0;

    const apiHref = (pid) => {
        const sp = new URLSearchParams({
            pid,
            client: 'html5',
            tai: 'ipad',
            tsp: Math.floor(Date.now() / 1000).toString(),
            vn: '2049',
            uid: '826D8646DEBBFD97A82D23CAE45A55BE',
            wlan: ''
        });
        return API_BASE + '?' + sp.toString();
    };

    const readGuids = () => {
        const found = [];
        const push = (g) => { if (g && /^[0-9a-fA-F]{6,32}$/.test(g) && !found.includes(g)) found.push(g); };
        // flashPlayerList 的项形如 "flashPlayer_<key>"；前缀变了后面还有全表扫描兜底
        for (const raw of W.flashPlayerList || []) {
            const key = String(raw).replace(/^flashPlayer_/, '');
            push(W.vodPlayerObjs?.[key]?.videoCenterId);
        }
        if (!found.length && W.vodPlayerObjs) {
            Object.values(W.vodPlayerObjs).forEach((o) => push(o?.videoCenterId));
        }
        // loading_video 是内联脚本里的函数源码，直接从源码里抠 centerId
        if (!found.length && W.loading_video) {
            push(String(W.loading_video).match(/centerid[^0-9a-f]*([0-9a-f]{6,32})/i)?.[1]);
        }
        return found;
    };

    const makeButtons = (guids) => {
        if (document.getElementById('cctv-enc2-entry')) return true;
        const bar = document.createElement('div');
        bar.id = 'cctv-enc2-entry';
        bar.style.cssText = 'position:fixed; z-index:999; right:20px; bottom:20px;' +
            'display:flex; flex-direction:column; gap:8px; align-items:flex-end;';
        guids.forEach((guid, n) => {
            const a = document.createElement('a');
            a.href = apiHref(guid);
            a.target = '_blank';
            a.textContent = '解析 ENC2' + (guids.length > 1 ? ' #' + (n + 1) : '') + ' → ' + guid;
            a.style.cssText = 'background:#f86336; color:#fff; padding:8px 12px; border-radius:6px;' +
                'font-size:14px; text-decoration:none; box-shadow:0 4px 14px rgba(0,0,0,.3);';
            bar.appendChild(a);
        });
        document.body.appendChild(bar);
        return true;
    };

    const MAX_TRIES = 8;
    const INTERVAL = 500;
    const tick = () => {
        W[READY_KEY]++;
        const guids = readGuids();
        if (guids.length && makeButtons(guids)) return;
        if (W[READY_KEY] >= MAX_TRIES) {
            showNotice(
                'CCTV解析（ENC2）：未检测到播放器对象（flashPlayerList / vodPlayerObjs / loading_video 均空），' +
                '可能是页面改版或加载时机不对，可刷新后重试。'
            );
        } else {
            setTimeout(tick, INTERVAL);
        }
    };
    // 播放器是异步初始化的，固定延迟在慢页面上会扑空，改成轮询等待
    setTimeout(tick, 800);
}

/* -------------------- 入口分发 -------------------- */
(async function main() {
    if (location.hostname.indexOf('vdn.apps.cntv.cn') > -1) await apiPage();
    else await playerPage();
})();
