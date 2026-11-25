/*
 * 传图能力层 · 调色板（256 色）
 *
 * 搬运自 pic-uploader/index.html:799-917，逻辑一字未改。
 *
 * 为什么放弃固定的 RGB332 网格：那个网格是"红 8 级 × 绿 8 级 × 蓝 4 级"，
 * 256 色均匀铺满整个色彩空间，而素材实际用色往往集中在少数区间
 * ⇒ 渐变出现色带、中间调偏色（实测通道 RMSE 4.30，肉眼可见）。
 * 改成从素材里**挑出它真正在用的 256 色**：每个像素仍只存 1 字节索引，
 * 刷屏时查表还原。实测 RMSE 4.30 → 1.33。
 *
 * 调色板本身占载荷开头 512 B（256 × u16 RGB565）。
 */

import type {PicFrame} from './types';

/*
 * 从帧里统计直方图并挑出 ≤256 色。
 * 颜色本来就 ≤256 的素材（GIF 绝大多数如此）→ 直接取原色，**无损**；
 * 否则用中位切分（median cut）按像素数加权压缩到 256 色。
 */
export function buildPalette(
  frames: Pick<PicFrame, 'bytes'>[],
  w: number,
  h: number,
): Uint16Array {
  const hist = new Map<number, number>();
  const n = w * h;
  let budget = 400000; /* 采样上限，够用又不卡 */

  for (const fr of frames) {
    for (let p = 0; p < n; p += 2) {
      const k = fr.bytes[p * 2] | (fr.bytes[p * 2 + 1] << 8);
      hist.set(k, (hist.get(k) || 0) + 1);
      if (--budget <= 0) break;
    }
    if (budget <= 0) break;
  }

  const ents: {v: number; c: number}[] = [];
  for (const [v, c] of hist) ents.push({v, c});

  const pal = new Uint16Array(256);

  if (ents.length <= 256) {
    ents.sort((a, b) => b.c - a.c); /* 按用量排序，热色放前面 */
    for (let i = 0; i < ents.length; i++) pal[i] = ents[i].v;
    return pal;
  }

  /* --- 中位切分 --- */
  let boxes: {v: number; c: number}[][] = [ents];
  while (boxes.length < 256) {
    let bi = -1;
    let best = -1;
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      if (b.length < 2) continue;
      let tot = 0;
      for (const e of b) tot += e.c;
      if (tot > best) {
        best = tot;
        bi = i;
      }
    }
    if (bi < 0) break;

    const b = boxes[bi];
    /* 按"拉到 0..255 后的跨度"选通道，绿通道权重高（人眼最敏感） */
    let rmin = 31;
    let rmax = 0;
    let gmin = 63;
    let gmax = 0;
    let bmin = 31;
    let bmax = 0;
    for (const e of b) {
      const r = (e.v >> 11) & 31;
      const g = (e.v >> 5) & 63;
      const bb = e.v & 31;
      if (r < rmin) rmin = r;
      if (r > rmax) rmax = r;
      if (g < gmin) gmin = g;
      if (g > gmax) gmax = g;
      if (bb < bmin) bmin = bb;
      if (bb > bmax) bmax = bb;
    }
    const spanR = ((rmax - rmin) * 255) / 31;
    const spanG = (((gmax - gmin) * 255) / 63) * 1.2;
    const spanB = (((bmax - bmin) * 255) / 31) * 0.8;
    const ch = spanR >= spanG && spanR >= spanB ? 'r' : spanG >= spanB ? 'g' : 'b';
    const key = (v: number) =>
      ch === 'r' ? (v >> 11) & 31 : ch === 'g' ? (v >> 5) & 63 : v & 31;

    b.sort((x, y) => key(x.v) - key(y.v));

    /* 按**像素数**的加权中位数切，而不是按颜色个数切 */
    let half = 0;
    for (const e of b) half += e.c;
    half /= 2;
    let acc = 0;
    let mid = 1;
    for (let i = 0; i < b.length - 1; i++) {
      acc += b[i].c;
      if (acc >= half) {
        mid = i + 1;
        break;
      }
      mid = i + 2;
    }
    if (mid <= 0) mid = 1;
    if (mid >= b.length) mid = b.length - 1;

    boxes.splice(bi, 1, b.slice(0, mid), b.slice(mid));
  }

  for (let i = 0; i < boxes.length && i < 256; i++) {
    const b = boxes[i];
    let r = 0;
    let g = 0;
    let bb = 0;
    let tot = 0;
    for (const e of b) {
      r += ((e.v >> 11) & 31) * e.c;
      g += ((e.v >> 5) & 63) * e.c;
      bb += (e.v & 31) * e.c;
      tot += e.c;
    }
    if (!tot) continue;
    pal[i] =
      ((Math.round(r / tot) & 31) << 11) |
      ((Math.round(g / tot) & 63) << 5) |
      (Math.round(bb / tot) & 31);
  }
  return pal;
}

/*
 * 15 位色 → 调色板索引 的查找表（32768 项，一次建好，之后逐像素只查表）。
 * ⚠️ 32768 × 256 次距离计算约 150 ms —— 无损模式（format=1）**不要**调它。
 */
export function buildIndexLUT(pal: Uint16Array): Uint8Array {
  const lut = new Uint8Array(32768);
  for (let k = 0; k < 32768; k++) {
    const r = (k >> 10) & 31;
    const g5 = (k >> 5) & 31;
    const b = k & 31;
    const g6 = (g5 << 1) | (g5 >> 4); /* 5 位 → 6 位（对齐 R5G6B5 的绿） */
    let best = 0;
    let bd = Infinity;
    for (let i = 0; i < 256; i++) {
      const v = pal[i];
      const dr = r - ((v >> 11) & 31);
      const dg = g6 - ((v >> 5) & 63);
      const db = b - (v & 31);
      const d = dr * dr * 4 + dg * dg * 2 + db * db * 3; /* 近似人眼权重 */
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    lut[k] = best;
  }
  return lut;
}

/* RGB565 → 调色板索引（pxOff/pxLen 以像素为单位） */
export function toIndices(
  src565: Uint8Array,
  pxOff: number,
  pxLen: number,
  lut: Uint8Array,
): Uint8Array {
  const out = new Uint8Array(pxLen);
  let k = pxOff * 2;
  for (let i = 0; i < pxLen; i++, k += 2) {
    const v = src565[k] | (src565[k + 1] << 8);
    out[i] = lut[(((v >> 11) & 31) << 10) | ((((v >> 5) & 63) >> 1) << 5) | (v & 31)];
  }
  return out;
}
