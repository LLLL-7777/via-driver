/*
 * 能力层等价性校验（B1 的验收脚本）
 *
 * 做什么：
 *   1. 从 `../pic-uploader/index.html` 里把**旧实现的函数**抽出来（就是线上跑的那份）
 *   2. import 新的 TS 实现 `src/lib/pic/`
 *   3. 用同一组输入跑两边，**逐字节**比对
 *
 * 为什么必须比对而不是"看着一样"：
 *   传图已经验过是字节级正确的（format=1 无损、format=3 调色板、GIF 自解析）。
 *   搬代码时任何一处细微改动（少一次 >>>、变量顺序、默认值），
 *   表现都是"花屏 / 传一半失败 / 颜色偏"，且极难定位。
 *
 * 运行： npx tsx scripts/verify-pic-lib.ts
 * 退出码 0 = 全过；1 = 有差异（会打印第一处不同）
 */

import fs from 'node:fs';
import path from 'node:path';

import * as NEW from '../src/lib/pic/index';

/* ============================================================
 * 1. 抽出旧实现
 * ============================================================ */
const root = path.resolve(__dirname, '..');
const htmlPath = path.resolve(root, '..', 'pic-uploader', 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');

const codeStart = html.indexOf('const CRC_TABLE');
const codeEnd = html.indexOf('const app = {');
if (codeStart < 0 || codeEnd < 0) {
  console.error('[FATAL] 无法在 index.html 里定位能力层范围（const CRC_TABLE / const app = {）');
  process.exit(1);
}
const legacyCode = html.slice(codeStart, codeEnd);

const factory = new Function(
  legacyCode +
    `
return {
  crc32, encodeFrame, parseAck, makeBeginPayload, makeFrameTable,
  lz4Compress, pickStripRows, buildPalette, buildIndexLUT, toIndices,
  estimateFrameMs, buildCompressedPayload, gifDecode,
  PicProtocol, SerialTransport,
  PROTO_VERSION, PIC_DATA_OFFSET, SPI_READ_BPS
};`,
);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const OLD: any = factory();

/* ============================================================
 * 2. 工具
 * ============================================================ */
let pass = 0;
let fail = 0;
const failures: string[] = [];

function ok(name: string) {
  pass++;
  console.log('  ok   ' + name);
}

function bad(name: string, detail: string) {
  fail++;
  failures.push(name + ' :: ' + detail);
  console.log('  FAIL ' + name + '\n       ' + detail);
}

/* 确定性的伪随机（同一个 seed ⇒ 两边拿到同一份数据） */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function bytesEqual(a: Uint8Array, b: Uint8Array): string | null {
  if (a.length !== b.length) {
    return '长度不同：new=' + a.length + ' legacy=' + b.length;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return '第 ' + i + ' 字节不同：new=0x' + a[i].toString(16) + ' legacy=0x' + b[i].toString(16);
    }
  }
  return null;
}

function hex(b: Uint8Array, n = 24): string {
  let s = '';
  for (let i = 0; i < Math.min(n, b.length); i++) {
    s += b[i].toString(16).padStart(2, '0');
  }
  return s + (b.length > n ? '…' : '');
}

/* ============================================================
 * 3. 构造测试帧（RGB565 小端）
 * ============================================================ */
function makeFrame(w: number, h: number, kind: 'solid' | 'grad' | 'photo' | 'noise', seed: number): Uint8Array {
  const out = new Uint8Array(w * h * 2);
  const r = rng(seed);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let c: number;
      if (kind === 'solid') {
        c = 0x1f00; /* 固定色 */
      } else if (kind === 'grad') {
        c = (((x * 31) / (w - 1)) << 11) | (((y * 63) / (h - 1)) << 5) | 0x10;
      } else if (kind === 'photo') {
        /* 近似照片：低频渐变 + 轻微抖动（GIF 调色板抖动的特征） */
        const base =
          ((((x * 31) / (w - 1)) | 0) << 11) |
          ((((y * 63) / (h - 1)) | 0) << 5) |
          ((((x + y) * 31) / (w + h - 2) | 0) & 31);
        const jit = ((r() * 6) | 0) - 3;
        c = (base + jit) & 0xffff;
      } else {
        c = ((r() * 65536) | 0) & 0xffff;
      }
      const o = (y * w + x) * 2;
      out[o] = c & 0xff;
      out[o + 1] = (c >> 8) & 0xff;
    }
  }
  return out;
}

/* ============================================================
 * 4. 各项比对
 * ============================================================ */
console.log('\n=== B1 能力层等价性校验 ===');
console.log('旧实现来源: ' + htmlPath + '（抽取 ' + legacyCode.length + ' 字符）\n');

console.log('[1] 常量');
for (const k of ['PROTO_VERSION', 'PIC_DATA_OFFSET', 'SPI_READ_BPS']) {
  const a = (NEW as any)[k];
  const b = OLD[k];
  if (a === b) ok(k + ' = ' + a);
  else bad(k, 'new=' + a + ' legacy=' + b);
}

console.log('\n[2] crc32');
{
  const r = rng(1);
  const cases: Uint8Array[] = [
    new Uint8Array(0),
    new Uint8Array([0]),
    Uint8Array.from({length: 1000}, () => (r() * 256) | 0),
    Uint8Array.from({length: 153600}, () => (r() * 256) | 0),
  ];
  let allOk = true;
  for (const c of cases) {
    const a = NEW.crc32(c);
    const b = OLD.crc32(c);
    if (a !== b) {
      allOk = false;
      bad('crc32(len=' + c.length + ')', 'new=' + a + ' legacy=' + b);
    }
  }
  if (allOk) ok('4 组长度（0 / 1 / 1000 / 153600）全部一致');
}

console.log('\n[3] 帧编解码');
{
  const payload = Uint8Array.from({length: 20}, (_, i) => i * 7);
  const a = NEW.encodeFrame(0x02, payload);
  const b = OLD.encodeFrame(0x02, payload);
  const d = bytesEqual(a, b);
  if (!d) ok('encodeFrame 一致（' + a.length + ' B）');
  else bad('encodeFrame', d);

  const a2 = NEW.encodeFrame(0x7f, null);
  const b2 = OLD.encodeFrame(0x7f, null);
  const d2 = bytesEqual(a2, b2);
  if (!d2) ok('encodeFrame(空载荷) 一致');
  else bad('encodeFrame(空载荷)', d2);

  const ackBytes = Uint8Array.from({length: 12}, (_, i) => (i * 13 + 5) & 0xff);
  const pa = NEW.parseAck(ackBytes, 0);
  const pb = OLD.parseAck(ackBytes, 0);
  if (JSON.stringify(pa) === JSON.stringify(pb)) ok('parseAck 一致 ' + JSON.stringify(pa));
  else bad('parseAck', JSON.stringify(pa) + ' vs ' + JSON.stringify(pb));

  /* BREAK 载荷：多尺寸 × 两种 format */
  let beginOk = true;
  for (const [w, h, frames, rows, fmt] of [
    [160, 120, 1, 30, 1],
    [320, 240, 24, 16, 3],
    [240, 180, 6, 20, 2],
  ] as const) {
    const a3 = NEW.makeBeginPayload(123456, 0xdeadbeef, w, h, frames, rows, fmt);
    const b3 = OLD.makeBeginPayload(123456, 0xdeadbeef, w, h, frames, rows, fmt);
    const d3 = bytesEqual(a3, b3);
    if (d3) {
      beginOk = false;
      bad('makeBeginPayload ' + w + 'x' + h + ' fmt=' + fmt, d3);
    }
  }
  if (beginOk) ok('makeBeginPayload 3 组尺寸/格式一致');

  /* 帧表：数字、数组、超范围（0 与 70000 都被夹到 1 与 65535） */
  let tblOk = true;
  for (const delays of [30, [10, 20, 30], [0, 70000, 16.7]]) {
    const a4 = NEW.makeFrameTable(delays as number | number[]);
    const b4 = OLD.makeFrameTable(delays as number | number[]);
    const d4 = bytesEqual(a4, b4);
    if (d4) {
      tblOk = false;
      bad('makeFrameTable ' + JSON.stringify(delays), d4);
    }
  }
  if (tblOk) ok('makeFrameTable 3 组（含 0 / 70000 / 小数夹取）一致');
}

console.log('\n[4] lz4Compress');
{
  const cases: [string, Uint8Array][] = [
    ['空', new Uint8Array(0)],
    ['1 字节', Uint8Array.from([7])],
    ['13 字节（刚好 mflimit 边界）', Uint8Array.from({length: 13}, (_, i) => i)],
    ['纯色 4800', new Uint8Array(4800).fill(0x11)],
    ['渐变 4800', makeFrame(160, 30, 'grad', 3).subarray(0, 4800)],
    ['照片类 9600', makeFrame(160, 30, 'photo', 4)],
    ['噪声 9600', makeFrame(160, 30, 'noise', 5)],
  ];
  let allOk = true;
  for (const [name, src] of cases) {
    const a = NEW.lz4Compress(src);
    const b = OLD.lz4Compress(src);
    const d = bytesEqual(a, b);
    if (d) {
      allOk = false;
      bad('lz4 ' + name + '（' + src.length + ' B）', d);
    }
  }
  if (allOk) ok('7 组数据全部一致（含边界/纯色/噪声）');
}

console.log('\n[5] pickStripRows');
{
  let allOk = true;
  for (const [w, h] of [
    [160, 120],
    [200, 150],
    [240, 180],
    [320, 240],
    [160, 90],
  ] as const) {
    const a = NEW.pickStripRows(w, h);
    const b = OLD.pickStripRows(w, h);
    if (a !== b) {
      allOk = false;
      bad('pickStripRows ' + w + 'x' + h, 'new=' + a + ' legacy=' + b);
    }
  }
  if (allOk) ok('5 组尺寸一致（含固件同款条带规则）');
}

console.log('\n[6] 调色板 / LUT / 索引');
{
  const r = rng(9);
  /* 用 3 帧照片类素材（颜色数 > 256，会触发中位切分） */
  const frames = [0, 1, 2].map((i) => ({bytes: makeFrame(160, 120, 'photo', 10 + i), delay: 33}));

  const pa = NEW.buildPalette(frames, 160, 120);
  const pb = OLD.buildPalette(frames, 160, 120);
  const d1 = bytesEqual(new Uint8Array(pa.buffer), new Uint8Array(pb.buffer));
  if (!d1) ok('buildPalette 一致（中位切分路径）');
  else bad('buildPalette', d1);

  /* 颜色数 ≤ 256 的素材（GIF 常见）：走"直接取原色"分支 */
  const few = [{bytes: makeFrame(160, 120, 'grad', 11), delay: 33}];
  const pa2 = NEW.buildPalette(few, 160, 120);
  const pb2 = OLD.buildPalette(few, 160, 120);
  const d2 = bytesEqual(new Uint8Array(pa2.buffer), new Uint8Array(pb2.buffer));
  if (!d2) ok('buildPalette 一致（≤256 色直取路径）');
  else bad('buildPalette(≤256)', d2);

  const la = NEW.buildIndexLUT(pa);
  const lb = OLD.buildIndexLUT(pb);
  const d3 = bytesEqual(la, lb);
  if (!d3) ok('buildIndexLUT 一致（32768 项）');
  else bad('buildIndexLUT', d3);

  const ia = NEW.toIndices(frames[0].bytes, 100, 3000, la);
  const ib = OLD.toIndices(frames[0].bytes, 100, 3000, lb);
  const d4 = bytesEqual(ia, ib);
  if (!d4) ok('toIndices 一致（偏移 100 / 长 3000）');
  else bad('toIndices', d4);
  void r;
}

console.log('\n[7] buildCompressedPayload（核心：字节级载荷）');
{
  const sizes: [number, number][] = [
    [160, 120],
    [200, 150],
    [240, 180],
    [320, 240],
  ];
  const kinds: ('solid' | 'grad' | 'photo' | 'noise')[] = ['solid', 'grad', 'photo', 'noise'];
  let allOk = true;
  let n = 0;
  for (const [w, h] of sizes) {
    for (const kind of kinds) {
      for (const use565 of [true, false]) {
        const frames = [0, 1].map((i) => ({bytes: makeFrame(w, h, kind, 100 + i), delay: 33}));
        const a = NEW.buildCompressedPayload(frames, w, h, use565);
        const b = OLD.buildCompressedPayload(frames, w, h, use565);
        n++;
        const d = bytesEqual(a.payload, b.payload);
        if (d) {
          allOk = false;
          bad(
            'payload ' + w + 'x' + h + ' ' + kind + (use565 ? ' format=1' : ' format=3'),
            d + '（前 24 B new=' + hex(a.payload) + ' legacy=' + hex(b.payload) + '）',
          );
          continue;
        }
        if (a.stripRows !== b.stripRows || a.format !== b.format || a.compBytes !== b.compBytes || a.rawBytes !== b.rawBytes) {
          allOk = false;
          bad(
            'payload 元数据 ' + w + 'x' + h + ' ' + kind,
            JSON.stringify({stripRows: a.stripRows, format: a.format, comp: a.compBytes, raw: a.rawBytes}) +
              ' vs ' +
              JSON.stringify({stripRows: b.stripRows, format: b.format, comp: b.compBytes, raw: b.rawBytes}),
          );
        }
      }
    }
  }
  if (allOk) ok(n + ' 组（4 尺寸 × 4 素材 × 2 格式）载荷逐字节一致');
}

console.log('\n[8] estimateFrameMs');
{
  let allOk = true;
  for (const [w, h] of [
    [160, 120],
    [320, 240],
  ] as const) {
    const frames = [0, 1, 2].map((i) => ({bytes: makeFrame(w, h, 'photo', 200 + i), delay: 33}));
    const a = NEW.estimateFrameMs(frames, w, h);
    const b = OLD.estimateFrameMs(frames, w, h);
    if (a.ms !== b.ms || a.compBytes !== b.compBytes) {
      allOk = false;
      bad('estimateFrameMs ' + w + 'x' + h, JSON.stringify(a) + ' vs ' + JSON.stringify(b));
    }
  }
  if (allOk) ok('2 组尺寸一致（浮点严格相等）');
}

/* 第 9、10 项要 await，包进 async 函数（本文件按 CJS 执行，不支持顶层 await） */
async function main() {
console.log('\n[9] upload 全流程（mock 设备，比对发出的每一条字节）');
{
  /*
   * 假设备：收到什么就按协议回什么。
   * 两边（旧/新 PicProtocol）跑同一个 mock 逻辑，只要发送节奏有任何不同，
   * 记录的 write 序列就会不等 —— 这比只比对最终载荷更严格。
   */
  class MockTransport {
    sent: Uint8Array[] = [];
    private acks: any[] = [];
    private written = 0;
    constructor(private total: number) {}

    async write(bytes: Uint8Array) {
      this.sent.push(bytes.slice());
      const cmd = bytes[0];
      if (cmd === 0x01) {
        /* BEGIN：先报 2 条擦除进度，再 READY */
        this.acks.push({status: 0x08, written: 1000, credit: 0, echo: 0, aux: 0});
        this.acks.push({status: 0x08, written: 50000, credit: 0, echo: 0, aux: 0});
        this.acks.push({status: 0x7f, written: 0, credit: 2048, echo: 0x01, aux: 0x281c});
        this.written = 0;
      } else if (cmd === 0x06) {
        this.acks.push({status: 0x00, written: 0, credit: 0, echo: 0x06, aux: 0});
      } else if (cmd === 0x02) {
        const off = bytes[5] | (bytes[6] << 8) | (bytes[7] << 16) | (bytes[8] << 24);
        const n = bytes.length - 5 - 4;
        this.written = Math.max(this.written, off + n);
        this.acks.push({status: 0x00, written: this.written, credit: 2048, echo: 0, aux: 0});
      } else if (cmd === 0x03) {
        this.acks.push({status: 0x00, written: this.total, credit: 0, echo: 0x03, aux: 0});
      } else {
        this.acks.push({status: 0x00, written: 0, credit: 0, echo: cmd, aux: 0});
      }
    }
    takeAll() {
      const o = this.acks;
      this.acks = [];
      return o;
    }
    async waitArrival() {
      return true;
    }
  }

  const w = 160;
  const h = 120;
  const frames = [0, 1].map((i) => ({bytes: makeFrame(w, h, 'photo', 300 + i), delay: 33}));
  const built = NEW.buildCompressedPayload(frames, w, h, false);
  const crc = NEW.crc32(built.payload);

  const mtOld = new MockTransport(built.payload.length);
  const mtNew = new MockTransport(built.payload.length);
  const protoOld = new OLD.PicProtocol(mtOld, () => {});
  const protoNew = new NEW.PicProtocol(mtNew as any, () => {});

  await protoOld.upload(built.payload, crc, w, h, [33, 33], built.stripRows, built.format);
  await protoNew.upload(built.payload, crc, w, h, [33, 33], built.stripRows, built.format);

  if (mtOld.sent.length !== mtNew.sent.length) {
    bad('upload 命令条数', 'new=' + mtNew.sent.length + ' legacy=' + mtOld.sent.length);
  } else {
    let allOk = true;
    for (let i = 0; i < mtOld.sent.length; i++) {
      const d = bytesEqual(mtNew.sent[i], mtOld.sent[i]);
      if (d) {
        allOk = false;
        bad('upload 第 ' + i + ' 条命令', d);
        break;
      }
    }
    if (allOk) ok('upload 发出的 ' + mtOld.sent.length + ' 条命令逐字节一致（含 BEGIN/FRAMES/DATA/COMMIT）');
  }
}

console.log('\n[10] gifDecode（真实素材）');
{
  const candidates = [
    path.join(process.env.USERPROFILE || '', 'Desktop', '捂嘴猫.gif'),
    path.join(process.env.USERPROFILE || '', 'Desktop', 'npQ8pps-driqXfZ49T3cShs-a0.gif'),
    path.resolve(root, 'dist', 'images', '_0.gif'),
  ];
  const found = candidates.filter((p) => p && fs.existsSync(p));
  if (found.length === 0) {
    console.log('  skip 找不到 GIF 素材（跳过；不影响其它项结论）');
  }
  for (const p of found) {
    const bytes = new Uint8Array(fs.readFileSync(p));
    const collectOld: {rgba: Uint8ClampedArray; delayMs: number; index: number; w: number; h: number}[] = [];
    const collectNew: {rgba: Uint8ClampedArray; delayMs: number; index: number; w: number; h: number}[] = [];

    let metaOld: any = null;
    let metaNew: any = null;
    try {
      metaOld = OLD.gifDecode(bytes, (fr: any) =>
        collectOld.push({rgba: fr.rgba.slice(), delayMs: fr.delayMs, index: fr.index, w: fr.width, h: fr.height}),
      );
    } catch (e: any) {
      bad('gifDecode legacy 抛错 ' + path.basename(p), e.message);
      continue;
    }
    try {
      metaNew = NEW.gifDecode(bytes, (fr) =>
        collectNew.push({rgba: fr.rgba.slice(), delayMs: fr.delayMs, index: fr.index, w: fr.width, h: fr.height}),
      );
    } catch (e: any) {
      bad('gifDecode new 抛错 ' + path.basename(p), e.message);
      continue;
    }

    const name = path.basename(p) + '（' + (bytes.length / 1024).toFixed(0) + ' KB）';
    if (metaOld.frames !== metaNew.frames) {
      bad('gifDecode 帧数 ' + name, 'new=' + metaNew.frames + ' legacy=' + metaOld.frames);
      continue;
    }
    let diffPx = 0;
    let firstBad = '';
    for (let i = 0; i < collectOld.length; i++) {
      const a = collectNew[i];
      const b = collectOld[i];
      if (a.delayMs !== b.delayMs) {
        firstBad = '第 ' + i + ' 帧延时不同 new=' + a.delayMs + ' legacy=' + b.delayMs;
        break;
      }
      const d = bytesEqual(new Uint8Array(a.rgba.buffer), new Uint8Array(b.rgba.buffer));
      if (d) {
        diffPx++;
        if (!firstBad) firstBad = '第 ' + i + ' 帧 ' + d;
      }
    }
    if (firstBad) bad('gifDecode ' + name, firstBad);
    else ok('gifDecode ' + name + '：' + metaNew.frames + ' 帧 / 逐像素 0 差异');
  }
}

/* ============================================================
 * 5. 汇总
 * ============================================================ */
console.log('\n=== 结果 ===');
console.log('  通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail) {
  console.log('\n差异清单：');
  for (const f of failures) console.log('  · ' + f);
  console.log('\n⚠️ 有差异说明搬运时改变了行为，必须先修再继续 B2。');
  process.exit(1);
}
console.log('\n✅ 能力层与 pic-uploader 完全等价（逐字节）。');
}

void main();
