// ==UserScript==
// @name:en-US         CCTV-HLS-Client
// @name               CCTV视频客户端解析
// @description:en-US  parse cctv video to hls url.
// @description        将CCTV视频解析成HLS地址.支持4K频道和两种加密接口
// @namespace          https://greasyfork.org/users/135090
// @version            1.3.0
// @author             [ZWB](https://greasyfork.org/zh-CN/users/863179)
// @license            CC0
// @grant              none
// @run-at             document-end
// @match              *://live.ipanda.com/*/*/*/V*.shtml*
// @match              *://*.cctv.com/*/*/*/V*.shtml*
// @match              *://*.cctv.com/*/*/*/A*.shtml*
// @match              *://*.cctv.cn/*/*/*/V*.shtml*
// @match              *://*.cctv.cn/*/*/*/A*.shtml*
// @match              *://www.docuchina.cn/*/VID*.shtml*
// @match              https://*.cntv.cn/program/*/*/*.shtml*
// @match              *://vdn.apps.cntv.cn/api/getHttpVideoInfo*
// @icon               https://tv.cctv.cn/favicon.ico
// @downloadURL https://update.greasyfork.org/scripts/558396/CCTV%E8%A7%86%E9%A2%91%E5%AE%A2%E6%88%B7%E7%AB%AF%E8%A7%A3%E6%9E%90.user.js
// @updateURL https://update.greasyfork.org/scripts/558396/CCTV%E8%A7%86%E9%A2%91%E5%AE%A2%E6%88%B7%E7%AB%AF%E8%A7%A3%E6%9E%90.meta.js
// ==/UserScript==

'use strict';

/* ------------------------------------------------------------------ *
 * UI:全部挂在 shadow DOM 里,只往 <html> 追加一个宿主节点。
 * 不写 innerHTML、不删原页面内容,样式也不会漏出去污染宿主页面。
 * ------------------------------------------------------------------ */
const CSS = `
:host { all: initial; }
* { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }
.wrap { position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;
        display: flex; flex-direction: column; gap: 8px; align-items: flex-end;
        max-width: min(620px, calc(100vw - 32px)); }
.card { width: 100%; background: #1c2027; color: #e8eaed; border: 1px solid #3b4252;
        border-radius: 10px; box-shadow: 0 8px 28px rgba(0,0,0,.45); overflow: hidden;
        font-size: 13px; }
.head { display: flex; align-items: center; gap: 8px; padding: 7px 10px;
        background: #262b35; border-bottom: 1px solid #3b4252; }
.head .name { font-weight: 600; letter-spacing: .3px; flex: 1; }
.head button { background: transparent; color: #9aa4b2; border: 0; cursor: pointer;
               font-size: 14px; padding: 0 4px; line-height: 1; }
.head button:hover { color: #fff; }
.body { padding: 8px 10px; display: flex; flex-direction: column; gap: 6px; }
.collapsed > .body, .collapsed > .foot { display: none; }
.row { display: flex; align-items: baseline; gap: 8px; }
.row .k { color: #8b95a5; flex: 0 0 88px; }
.row .v { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.row .v a { color: #6cb2ff; text-decoration: none; }
.row .v a:hover { text-decoration: underline; }
.btn { background: #f86336; color: #fff; border: 0; border-radius: 6px;
       padding: 4px 9px; cursor: pointer; font-size: 12px; }
.btn:hover { filter: brightness(1.08); }
.btn:disabled { background: #4a5160; cursor: default; }
.btn.ghost { background: #2d3441; color: #cfd6e0; }
.bar { height: 6px; border-radius: 3px; background: #333b48; overflow: hidden; }
.bar > i { display: block; height: 100%; width: 0; background: #38b26b; transition: width .2s; }
.muted { color: #8b95a5; }
.toasts { display: flex; flex-direction: column; gap: 6px; align-items: flex-end; }
.toast { background: #2b313c; border-left: 3px solid #6cb2ff; color: #e8eaed;
         padding: 7px 11px; border-radius: 8px; box-shadow: 0 4px 16px rgba(0,0,0,.4);
         max-width: 420px; overflow-wrap: anywhere; animation: fade .18s ease-out; }
.toast.ok { border-left-color: #38b26b; }
.toast.warn { border-left-color: #e6a23c; }
.toast.err { border-left-color: #f56c6c; }
@keyframes fade { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; } }
`;

const UI = (() => {
    let host, shadow, panel, panelBody, toasts, bar, barFill, foot, statusLine;
    let ready = false;

    const el = (tag, cls, text) => {
        const n = document.createElement(tag);
        if (cls) n.className = cls;
        if (text !== undefined) n.textContent = text;
        return n;
    };

    function init(title) {
        if (ready) return;
        host = document.createElement('div');
        host.setAttribute('data-cctv-hls', '');
        shadow = host.attachShadow({ mode: 'open' });

        const style = el('style');
        style.textContent = CSS;

        const wrap = el('div', 'wrap');
        panel = el('div', 'card');

        const head = el('div', 'head');
        head.append(el('span', 'name', title || 'CCTV HLS'));
        const collapse = el('button', null, '—');
        collapse.title = '折叠 / 展开';
        collapse.onclick = () => panel.classList.toggle('collapsed');
        head.append(collapse);

        panelBody = el('div', 'body');
        foot = el('div', 'body');
        foot.style.display = 'none';
        statusLine = el('div', 'muted', '');
        bar = el('div', 'bar');
        barFill = el('i');
        bar.append(barFill);

        panel.append(head, panelBody, foot);
        toasts = el('div', 'toasts');
        wrap.append(panel, toasts);
        shadow.append(style, wrap);
        // 挂到 documentElement:即使宿主页面结构变化也不会被一起清掉
        document.documentElement.appendChild(host);
        ready = true;
    }

    function row(key, valueNode) {
        init();
        const r = el('div', 'row');
        r.append(el('span', 'k', key));
        const v = el('span', 'v');
        if (typeof valueNode === 'string') v.textContent = valueNode;
        else if (valueNode) v.append(valueNode);
        r.append(v);
        panelBody.append(r);
        return r;
    }

    function link(url, label) {
        const a = el('a', null, label || url);
        a.href = url;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        return a;
    }

    function button(label, onclick, ghost) {
        const b = el('button', 'btn' + (ghost ? ' ghost' : ''), label);
        b.onclick = onclick;
        return b;
    }

    function copyButton(text) {
        return button('复制', async () => {
            try {
                await navigator.clipboard.writeText(text);
                toast('已复制', 'ok', 1500);
            } catch (e) {
                // 非安全上下文或权限被拒时退回手动复制
                toast('剪贴板不可用,请手动选中复制', 'warn', 3000);
            }
        }, true);
    }

    function setBusy(text) {
        foot.replaceChildren(statusLine, bar);
        foot.style.display = '';
        statusLine.textContent = text;
        barFill.style.width = '0%';
    }

    function setProgress(done, total, text) {
        const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
        barFill.style.width = pct + '%';
        statusLine.textContent = `${text} ${done}/${total} (${pct}%)`;
    }

    function clearBusy() {
        foot.style.display = 'none';
        foot.replaceChildren();
    }

    function toast(msg, type, ms) {
        init();
        const t = el('div', 'toast ' + (type || ''), msg);
        t.onclick = () => t.remove();
        toasts.append(t);
        setTimeout(() => t.remove(), ms || (type === 'err' ? 8000 : 4000));
    }

    return { init, row, link, button, copyButton, setBusy, setProgress, clearBusy, toast, el };
})();

/* ------------------------------------------------------------------ *
 * 播放页:找到 videoCenterId,给出解析接口入口
 * ------------------------------------------------------------------ */
const API_BASE = 'https://vdn.apps.cntv.cn/api/getHttpVideoInfo.do';

function apiHref(pid) {
    const sp = new URLSearchParams({
        pid,
        client: 'html5',
        tai: 'ipad',
        tsp: Math.floor(Date.now() / 1000).toString(),
        vn: '2049',
        uid: '826D8646DEBBFD97A82D23CAE45A55BE',
        wlan: ''
    });
    return `${API_BASE}?${sp}`;
}

function readGuids() {
    const found = [];
    const push = g => { if (g && /^[0-9a-fA-F]{6,32}$/.test(g) && !found.includes(g)) found.push(g); };

    const objs = window.vodPlayerObjs;
    // flashPlayerList 的项形如 "flashPlayer_<key>";万一前缀变了,后面还有全表扫描兜底
    for (const raw of window.flashPlayerList || []) {
        const key = String(raw).replace(/^flashPlayer_/, '');
        push(objs?.[key]?.videoCenterId);
    }
    if (!found.length && objs) {
        Object.values(objs).forEach(o => push(o?.videoCenterId));
    }
    // loading_video 是内联脚本里的函数源码,直接从源码里抠 centerId
    if (!found.length && typeof window.loading_video === 'function') {
        push(String(window.loading_video).match(/centerid[^0-9a-f]*([0-9a-f]{6,32})/i)?.[1]);
    }
    return found;
}

// 播放器是异步初始化的,固定 setTimeout(1500) 在慢页面上会扑空,改成轮询等待
function waitForGuids(timeoutMs) {
    return new Promise(resolve => {
        const start = Date.now();
        const tick = () => {
            const g = readGuids();
            if (g.length) return resolve(g);
            if (Date.now() - start > timeoutMs) return resolve([]);
            setTimeout(tick, 500);
        };
        tick();
    });
}

async function playerPage() {
    const guids = await waitForGuids(20000);
    if (!guids.length) {
        UI.toast('没找到播放器 videoCenterId,本页可能已被改版', 'warn');
        return;
    }
    UI.init('CCTV 视频解析');
    guids.forEach((guid, n) => {
        const url = apiHref(guid);
        const box = UI.el('span');
        box.append(UI.link(url, guids.length > 1 ? `解析 #${n + 1} → ${guid}` : `点击解析 → ${guid}`));
        UI.row('HLS 解析', box);
    });
    UI.toast(`发现 ${guids.length} 个视频源`, 'ok', 2500);
}

/* ------------------------------------------------------------------ *
 * 接口页:解析 JSON,展示清晰度地址并提供下载
 * ------------------------------------------------------------------ */
// switchh5e 为 0 时用 enc2 接口,非 0 时用 h5e 接口
const USE_H5E = 10;
const BITRATES = [450, 850, 1200, 2000, 4000, 3000];
// validChapterNum(1..5) -> BITRATES 下标:版权受限(403)时的降级档位
// 用 ES6 Map 查表,不用 对象字面量[键] 的写法
const FALLBACK_INDEX = new Map([[1, 0], [2, 1], [3, 1], [4, 3], [5, 3]]);

// 文件名非法字符 + 会被隐式转成半角的全角字符统一替换为 "_"
const clean = s => String(s).replace(/[\u002f\u003a\u003f\u0022\u0027\u003c\u003e\u007c\u0020\u005c\u002a\u3000\uff02\uff07]/g, '_');

function pickEncUrl(data) {
    if (USE_H5E !== 0) return data?.manifest?.hls_h5e_url;
    const enc2 = data?.manifest?.hls_enc2_url;
    if (!enc2) return data?.manifest?.hls_h5e_url;
    const u = new URL(enc2);
    // enc2 接口只提供 http;★换 CDN 域名时改这里,例如 u.hostname = "drm.cntv.vod.dnsv1.com"
    u.protocol = 'http:';
    return u.toString();
}

// GUID 优先取接口的 guid 字段,否则退回原脚本的固定路径位置
function pickGuid(data, encUrl) {
    return String(data?.guid || encUrl?.split('/')[10] || '');
}

async function apiPage() {
    const raw = document.body?.querySelector('pre')?.textContent || document.body?.textContent || '';
    let data;
    try {
        data = JSON.parse(raw);
    } catch (e) {
        // 接口在鉴权失败/限流时返回的不是 JSON,原来会在这里直接抛异常且无任何提示
        UI.toast('接口返回的不是 JSON,可能被限流或鉴权失败', 'err');
        console.error(e, raw.slice(0, 200));
        return;
    }

    const h5eUrl = pickEncUrl(data);
    const title = clean((data?.title || 'video') + '_' + (data?.play_channel || ''));
    const mainUrl = data?.hls_url;
    const totalLengthSec = Number(data?.video?.totalLength || 0);
    const brtnum = Number(data?.video?.validChapterNum || 0);
    const guid = pickGuid(data, h5eUrl);

    UI.init('CCTV HLS');
    const official = guid ? `https://app.cctv.com/special/m/livevod/index.html?guid=${guid}&vtype=2` : '';
    if (official) {
        const box = UI.el('span');
        box.append(UI.link(official, data?.title || '(无)'));
        UI.row('标题', box);
    } else {
        UI.row('标题', data?.title || '(无)');
    }
    UI.row('频道', data?.play_channel || '(无)');
    UI.row('GUID', guid || '(未识别)');
    const addLinkRow = (label, url) => {
        if (!url) return;
        const box = UI.el('span');
        box.append(UI.link(url, url), UI.copyButton(url));
        UI.row(label, box);
    };

    // 加密地址一律给具体码率,不给 main.m3u8 主清单(主清单不保证取到最高码率)
    const encAt = (i) => (h5eUrl ? h5eUrl.replaceAll('main', BITRATES[i]) : h5eUrl);
    // validChapterNum 越界时用最低档
    const fallbackIndex = FALLBACK_INDEX.has(brtnum) ? FALLBACK_INDEX.get(brtnum) : 0;
    const at = (i) => mainUrl.replaceAll('main', BITRATES[i]);

    let plainUrl = '';        // 未加密地址
    let encUrl = h5eUrl ? encAt(fallbackIndex) : '';

    if (!mainUrl) {
        addLinkRow(`加密版备选 ${BITRATES[fallbackIndex]}`, encUrl);
        UI.toast('接口没有返回 hls_url,无法继续', 'err');
    } else {
        let response = null;
        try {
            response = await fetch(mainUrl);
        } catch (e) {
            addLinkRow(`加密版备选 ${BITRATES[fallbackIndex]}`, encUrl);
            UI.toast(`主播放列表请求失败(多为跨域或网络问题): ${e.message}`, 'err');
        }
        if (response) {
            if (response.ok) {
                const m3u8 = await response.text();
                const ch = data.play_channel || '';
                let ci;
                let encIdx = -1;          // 加密版码率下标;-1 = 跟未加密同档
                if (ch.startsWith('CCTV-4K')) {
                    ci = 4;                        // 4000,只有 CCTV-4K 有这一档
                } else if (ch.startsWith('CCTV-16')) {
                    ci = 5;                        // 3000
                } else if (m3u8.includes('1200.m3u8')) {
                    ci = 3;                        // 2000
                } else if (brtnum > 3) {
                    ci = 1;                        // 850
                    encIdx = 3;                    // validChapterNum > 3:加密版按 2000 走
                } else {
                    ci = brtnum > 0 && brtnum < 3 ? brtnum - 1 : 1;
                }
                if (encIdx < 0) encIdx = ci;       // 其余情况加密版与未加密同档
                plainUrl = at(ci);
                encUrl = encAt(encIdx);
                addLinkRow(`加密版 ${BITRATES[encIdx]}`, encUrl);
                addLinkRow(`未加密版 ${BITRATES[ci]}`, plainUrl);
            } else if (response.status === 403) {
                // 版权限制:没有未加密版,只能给出加密地址
                addLinkRow(`加密版备选 ${BITRATES[fallbackIndex]}`, encUrl);
                UI.toast('版权原因无法获取未加密版,请使用其他工具下载', 'warn', 8000);
            } else if (response.status === 404) {
                addLinkRow(`加密版备选 ${BITRATES[fallbackIndex]}`, encUrl);
                UI.toast('该频道没有未加密版 (404),只能使用加密版地址', 'warn', 6000);
            } else {
                addLinkRow(`加密版备选 ${BITRATES[fallbackIndex]}`, encUrl);
                UI.toast(`主播放列表请求失败: HTTP ${response.status}`, 'err');
            }
        }
    }

    // 下载交给用户自己选:面板上给两个按钮,不自动弹确认框
    const dlButtons = [];
    let busy = false;
    const makeDownload = (label, url, filename, hint) => {
        if (!url) return null;
        const b = UI.button(label, async () => {
            if (busy) return;
            busy = true;
            dlButtons.forEach(x => { x.disabled = true; });
            if (hint) UI.toast(hint, 'warn', 5000);
            const controller = new AbortController();
            const cancel = UI.button('取消下载', () => {
                controller.abort();
                cancel.disabled = true;
                cancel.textContent = '正在取消…';
            }, true);
            const cancelRow = UI.row('操作', cancel);
            UI.setBusy('下载中');
            try {
                await downloadTs(url, totalLengthSec, filename, {
                    signal: controller.signal,
                    onProgress: UI.setProgress
                });
                UI.clearBusy();
                UI.toast('下载完成', 'ok');
            } catch (e) {
                UI.clearBusy();
                if (e.name === 'AbortError') {
                    UI.toast('已取消下载', 'warn');
                } else {
                    UI.toast(`下载失败: ${e.message}`, 'err');
                    console.error(e);
                }
            } finally {
                cancelRow.remove();
                busy = false;
                dlButtons.forEach(x => { x.disabled = false; });
            }
        });
        dlButtons.push(b);
        return b;
    };

    const opsBox = UI.el('span');
    opsBox.style.display = 'flex';
    opsBox.style.gap = '8px';
    const plainBtn = makeDownload('下载未加密版', plainUrl, `${title}.ts`);
    const encBtn = makeDownload('下载加密版', encUrl, `${title}_加密.ts`, '加密版下载的是加密分片,播放前需要自行解密');
    if (plainBtn) opsBox.append(plainBtn);
    if (encBtn) opsBox.append(encBtn);
    if (plainBtn || encBtn) UI.row('下载', opsBox);
}

/* ------------------------------------------------------------------ *
 * 按 tsindex 递增猜测切片下载,最后合并成单个 .ts
 * ------------------------------------------------------------------ */
async function downloadTs(m3u8Url, totalLengthSec, outputFilename, options = {}) {
    const { signal, onProgress } = options;

    const urlObj = new URL(m3u8Url);
    urlObj.search = '';
    const pathArr = urlObj.pathname.split('/');
    pathArr[pathArr.length - 1] = 'tsindex.ts';
    urlObj.pathname = pathArr.join('/');
    const template = urlObj.toString();

    if (!(totalLengthSec > 0)) throw new Error('接口没有给出有效总时长,无法推算切片数量');
    const total = Math.max(1, Math.ceil(totalLengthSec / 10));
    console.log(`预估总时长 ${totalLengthSec}s,切片数 ${total}`);

    const blobs = [];
    for (let i = 0; i < total; i++) {
        if (signal?.aborted) {
            const err = new Error('已取消');
            err.name = 'AbortError';
            throw err;
        }
        const segUrl = template.replace('tsindex', i);
        try {
            const res = await fetch(segUrl, { signal });
            if (!res.ok) throw new Error(`切片 ${i} 请求失败: HTTP ${res.status}`);
            blobs.push(await res.blob());
        } catch (e) {
            if (e.name === 'AbortError') throw e;
            console.error(`下载 ${segUrl} 出错:`, e);
            throw e;
        }
        onProgress?.(i + 1, total, '进度');
    }

    const blobUrl = URL.createObjectURL(new Blob(blobs, { type: 'video/mp2t' }));
    const a = UI.el('a');
    a.href = blobUrl;
    a.download = outputFilename;
    document.body.append(a);
    a.click();
    a.remove();
    // 立即 revoke 会让部分浏览器取消下载,留足时间再释放
    setTimeout(() => URL.revokeObjectURL(blobUrl), 30000);
}

(async function main() {
    if (location.hostname.includes('vdn.apps.cntv.cn')) await apiPage();
    else await playerPage();
})();
