#!/usr/bin/env node
/*
 * udrm-dec.cjs — UDRM 两段式解密流水线（CJS，Node/Bun 通用，算法层不依赖 FFmpeg）
 *
 * 用法:
 *   node udrm-dec.cjs <input.(ts|mp4)> <output.mp4> [--key HEX] [-q] [-r]
 *
 * 流程:
 *   第 1 段  输入非 MP4(如 .ts) 时，调用 ffmpeg CLI 以 -c copy 重新封装成标准 MP4
 *            (AnnexB 起始码 -> 4 字节长度前缀 AVCC，保留音频与时间戳)。
 *   第 2 段  纯 JS 解析 MP4 抽样表(stsz/stco/stsc)得到每个视频 sample 的文件偏移，
 *            逐 NAL 复刻 udrm_remux.c 的逻辑:
 *              - SEI(type6): 解析 CEI 取 kid，patch 成假 SEI
 *              - slice(type1/5): AES-128-ECB + 前密文块异或(160 字节分组: 16 加密 + 144 明文)
 *            因 patch/解密均为等长变换，直接原地改写 mdat，moov/时间戳/音频全部不动。
 *            CEK 优先级: --key > 本地表 > license 服务器(移植自 license.py)；统一以 HEX 表示；
 *            带 -r/--refresh 时跳过本地表，直接向服务器取。内置表仅在本地表文件不存在时
 *            作为种子数据落盘一次，运行时不参与取值。
 */

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const http = require('node:http');
const { spawnSync } = require('node:child_process');
const { URL } = require('node:url');

/* ============================== SM3 ============================== */

const MASK32 = 0xffffffff;
const SM3_IV = [
    0x7380166f, 0x4914b2b9, 0x172442d7, 0xda8a0600,
    0xa96f30bc, 0x163138aa, 0xe38dee4d, 0xb0fb0e4e,
];

function rol(x, n) {
    n &= 31;
    if (n === 0) return x >>> 0;
    return ((x << n) | (x >>> (32 - n))) >>> 0;
}
function p0(x) { return (x ^ rol(x, 9) ^ rol(x, 17)) >>> 0; }
function p1(x) { return (x ^ rol(x, 15) ^ rol(x, 23)) >>> 0; }

function sm3Compress(v, block, off) {
    const w = new Uint32Array(68);
    for (let i = 0; i < 16; i++) {
        const b = off + i * 4;
        w[i] = (((block[b] << 24) | (block[b + 1] << 16) | (block[b + 2] << 8) | block[b + 3]) >>> 0);
    }
    for (let j = 16; j < 68; j++) {
        w[j] = (p1((w[j - 16] ^ w[j - 9] ^ rol(w[j - 3], 15)) >>> 0) ^ rol(w[j - 13], 7) ^ w[j - 6]) >>> 0;
    }
    const w1 = new Uint32Array(64);
    for (let j = 0; j < 64; j++) w1[j] = (w[j] ^ w[j + 4]) >>> 0;

    let a = v[0], b = v[1], c = v[2], d = v[3], e = v[4], f = v[5], g = v[6], h = v[7];
    for (let j = 0; j < 64; j++) {
        const t = j < 16 ? 0x79cc4519 : 0x7a879d8a;
        const ss1 = rol((rol(a, 12) + e + rol(t, j)) >>> 0, 7);
        const ss2 = (ss1 ^ rol(a, 12)) >>> 0;
        let ff, gg;
        if (j < 16) { ff = (a ^ b ^ c) >>> 0; gg = (e ^ f ^ g) >>> 0; }
        else { ff = ((a & b) | (a & c) | (b & c)) >>> 0; gg = ((e & f) | ((~e) & g)) >>> 0; }
        const tt1 = (ff + d + ss2 + w1[j]) >>> 0;
        const tt2 = (gg + h + ss1 + w[j]) >>> 0;
        d = c; c = rol(b, 9); b = a; a = tt1;
        h = g; g = rol(f, 19); f = e; e = p0(tt2);
    }
    v[0] = (v[0] ^ a) >>> 0; v[1] = (v[1] ^ b) >>> 0;
    v[2] = (v[2] ^ c) >>> 0; v[3] = (v[3] ^ d) >>> 0;
    v[4] = (v[4] ^ e) >>> 0; v[5] = (v[5] ^ f) >>> 0;
    v[6] = (v[6] ^ g) >>> 0; v[7] = (v[7] ^ h) >>> 0;
}

function sm3(data) {
    const msg = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
    const bitLen = BigInt(msg.length) * 8n;
    const k = (56 - ((msg.length + 1) % 64) + 64) % 64;
    const total = msg.length + 1 + k + 8;
    const buf = Buffer.alloc(total);
    msg.copy(buf, 0);
    buf[msg.length] = 0x80;
    let bl = bitLen;
    for (let i = 0; i < 8; i++) { buf[total - 1 - i] = Number(bl & 0xffn); bl >>= 8n; }
    const v = Uint32Array.from(SM3_IV);
    for (let o = 0; o < total; o += 64) sm3Compress(v, buf, o);
    const out = Buffer.alloc(32);
    for (let i = 0; i < 8; i++) out.writeUInt32BE(v[i] >>> 0, i * 4);
    return out;
}

/* ====================== license.py 逻辑迁移 ====================== */

const DEFAULT_URL = 'https://cdrm.live.cntv.cn:444/udrm/udmCNTVGetLicense';
const DEFAULT_DEVICE_ID = '1002881000000686';
const SIG_PREFIX = 'CNTV';
const SIG_SALT = '21A28554279E4A7B';

function makeTemplate() {
    // 字段顺序即签名顺序，必须与 Python 版一致
    return {
        version: '3.2-UDRM-CNTV',
        platform: '5',
        cdn: '1',
        udrmTerminalLibVersion: 'v1.1.20251201001m',
        operatorID: '15',
        apkVersion: 'cbox2100',
        extensions: [{ critical: 'true', identifier: '', name: 'mac' }],
        deviceID: 'MTAwMjg4MTAwMDAwMDY4Ng==',
        drmServerID: 'CNTV',
        nonce: '',
        timestamp: '1531368146',
        contentIDs: '',
        certificateChain: ['MTAwMjg4MTAwMDAwMDYyOQ=='],
        signature: '',
    };
}

function buildRequest(kid, nonce) {
    if (!nonce) nonce = crypto.randomBytes(32).toString('base64');
    const body = makeTemplate();
    body.nonce = nonce;
    body.contentIDs = [Buffer.from(kid, 'utf8').toString('base64')];
    const json = JSON.stringify(body); // 紧凑、无空格、保序
    const sig = sm3(SIG_PREFIX + json + SIG_SALT).toString('base64');
    return { body: json.replace('"signature":""', `"signature":"${sig}"`), nonce };
}

function post(urlStr, body, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
        const u = new URL(urlStr);
        const mod = u.protocol === 'https:' ? https : http;
        const req = mod.request({
            protocol: u.protocol,
            hostname: u.hostname,
            port: u.port || (u.protocol === 'https:' ? 443 : 80),
            path: u.pathname + (u.search || ''),
            method: 'POST',
            headers: {
                Accept: '*/*',
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
            },
            rejectUnauthorized: false, // 对应 verify_tls=False
        }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        });
        req.on('error', reject);
        req.setTimeout(timeoutMs, () => req.destroy(new Error('request timeout')));
        req.write(body);
        req.end();
    });
}

function deriveCek(licenseBuf, kid, reqNonce, deviceId, respNonce) {
    const key2 = sm3('cntv' + kid + reqNonce + deviceId + respNonce).subarray(0, 16);
    const n = Math.min(licenseBuf.length, 16);
    const cek = Buffer.alloc(n);
    for (let i = 0; i < n; i++) cek[i] = licenseBuf[i] ^ key2[i];
    return { cek, key2: Buffer.from(key2) };
}

async function fetchCek(kid) {
    const { body, nonce } = buildRequest(kid);
    const raw = await post(DEFAULT_URL, body);
    let resp;
    try { resp = JSON.parse(raw); }
    catch { throw new Error('server did not return JSON: ' + JSON.stringify(raw.slice(0, 200))); }
    if (resp.status !== 0) {
        throw new Error(`licence server error: status=${resp.status} message=${resp.message}`);
    }
    const entries = [];
    for (const pl of (resp.protectedLicenses || [])) {
        const cid = Buffer.from(pl.contentId || '', 'base64').toString('latin1');
        for (const li of (pl.licenses || [])) {
            const rkid = Buffer.from(li.licenseID || '', 'base64').toString('latin1');
            const lic = Buffer.from(li.license || '', 'base64');
            const { cek } = deriveCek(lic, rkid, nonce, DEFAULT_DEVICE_ID, resp.nonce || '');
            entries.push({ cid, kid: rkid, cek });
        }
    }
    if (!entries.length) throw new Error('no licence in response: ' + JSON.stringify(raw.slice(0, 200)));
    const out = entries[0];
    out.reqNonce = nonce;
    out.respNonce = resp.nonce || '';
    return out;
}

/* 内置 kid -> CEK 表：仅作首次运行的种子数据，运行时不参与 CEK 取值。
 * CEK 统一用 32 位小写十六进制表示，与控制台输出一致。 */
const BUILTIN_KEYS = {
    'l6ethtgd000000000000000000000004': '6b66797533336236736a32786f656a6d',
    'o0gfroc3000000000000000000000012': '756a386e726739306e3974326e633972',
};

const HEX32_RE = /^[0-9a-fA-F]{32}$/;

/* 本地兜底表：默认把服务器取到的 CEK 以 HEX 形式落盘(kid -> 32 位十六进制)。
 * 路径可用环境变量 UDRM_KEYS_FILE 覆盖。 */
function keysFilePath() {
    return process.env.UDRM_KEYS_FILE || path.join(__dirname, 'udrm-keys.json');
}

function loadLocalKeys() {
    try {
        const obj = JSON.parse(fs.readFileSync(keysFilePath(), 'utf8'));
        if (!obj || typeof obj !== 'object') return {};
        const table = {};
        let changed = false;
        for (const [kid, v] of Object.entries(obj)) {
            const b = tableStringToCek(v);
            const hex = b ? b.toString('hex') : v;
            if (hex !== v) changed = true; // 旧版 latin1 值在此统一升级为 HEX
            table[kid] = hex;
        }
        if (changed) saveLocalKeys(table); // 一次性把旧格式重写为 HEX
        return table;
    } catch {
        return {}; // 不存在/损坏都当空表
    }
}

function saveLocalKeys(table) {
    const file = keysFilePath();
    try {
        fs.writeFileSync(file, JSON.stringify(table, null, 2) + '\n');
        return { ok: true, file };
    } catch (e) {
        return { ok: false, file, error: e && e.message ? e.message : String(e) };
    }
}

/* 把 16 字节 CEK 转成兜底表里的字符串形式（32 位小写十六进制，与控制台输出一致） */
function cekToTableString(cek) {
    return Buffer.from(cek).toString('hex');
}

/* 兜底表值 -> 16 字节 CEK：新格式为 32 位十六进制，同时兼容旧版 16 字符 latin1 值 */
function tableStringToCek(s) {
    if (typeof s !== 'string') return null;
    if (HEX32_RE.test(s)) return Buffer.from(s, 'hex');
    const b = Buffer.from(s, 'latin1');
    return b.length === 16 ? b : null;
}

/* 内置表降级为“首次运行种子数据”：本地表文件不存在时整表写入。
 * 判据只看文件是否存在：存在就绝不写入，避免覆盖用户已有记录。 */
function seedLocalKeys() {
    const file = keysFilePath();
    if (fs.existsSync(file)) return { seeded: false, file, count: 0 };
    const table = {};
    for (const [kid, cek] of Object.entries(BUILTIN_KEYS)) {
        table[kid] = cekToTableString(Buffer.from(cek, 'hex'));
    }
    const r = saveLocalKeys(table);
    return { seeded: r.ok, file, count: Object.keys(table).length, error: r.error };
}

/* ============================ MP4 盒解析 ============================ */

const CEI_UUID = Buffer.from([
    0x49, 0x2f, 0x85, 0xaa, 0xc7, 0xa7, 0x4a, 0x7e,
    0xbf, 0x53, 0x01, 0x40, 0xf7, 0x28, 0xc1, 0x06,
]);

function readBoxes(buf, start, end) {
    const boxes = [];
    let p = start;
    while (p + 8 <= end) {
        let size = buf.readUInt32BE(p);
        const type = buf.toString('latin1', p + 4, p + 8);
        let header = 8;
        if (size === 1) { size = Number(buf.readBigUInt64BE(p + 8)); header = 16; }
        else if (size === 0) { size = end - p; }
        if (size < header || p + size > end) break;
        boxes.push({ type, start: p, header, size, payload: p + header, end: p + size });
        p += size;
    }
    return boxes;
}

function parseStsz(buf, box) {
    let p = box.payload + 4;
    const sampleSize = buf.readUInt32BE(p); p += 4;
    const sampleCount = buf.readUInt32BE(p); p += 4;
    const sizes = new Array(sampleCount);
    if (sampleSize !== 0) { sizes.fill(sampleSize); }
    else { for (let i = 0; i < sampleCount; i++) { sizes[i] = buf.readUInt32BE(p); p += 4; } }
    return sizes;
}

function parseChunkOffsets(buf, box) {
    let p = box.payload + 4;
    const count = buf.readUInt32BE(p); p += 4;
    const offs = new Array(count);
    if (box.type === 'co64') { for (let i = 0; i < count; i++) { offs[i] = Number(buf.readBigUInt64BE(p)); p += 8; } }
    else { for (let i = 0; i < count; i++) { offs[i] = buf.readUInt32BE(p); p += 4; } }
    return offs;
}

function parseStsc(buf, box) {
    let p = box.payload + 4;
    const count = buf.readUInt32BE(p); p += 4;
    const entries = new Array(count);
    for (let i = 0; i < count; i++) {
        entries[i] = {
            firstChunk: buf.readUInt32BE(p),
            samplesPerChunk: buf.readUInt32BE(p + 4),
            sdi: buf.readUInt32BE(p + 8),
        };
        p += 12;
    }
    return entries;
}

function getLengthSize(buf, stblKids) {
    const stsd = stblKids.find((b) => b.type === 'stsd');
    if (!stsd) return 4;
    let p = stsd.payload + 4;
    const entryCount = buf.readUInt32BE(p); p += 4;
    const visual = new Set(['avc1', 'avc3', 'avc2', 'avc4', 'hvc1', 'hev1']);
    for (let e = 0; e < entryCount; e++) {
        const size = buf.readUInt32BE(p);
        const type = buf.toString('latin1', p + 4, p + 8);
        if (size < 8) break;
        const entryStart = p;
        const entryEnd = p + size;
        if (visual.has(type)) {
            // VisualSampleEntry 固定头 86 字节，之后是子盒(avcC...)
            let c = entryStart + 86;
            while (c + 8 <= entryEnd) {
                const cs = buf.readUInt32BE(c);
                if (cs < 8) break;
                if (buf.toString('latin1', c + 4, c + 8) === 'avcC') {
                    return (buf[c + 8 + 4] & 0x03) + 1; // 第 5 字节低 2 位 lengthSizeMinusOne
                }
                c += cs;
            }
            return 4;
        }
        p = entryEnd;
    }
    return 4;
}

function buildSampleOffsets(sizes, chunkOffsets, stscEntries) {
    const samples = [];
    let sampleIdx = 0;
    for (let ci = 0; ci < chunkOffsets.length && sampleIdx < sizes.length; ci++) {
        const chunkNum = ci + 1;
        let entry = stscEntries[0];
        for (const e of stscEntries) {
            if (e.firstChunk <= chunkNum) entry = e; else break;
        }
        let offset = chunkOffsets[ci];
        for (let k = 0; k < entry.samplesPerChunk && sampleIdx < sizes.length; k++) {
            const size = sizes[sampleIdx];
            samples.push({ offset, size });
            offset += size;
            sampleIdx++;
        }
    }
    return samples;
}

function getVideoSamples(buf) {
    const top = readBoxes(buf, 0, buf.length);
    const moov = top.find((b) => b.type === 'moov');
    if (!moov) throw new Error('moov 盒未找到（不是有效 MP4）');
    const moovKids = readBoxes(buf, moov.payload, moov.end);
    for (const trak of moovKids.filter((b) => b.type === 'trak')) {
        const trakKids = readBoxes(buf, trak.payload, trak.end);
        const mdia = trakKids.find((b) => b.type === 'mdia');
        if (!mdia) continue;
        const mdiaKids = readBoxes(buf, mdia.payload, mdia.end);
        const hdlr = mdiaKids.find((b) => b.type === 'hdlr');
        if (!hdlr) continue;
        if (buf.toString('latin1', hdlr.payload + 8, hdlr.payload + 12) !== 'vide') continue;
        const minf = mdiaKids.find((b) => b.type === 'minf');
        if (!minf) continue;
        const minfKids = readBoxes(buf, minf.payload, minf.end);
        const stbl = minfKids.find((b) => b.type === 'stbl');
        if (!stbl) continue;
        const stblKids = readBoxes(buf, stbl.payload, stbl.end);
        const stsz = stblKids.find((b) => b.type === 'stsz');
        const stco = stblKids.find((b) => b.type === 'stco') || stblKids.find((b) => b.type === 'co64');
        const stsc = stblKids.find((b) => b.type === 'stsc');
        if (!stsz || !stco || !stsc) continue;
        const lengthSize = getLengthSize(buf, stblKids);
        const sizes = parseStsz(buf, stsz);
        const chunkOffsets = parseChunkOffsets(buf, stco);
        const stscEntries = parseStsc(buf, stsc);
        return { samples: buildSampleOffsets(sizes, chunkOffsets, stscEntries), lengthSize };
    }
    throw new Error('未找到视频轨（handler=vide）');
}

/* ======================= NAL: CEI / patch / AES ======================= */

function readUIntN(buf, off, n) {
    let v = 0;
    for (let i = 0; i < n; i++) v = v * 256 + buf[off + i];
    return v;
}

function parseCeiKid(buf, nal, len) {
    if (len < 19 || buf[nal] !== 0x06 || buf[nal + 1] !== 0x05) return null;
    for (let i = 0; i < 16; i++) if (buf[nal + 3 + i] !== CEI_UUID[i]) return null;
    const p = nal + 19;
    const plen = len - 19;
    if (plen < 7) return null;
    const b0 = buf[p];
    if (b0 !== 0x82 && b0 !== 0x83) return null;
    const flags = buf[p + 2];
    const v16 = flags & 0x0f;
    let off = (flags & 8) ? 4 : 3;
    off += 4 * (v16 & 4) + ((v16 >> 1) & 1);
    if (v16 & 1) off += 1;
    while (off + 2 <= plen) {
        const tag = buf[p + off];
        const l = buf[p + off + 1];
        if (off + 2 + l > plen) break;
        if (tag === 0x49) { // 'I'
            const n = Math.min(l, 64);
            return buf.toString('latin1', p + off + 2, p + off + 2 + n);
        }
        off += 2 + l;
    }
    return null;
}

function patchCei(buf, nal, len) {
    if (len < 5) return;
    buf[nal] = 0x06;
    buf[nal + 1] = 0x03;
    buf[nal + 2] = (len - 4) & 0xff;
    buf.fill(0xff, nal + 3, nal + len);
}

function decryptNal(buf, nal, len, key) {
    if (len <= 49 || !key) return false;
    const decipher = crypto.createDecipheriv('aes-128-ecb', key, null);
    decipher.setAutoPadding(false);
    const prev = Buffer.from(buf.subarray(nal + 16, nal + 32));
    let pos = 32;
    let remain = len - 32;
    while (remain > 0) {
        if (remain <= 16) break;
        const ct = Buffer.from(buf.subarray(nal + pos, nal + pos + 16));
        const pt = decipher.update(ct);
        for (let i = 0; i < 16; i++) buf[nal + pos + i] = pt[i] ^ prev[i];
        ct.copy(prev);
        pos += 16; remain -= 16;
        const skip = remain < 144 ? remain : 144;
        pos += skip; remain -= skip;
    }
    return true;
}

function forEachNal(buf, sample, lengthSize, cb) {
    let p = sample.offset;
    const end = sample.offset + sample.size;
    while (p + lengthSize <= end) {
        const n = readUIntN(buf, p, lengthSize);
        const nal = p + lengthSize;
        if (n < 1 || nal + n > end) break;
        if (cb(nal, n) === false) return;
        p = nal + n;
    }
}

/* ============================ 流水线主流程 ============================ */

function isMp4File(file) {
    let fd;
    try {
        fd = fs.openSync(file, 'r');
        const b = Buffer.alloc(8);
        const got = fs.readSync(fd, b, 0, 8, 0);
        return got === 8 && b.toString('latin1', 4, 8) === 'ftyp';
    } catch { return false; }
    finally { if (fd !== undefined) fs.closeSync(fd); }
}

function remuxToMp4(input, tmpPath, quiet) {
    const args = ['-y', '-i', input, '-map', '0', '-c', 'copy', '-movflags', '+faststart', '-f', 'mp4', tmpPath];
    if (quiet) args.unshift('-loglevel', 'error');
    const r = spawnSync('ffmpeg', args, { stdio: quiet ? 'ignore' : 'inherit' });
    if (r.error) throw new Error('无法执行 ffmpeg（未安装或不在 PATH）: ' + r.error.message);
    if (r.status !== 0) throw new Error('ffmpeg remux 失败，退出码 ' + r.status);
}

function usage() {
    process.stderr.write(
        'usage: node udrm-dec.cjs <input.(ts|mp4)> <output.mp4> [--key HEX] [-q] [-r]\n' +
        '  --key HEX       32 位十六进制 CEK（优先于本地表/服务器；--key-hex 为同义别名）\n' +
        '  -q, --quiet     静默 ffmpeg\n' +
        '  -r, --refresh   强制刷新：跳过本地表，直接向 license 服务器取 CEK（取到仍覆盖写回本地表）\n' +
        '  无 --key 时：按 CEI 的 kid 依次取 CEK：本地表 -> license 服务器，\n' +
        '             服务器取到的 CEK 写回本地表；内置表仅在本地表文件不存在时落盘作种子\n'
    );
}

function parseArgs(argv) {
    const o = { input: null, output: null, key: null, quiet: false, refresh: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '-q' || a === '--quiet') o.quiet = true;
        else if (a === '-r' || a === '--refresh') o.refresh = true;
        else if (a === '--key' || a === '--key-hex') {
            const v = argv[++i];
            if (!v || !HEX32_RE.test(v)) throw new Error(`${a} 需要 32 位十六进制 CEK`);
            o.key = Buffer.from(v, 'hex');
        } else if (a === '-h' || a === '--help') { usage(); process.exit(0); }
        else if (!o.input) o.input = a;
        else if (!o.output) o.output = a;
        else { usage(); throw new Error('多余参数: ' + a); }
    }
    if (!o.input || !o.output) { usage(); throw new Error('缺少输入或输出'); }
    return o;
}

async function main() {
    const opt = parseArgs(process.argv.slice(2));
    const log = (m) => process.stderr.write(m + '\n');

    // ---- 第 1 段：必要时 ffmpeg remux 成 MP4 ----
    let mp4Path = opt.input;
    let tmp = null;
    if (!isMp4File(opt.input)) {
        tmp = path.join(os.tmpdir(), `udrm-stage-${process.pid}-${Date.now()}.mp4`);
        log(`[1/2] ffmpeg 重新封装: ${opt.input} -> MP4`);
        remuxToMp4(opt.input, tmp, opt.quiet);
        mp4Path = tmp;
    } else {
        log(`[1/2] 输入已是 MP4，跳过 remux`);
    }

    try {
        const buf = fs.readFileSync(mp4Path);
        const { samples, lengthSize } = getVideoSamples(buf);
        log(`[2/2] 视频 sample: ${samples.length}, 长度前缀: ${lengthSize} 字节`);

        // pass 1：收集所有 CEI kid（保持出现顺序）
        const kids = [];
        const seen = new Set();
        for (const s of samples) {
            forEachNal(buf, s, lengthSize, (nal, n) => {
                if ((buf[nal] & 0x1f) !== 6) return;
                const kid = parseCeiKid(buf, nal, n);
                if (kid && !seen.has(kid)) { seen.add(kid); kids.push(kid); }
            });
        }

        // 解析 CEK：--key > 本地表 > license 服务器；带 -r 时 --key > license 服务器
        // 内置表不参与取值，只在首次运行时落盘成种子
        const keyForKid = new Map();
        if (opt.key) {
            log(`使用 --key 指定的 CEK`);
        } else {
            // 首次运行先把内置种子表写入本地表，保证下面的读取能命中这些 kid
            const seed = seedLocalKeys();
            if (seed.seeded) log(`  首次运行：内置种子表已写入 ${seed.file}（${seed.count} 条）`);
            else if (seed.error) log(`  !! 种子表写入失败 ${seed.file}: ${seed.error}`);

            const localKeys = loadLocalKeys();
            const useLocal = !opt.refresh; // -r：即使本地表有记录也重新向服务器取
            if (!useLocal) log(`  本次因 -r 强制刷新，跳过本地表，走 license 服务器`);
            let dirty = false;
            for (const kid of kids) {
                let key = null;
                let src = '';
                const local = useLocal ? tableStringToCek(localKeys[kid]) : null;
                if (local) {
                    key = local; src = '本地表';
                } else {
                    try {
                        const r = await fetchCek(kid);
                        key = r.cek; src = 'license 服务器';
                    } catch (e) {
                        log(`  取 CEK 失败(${kid}): ${e.message}`);
                    }
                }
                if (key) {
                    if (key.length !== 16) log(`  !! 注意: CEK 长度为 ${key.length} 字节（非 16）`);
                    keyForKid.set(kid, key);
                    log(`  CEK(${kid}) = ${key.toString('hex')}  <- ${src}`);
                    // 服务器取到的 CEK 一律以兜底表格式写回（覆盖旧值）
                    if (src === 'license 服务器') {
                        const s = cekToTableString(key);
                        if (localKeys[kid] !== s) { localKeys[kid] = s; dirty = true; }
                    }
                } else {
                    log(`  !! 无可用 CEK: ${kid}`);
                }
            }
            if (dirty) {
                const r = saveLocalKeys(localKeys);
                if (r.ok) log(`  已写入本地兜底表(${Object.keys(localKeys).length} 条): ${r.file}`);
                else log(`  !! 本地表写入失败 ${r.file}: ${r.error}`);
            }
        }

        // pass 2：patch CEI + 解密 slice，原地改写
        let curKey = opt.key || null;
        let patched = 0, decrypted = 0, slices = 0;
        for (const s of samples) {
            forEachNal(buf, s, lengthSize, (nal, n) => {
                const type = buf[nal] & 0x1f;
                if (type === 6) {
                    const kid = parseCeiKid(buf, nal, n);
                    if (kid) {
                        if (!opt.key) curKey = keyForKid.get(kid) || null;
                        patchCei(buf, nal, n);
                        patched++;
                    }
                } else if (type === 1 || type === 5) {
                    slices++;
                    if (curKey && decryptNal(buf, nal, n, curKey)) decrypted++;
                }
            });
        }

        fs.writeFileSync(opt.output, buf);
        log(`完成: CEI patch ${patched}, 解密 NAL ${decrypted}/${slices} -> ${opt.output}`);

        if (slices > 0 && decrypted === 0) {
            log('错误: 未解密任何 NAL（无可用 CEK），输出仍为密文');
            process.exitCode = 1;
        }
    } finally {
        if (tmp) { try { fs.unlinkSync(tmp); } catch { /* ignore */ } }
    }
}

if (require.main === module) {
    main().catch((e) => {
        process.stderr.write('错误: ' + (e && e.message ? e.message : e) + '\n');
        process.exit(1);
    });
}

module.exports = {
    sm3, buildRequest, deriveCek, fetchCek, getVideoSamples,
    keysFilePath, loadLocalKeys, saveLocalKeys, cekToTableString, tableStringToCek,
};
