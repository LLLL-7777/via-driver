/*
 * 传图能力层 · 图像层（任意图片 → RGB565 / GIF 拆帧）
 *
 * 搬运自 pic-uploader/index.html:588-656 与 1414-1505，逻辑一字未改。
 *
 * 用 <img> 而不是 createImageBitmap：<img> 会应用 JPEG 的 EXIF 方向，
 * 手机拍的竖图不会被转 90 度。
 *
 * ⚠️ 必须先填黑底再 drawImage：带透明通道的 PNG 若直接画到透明画布，
 *    取像素时会有 alpha 预乘偏差，颜色发暗。
 * ⚠️ 字节序必须小端（低字节先），与固件一致。
 */

import {gifDecode} from './gif';
import {estimateFrameMs} from './payload';
import type {GifDecodeResult, PicFrame} from './types';

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片解码失败'));
    img.src = src;
  });
}

/* 画布 → RGB565 小端字节流（长度 = w*h*2） */
export function canvasToRgb565(cv: HTMLCanvasElement): Uint8Array {
  const ctx = cv.getContext('2d', {willReadFrequently: true})!;
  const data = ctx.getImageData(0, 0, cv.width, cv.height).data;
  const out = new Uint8Array(cv.width * cv.height * 2);
  for (let i = 0, j = 0; i < data.length; i += 4, j += 2) {
    const c = ((data[i] >> 3) << 11) | ((data[i + 1] >> 2) << 5) | (data[i + 2] >> 3);
    out[j] = c & 0xff; /* 小端：低字节先 */
    out[j + 1] = (c >> 8) & 0xff;
  }
  return out;
}

/*
 * 调试探针：只在勾选「复制成多帧 + 水印」时调用。
 * "复制帧"每一帧都是同一张图，播放起来与静止无法区分；在每帧中央画个帧号，
 * 循环时数字跳动就是"多帧真的在播"的唯一肉眼证据。
 * ⚠️ 水印是**网页端烧进画面的**，不是固件画的。
 */
export function drawFrameNumber(
  ctx: CanvasRenderingContext2D,
  n: number,
  w: number,
  h: number,
): void {
  const size = Math.max(12, Math.floor(h / 3));
  ctx.save();
  ctx.font = 'bold ' + size + 'px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = Math.max(2, Math.round(size / 8));
  ctx.strokeStyle = '#000000';
  ctx.fillStyle = '#FFFFFF';
  ctx.strokeText(String(n), w / 2, h / 2);
  ctx.fillText(String(n), w / 2, h / 2);
  ctx.restore();
}

export type StaticImageResult = {
  bytes: Uint8Array;
  canvas: HTMLCanvasElement;
  srcW: number;
  srcH: number;
};

export async function imageToRgb565(
  file: File,
  fitMode: 'contain' | 'stretch',
  outW: number,
  outH: number,
): Promise<StaticImageResult> {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const cv = document.createElement('canvas');
    cv.width = outW;
    cv.height = outH;
    const ctx = cv.getContext('2d', {willReadFrequently: true})!;
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, outW, outH);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    let dx = 0;
    let dy = 0;
    let dw = outW;
    let dh = outH;
    if (fitMode === 'contain') {
      const s = Math.min(outW / img.naturalWidth, outH / img.naturalHeight);
      dw = Math.max(1, Math.round(img.naturalWidth * s));
      dh = Math.max(1, Math.round(img.naturalHeight * s));
      dx = Math.floor((outW - dw) / 2);
      dy = Math.floor((outH - dh) / 2);
    }
    ctx.drawImage(img, dx, dy, dw, dh);

    const out = canvasToRgb565(cv);
    return {bytes: out, canvas: cv, srcW: img.naturalWidth, srcH: img.naturalHeight};
  } finally {
    URL.revokeObjectURL(url);
  }
}

/*
 * 拆帧：自己解 GIF，逐帧按 disposal 合成后缩到目标尺寸。
 *
 * 抽帧策略"保时长"：总时长不变，丢弃中间帧，把被丢帧的时长累加到保留帧上。
 * ⚠️ 2026-10-28：这条判断已从"按硬件能力抽帧"改成"默认不抽"（SPI_READ_BPS 被刻意放大）。
 *    所以 drawMs 现在只是内部量，**不再作为"硬件上限"展示** —— 那个数实测不准。
 *    实际起作用的限制是「动图帧数上限」。
 */
export async function decodeGifFrames(
  file: File,
  outW: number,
  outH: number,
  maxFrames: number,
): Promise<GifDecodeResult> {
  const bytes = new Uint8Array(await file.arrayBuffer());

  /* 合成画布（GIF 原始尺寸）：每帧先 putImageData 成完整画面，再缩放取像素 */
  const comp = document.createElement('canvas');
  let cctx: CanvasRenderingContext2D | null = null;
  let imgData: ImageData | null = null;
  let imgDataWraps = false; /* true = ImageData 直接包住合成缓冲（零拷贝） */
  let gifW = 0;
  let gifH = 0;

  const small = document.createElement('canvas');
  small.width = outW;
  small.height = outH;
  const sctx = small.getContext('2d', {willReadFrequently: true})!;

  const raw: PicFrame[] = []; /* 全部帧（原始节奏） */
  let totalMs = 0;

  gifDecode(bytes, (fr) => {
    if (!cctx) {
      gifW = fr.width;
      gifH = fr.height;
      comp.width = gifW;
      comp.height = gifH;
      cctx = comp.getContext('2d', {willReadFrequently: true})!;
      /* 零拷贝：直接包住 gifDecode 的合成缓冲（同一块内存，每帧复用）。
       * 原来是 createImageData + set()，每帧多一次 memcpy —— 2560×1440 时
       * 那是每帧 14 MB，13 帧等于白搬 180 MB。 */
      try {
        imgData = new ImageData(fr.rgba, gifW, gifH);
        imgDataWraps = true;
      } catch {
        /* 个别环境不接受外部缓冲：退回拷贝方式，行为不变、只是慢一点 */
        imgData = cctx.createImageData(gifW, gifH);
        imgDataWraps = false;
      }
    }

    if (!imgDataWraps) imgData!.data.set(fr.rgba);
    cctx!.putImageData(imgData!, 0, 0);

    let d = fr.delayMs;
    if (!(d > 0)) d = 100; /* GIF 惯例：0 延时按 100 ms */

    /* 把当前合成结果缩到目标尺寸（contain + 黑底） */
    sctx.fillStyle = '#000000';
    sctx.fillRect(0, 0, outW, outH);
    sctx.imageSmoothingEnabled = true;
    sctx.imageSmoothingQuality = 'high';
    const s = Math.min(outW / gifW, outH / gifH);
    const dw = Math.max(1, Math.round(gifW * s));
    const dh = Math.max(1, Math.round(gifH * s));
    sctx.drawImage(
      comp,
      Math.floor((outW - dw) / 2),
      Math.floor((outH - dh) / 2),
      dw,
      dh,
    );

    raw.push({bytes: canvasToRgb565(small), delay: d});
    totalMs += d;
  });

  const est = estimateFrameMs(raw, outW, outH);
  const drawMs = est.ms;

  /* 目标帧数 = min(帧数上限, 总时长 ÷ 单帧耗时, 实际帧数) */
  const byTime = Math.max(1, Math.floor(totalMs / drawMs));
  const target = Math.min(maxFrames, byTime, raw.length);
  const step = raw.length / target;

  const frames: PicFrame[] = [];
  for (let k = 0; k < target; k++) {
    const from = Math.floor(k * step);
    const to = k + 1 === target ? raw.length : Math.floor((k + 1) * step);
    let span = 0;
    for (let j = from; j < to; j++) span += raw[j].delay;
    frames.push({bytes: raw[from].bytes, delay: Math.max(10, Math.round(span))});
  }

  return {
    frames,
    origFrames: raw.length,
    totalMs,
    gifW,
    gifH,
    drawMs,
    compBytesPerFrame: est.compBytes,
    sampled: raw.length !== frames.length,
  };
}
