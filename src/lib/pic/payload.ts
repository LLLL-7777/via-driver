/*
 * 传图能力层 · 组包（条带划分 + 压缩载荷 + 帧耗时估算）
 *
 * 搬运自 pic-uploader/index.html:773-1047，逻辑一字未改。
 *
 * 载荷布局（协议 v6）：
 *   [format=3 时：512 B 调色板 256×u16 小端]
 *   [每帧: n_strips × u16 条带长度表][各条带数据首尾相接]
 *   长度高一位 = 1 ⇒ 该条带压不动，直存原始（永不膨胀）
 */

import {lz4Compress} from './lz4';
import {buildIndexLUT, buildPalette, toIndices} from './palette';
import type {PicFrame, PicPayload} from './types';

/*
 * ⭐ 2026-10-28 决策：不再按「硬件能力」抽帧，改为**保留全部帧、按素材原延时播放**
 * 实现方式：把读速估得远高于实际 ⇒ estimateFrameMs 偏小 ⇒ byTime 很大 ⇒ 不抽帧。
 * ⚠️ 副作用：重素材会**慢放**（实测 2.1×）；轻素材由帧表延时主导，不受影响。
 * ⚠️ 要回到「保原速」：改回 721000（那个值实测预测 72.0 ms，真机 71.7 ms，误差 0.4%）。
 */
export const SPI_READ_BPS = 4000000;
export const BLIT_NS_PER_PX = 191;

/*
 * 一条带几行 —— 必须与固件同一套规则（固件在解析页头时会校验，两端不一致
 * 会被判为无效图）。规则：行数 × 宽 × 2 ≤ 10,240，且必须整除帧高。
 */
export function pickStripRows(w: number, h: number): number {
  const BUF = 10240;
  let rows = Math.floor(BUF / (w * 2));
  if (rows < 1) return 0;
  while (rows > 1 && h % rows !== 0) rows--;
  return rows;
}

/* 估算"压缩后"的单帧耗时（只采 3 帧，够抽帧决策用） */
export function estimateFrameMs(
  rawFrames: Pick<PicFrame, 'bytes'>[],
  w: number,
  h: number,
): {ms: number; compBytes: number} {
  const rows = pickStripRows(w, h);
  if (!rows || rawFrames.length === 0) return {ms: 1000, compBytes: w * h};
  const nStrips = h / rows;
  const pxPerStrip = w * rows; /* 索引字节数 = 像素数（1 B/px） */
  const stride = Math.max(1, Math.floor(rawFrames.length / 3));

  /* 先按全部帧挑一次调色板（只影响抽帧判断的精度，不参与最终上传） */
  const pal = buildPalette(rawFrames, w, h);
  const lut = buildIndexLUT(pal);

  let compSum = 0;
  let picked = 0;
  for (let i = 0; i < rawFrames.length && picked < 3; i += stride) {
    const fb = rawFrames[i].bytes;
    for (let s = 0; s < nStrips; s++) {
      const idx = toIndices(fb, s * pxPerStrip, pxPerStrip, lut);
      const c = lz4Compress(idx).length;
      compSum += Math.min(c, idx.length);
    }
    picked++;
  }
  if (!picked) return {ms: 1000, compBytes: w * h};
  const perFrameComp = compSum / picked;
  const readMs = (perFrameComp / SPI_READ_BPS) * 1000;
  const blitMs = (w * h * BLIT_NS_PER_PX) / 1e6;
  return {ms: readMs + blitMs, compBytes: perFrameComp};
}

/*
 * 把若干帧拼成"压缩载荷"。
 *
 * ⚠️ 两条踩过的坑（都在 2026-10-28 修的）：
 *   1. 调色板模式下 totalBytes 必须从 512 起；无损模式必须从 0 起 ——
 *      否则前面多 512 B 垃圾，固件会把它当成第一帧的条带长度表 ⇒ 整帧花屏。
 *   2. use565 时**不能**调 buildPalette/buildIndexLUT：白跑约 150 ms。
 */
export function buildCompressedPayload(
  frames: PicFrame[],
  w: number,
  h: number,
  use565: boolean,
): PicPayload {
  const rows = pickStripRows(w, h);
  if (!rows) {
    throw new Error('尺寸不支持：宽 ' + w + ' 太大，一条带放不进缓冲');
  }
  const nStrips = h / rows;
  const pxPerStrip = w * rows; /* 像素数/条带（索引 1 B、RGB565 2 B） */

  let pal: Uint16Array | null = null;
  let lut: Uint8Array | null = null;
  let totalBytes = 0;
  let rawBytes = 0;

  if (!use565) {
    /* 调色板按**最终要传的这些帧**来挑，比按原始帧挑更贴合抽样后的内容 */
    pal = buildPalette(frames, w, h);
    lut = buildIndexLUT(pal);
    totalBytes = 512;
  }

  const perFrame: {table: Uint16Array; segs: Uint8Array[]; size: number}[] = [];

  for (const fr of frames) {
    const table = new Uint16Array(nStrips);
    const segs: Uint8Array[] = [];
    let size = nStrips * 2;
    for (let s = 0; s < nStrips; s++) {
      /* 两种数据来源，条带划分完全相同，只是每像素 1 B 还是 2 B：
       *   use565 = true  → 直接切 RGB565 原始字节（无损）
       *   use565 = false → 量化成 256 色索引（体积小） */
      const seg = use565
        ? fr.bytes.subarray(s * pxPerStrip * 2, (s + 1) * pxPerStrip * 2)
        : toIndices(fr.bytes, s * pxPerStrip, pxPerStrip, lut as Uint8Array);

      rawBytes += seg.length;
      const c = lz4Compress(seg);
      if (c.length < seg.length) {
        table[s] = c.length;
        segs.push(c);
        size += c.length;
      } else {
        table[s] = 0x8000 | seg.length; /* 压不动 → 直存原始（永不膨胀） */
        segs.push(seg);
        size += seg.length;
      }
    }
    perFrame.push({table, segs, size});
    totalBytes += size;
  }

  const payload = new Uint8Array(totalBytes);
  let o = 0;
  if (pal) {
    for (let i2 = 0; i2 < 256; i2++) {
      /* 调色板：256 × u16 RGB565（小端） */
      payload[o++] = pal[i2] & 0xff;
      payload[o++] = (pal[i2] >> 8) & 0xff;
    }
  }
  for (const f of perFrame) {
    for (let s = 0; s < nStrips; s++) {
      payload[o++] = f.table[s] & 0xff;
      payload[o++] = (f.table[s] >>> 8) & 0xff;
    }
    for (const seg of f.segs) {
      payload.set(seg, o);
      o += seg.length;
    }
  }
  return {
    payload,
    stripRows: rows,
    compBytes: totalBytes,
    rawBytes,
    palette: pal,
    format: use565 ? 1 : 3, /* 1 = RGB565 无损；3 = 256 色调色板 */
  };
}
