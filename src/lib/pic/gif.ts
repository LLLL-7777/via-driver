/*
 * 传图能力层 · GIF 自解析（纯逻辑，零 DOM 依赖）
 *
 * 搬运自 pic-uploader/index.html:1048-1409，逻辑一字未改。
 *
 * ⭐ 为什么要自己解：浏览器 ImageDecoder 只交出"这一帧的像素"，
 *    它**不告诉我们帧矩形、处置方式(disposal)、透明索引**这三样。
 *    而这三样恰恰决定画面怎么合成：
 *      · 帧矩形 —— 很多 GIF 只画变化的一小块（局部更新）
 *      · disposal = 2 —— 画完这一帧要**把那块区域擦回背景色**
 *      · disposal = 3 —— 画完要**恢复成画之前的样子**
 *    2026-10-28 实测"捂嘴猫.gif"（26/28 帧是局部块、25 帧 disposal=2）：
 *    原来那版"drawImage 直接叠、从不清屏"，平均 7.5% 的像素是残留的旧帧
 *    （最严重的一帧 12.1%），肉眼就是重影。
 *    修好后与 Pillow 参考实现逐像素比对：6 组用例 / 116 帧 / 0 差异。
 *
 * 只做三件事：解析块结构、LZW 解压、按 disposal 合成。
 * 输出契约不变（每帧一张 RGBA 合成图），下游缩放/量化/压缩全不动。
 */

export type GifFrameInfo = {
  width: number;
  height: number;
  /* 共享缓冲（宽×高×4 RGBA）：调用方必须立即消费，不要保存引用 */
  rgba: Uint8ClampedArray;
  delayMs: number;
  index: number;
};

/* 读连续子块（长度字节 + 数据，遇到 0 结尾），拼成一整块 */
export function gifSubBlocks(
  b: Uint8Array,
  p: number,
): {data: Uint8Array; next: number} {
  const lens: number[] = [];
  let total = 0;
  let q = p;
  for (;;) {
    if (q >= b.length) break;
    const n = b[q++];
    if (n === 0) break;
    lens.push(n);
    total += n;
    q += n;
  }
  const out = new Uint8Array(total);
  let o = 0;
  q = p;
  for (let i = 0; i < lens.length; i++) {
    q++; /* 跳过长度字节 */
    out.set(b.subarray(q, q + lens[i]), o);
    o += lens[i];
    q += lens[i];
  }
  return {data: out, next: q + 1}; /* +1 跳过终止符 0 */
}

/* LZW 解码：GIF 变种（先 clear 码，LSB 打包） */
export function gifLzw(
  minCodeSize: number,
  data: Uint8Array,
  pxCount: number,
): Uint8Array {
  const out = new Uint8Array(pxCount);
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;

  const prefix = new Int16Array(4096);
  const suffix = new Uint8Array(4096);
  const first = new Uint8Array(4096);
  const len = new Uint16Array(4096);
  for (let i = 0; i < clear; i++) {
    prefix[i] = -1;
    suffix[i] = i;
    first[i] = i;
    len[i] = 1;
  }

  let codeSize = minCodeSize + 1;
  let next = clear + 2;
  let prev = -1;
  let bitBuf = 0;
  let bitCnt = 0;
  let dp = 0;
  let op = 0;

  function emit(idx: number) {
    const l = len[idx];
    let w = op + l - 1;
    let c = idx;
    while (c !== -1) {
      if (w < pxCount) out[w] = suffix[c];
      w--;
      c = prefix[c];
    }
    op += l;
    if (op > pxCount) op = pxCount;
  }

  while (op < pxCount) {
    while (bitCnt < codeSize) {
      if (dp >= data.length) return out; /* 数据截断：返回已解出的部分 */
      bitBuf |= data[dp++] << bitCnt;
      bitCnt += 8;
    }
    const code = bitBuf & ((1 << codeSize) - 1);
    bitBuf >>>= codeSize;
    bitCnt -= codeSize;

    if (code === clear) {
      codeSize = minCodeSize + 1;
      next = clear + 2;
      prev = -1;
      continue;
    }
    if (code === eoi) break;

    if (prev === -1) {
      if (code >= clear) break;
      if (op < pxCount) out[op] = suffix[code];
      op++;
      prev = code;
      continue;
    }

    let fc: number;
    if (code < next) {
      emit(code);
      fc = first[code];
    } else if (code === next) {
      /* KwKwK：字典里还没有这个码，它 = 上一串 + 上一串首字节 */
      emit(prev);
      if (op < pxCount) out[op] = first[prev];
      op++;
      fc = first[prev];
    } else {
      break; /* 非法码：放弃这一帧的剩余部分 */
    }

    if (next < 4096) {
      prefix[next] = prev;
      suffix[next] = fc;
      first[next] = first[prev];
      len[next] = len[prev] + 1;
      next++;
      if (next === 1 << codeSize && codeSize < 12) codeSize++;
    }
    prev = code;
  }
  return out;
}

/* 隔行（interlace）还原：4 遍扫描的行走顺序是 0,8,16.. / 4,12,20.. / 2,6,10.. / 1,3,5.. */
export function gifDeinterlace(
  src: Uint8Array,
  w: number,
  h: number,
): Uint8Array {
  const dst = new Uint8Array(w * h);
  const start = [0, 4, 2, 1];
  const step = [8, 8, 4, 2];
  let srcRow = 0;
  for (let pass = 0; pass < 4; pass++) {
    for (let y = start[pass]; y < h; y += step[pass]) {
      dst.set(src.subarray(srcRow * w, srcRow * w + w), y * w);
      srcRow++;
    }
  }
  return dst;
}

/*
 * 主解码：逐帧合成，每帧通过 onFrame 回调交出去。
 *
 * 尺寸上限（2026-10-28 从「单边 2048」放宽）：原上限是防御性设的，
 * 实测 2560×1440 × 13 帧解 0.5~0.8 s、内存约 32 MB，完全能跑。
 * 改成按**总像素**限制（单边大小本身不是问题，面积才是）。
 */
const MAX_PIXELS = 10000000;
const MAX_SIDE = 8192;

export function gifDecode(
  bytes: Uint8Array,
  onFrame: (fr: GifFrameInfo) => void,
): {width: number; height: number; frames: number} {
  const b = bytes;
  if (b.length < 13) throw new Error('文件太短，不是有效的 GIF');

  const sig = String.fromCharCode(b[0], b[1], b[2], b[3], b[4], b[5]);
  if (sig !== 'GIF87a' && sig !== 'GIF89a') {
    throw new Error('不是 GIF 文件（文件头是 ' + sig + '）');
  }

  let p = 6;
  const width = b[p] | (b[p + 1] << 8);
  const height = b[p + 2] | (b[p + 3] << 8);
  p += 4;
  const packed = b[p++];
  const bgIndex = b[p++];
  p++; /* 像素宽高比，忽略 */

  if (!width || !height) throw new Error('GIF 尺寸为 0');

  if (width > MAX_SIDE || height > MAX_SIDE || width * height > MAX_PIXELS) {
    throw new Error(
      'GIF 太大：当前 ' +
        width +
        '×' +
        height +
        '（' +
        ((width * height) / 1e6).toFixed(1) +
        ' 百万像素）｜上限 ' +
        MAX_PIXELS / 1e6 +
        ' 百万像素、单边 ' +
        MAX_SIDE +
        '。建议先把长边缩到 1920 以内再传',
    );
  }

  let gct: Uint8Array | null = null;
  if (packed & 0x80) {
    const n = 3 * (1 << ((packed & 7) + 1));
    gct = b.subarray(p, p + n);
    p += n;
  }

  /* 画布初值 = 全局背景色（规范：未绘制区域显示背景色） */
  let bgR = 0;
  let bgG = 0;
  let bgB = 0;
  if (gct && bgIndex * 3 + 2 < gct.length) {
    bgR = gct[bgIndex * 3];
    bgG = gct[bgIndex * 3 + 1];
    bgB = gct[bgIndex * 3 + 2];
  }
  const canvas = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    canvas[i * 4] = bgR;
    canvas[i * 4 + 1] = bgG;
    canvas[i * 4 + 2] = bgB;
    canvas[i * 4 + 3] = 255;
  }

  let delayCs = 0; /* 本单位 = 1/100 秒 */
  let disposal = 0;
  let transIndex = -1;

  let prevDisposal = 0;
  let prevRect: {left: number; top: number; w: number; h: number} | null = null;
  let snapshot: Uint8ClampedArray | null = null; /* disposal=3 用的快照 */

  let index = 0;

  function fillRect(
    rect: {left: number; top: number; w: number; h: number},
    r: number,
    g: number,
    bl: number,
  ) {
    for (let y = rect.top; y < rect.top + rect.h; y++) {
      let o = (y * width + rect.left) * 4;
      for (let x = 0; x < rect.w; x++) {
        canvas[o] = r;
        canvas[o + 1] = g;
        canvas[o + 2] = bl;
        canvas[o + 3] = 255;
        o += 4;
      }
    }
  }

  function takeSnapshot(rect: {left: number; top: number; w: number; h: number}) {
    const buf = new Uint8ClampedArray(rect.w * rect.h * 4);
    let o = 0;
    for (let y = rect.top; y < rect.top + rect.h; y++) {
      let s = (y * width + rect.left) * 4;
      for (let x = 0; x < rect.w; x++) {
        buf[o++] = canvas[s];
        buf[o++] = canvas[s + 1];
        buf[o++] = canvas[s + 2];
        buf[o++] = canvas[s + 3];
        s += 4;
      }
    }
    return buf;
  }

  function restoreSnapshot(
    rect: {left: number; top: number; w: number; h: number},
    buf: Uint8ClampedArray,
  ) {
    let o = 0;
    for (let y = rect.top; y < rect.top + rect.h; y++) {
      let s = (y * width + rect.left) * 4;
      for (let x = 0; x < rect.w; x++) {
        canvas[s] = buf[o++];
        canvas[s + 1] = buf[o++];
        canvas[s + 2] = buf[o++];
        canvas[s + 3] = buf[o++];
        s += 4;
      }
    }
  }

  while (p < b.length) {
    const block = b[p];

    if (block === 0x3b) break; /* trailer */

    if (block === 0x21) {
      /* 扩展块 */
      const label = b[p + 1];
      if (label === 0xf9) {
        /* 图形控制扩展 */
        const size = b[p + 2];
        if (size >= 4) {
          const gcePacked = b[p + 3];
          delayCs = b[p + 4] | (b[p + 5] << 8);
          disposal = (gcePacked >> 2) & 0x7;
          transIndex = gcePacked & 1 ? b[p + 6] : -1;
        }
      }
      const sub = gifSubBlocks(b, p + 2);
      p = sub.next;
      continue;
    }

    if (block === 0x2c) {
      /* 图像描述符 */
      const left = b[p + 1] | (b[p + 2] << 8);
      const top = b[p + 3] | (b[p + 4] << 8);
      const fw = b[p + 5] | (b[p + 6] << 8);
      const fh = b[p + 7] | (b[p + 8] << 8);
      const ifPacked = b[p + 9];
      p += 10;

      let lct: Uint8Array | null = null;
      if (ifPacked & 0x80) {
        const n = 3 * (1 << ((ifPacked & 7) + 1));
        lct = b.subarray(p, p + n);
        p += n;
      }
      const interlaced = (ifPacked & 0x40) !== 0;

      const minCodeSize = b[p++];
      const sub = gifSubBlocks(b, p);
      p = sub.next;

      const pal = lct || gct;
      const px = gifLzw(minCodeSize, sub.data, fw * fh);
      const rows = interlaced ? gifDeinterlace(px, fw, fh) : px;

      /* 裁剪到画布内（防止越界写） */
      const cw = Math.min(fw, width - left);
      const ch = Math.min(fh, height - top);
      if (cw <= 0 || ch <= 0) {
        /* 完全在画布外：仍算一帧，画面不变 */
      } else {
        const rect = {left, top, w: cw, h: ch};

        /* ① 先落实上一帧的处置（这才是"擦屏"） */
        if (prevDisposal === 2 && prevRect) {
          fillRect(prevRect, bgR, bgG, bgB);
        } else if (prevDisposal === 3 && prevRect && snapshot) {
          restoreSnapshot(prevRect, snapshot);
        }

        /* ② 本帧若要求"恢复前值"，先留快照（画之前的状态） */
        if (disposal === 3) snapshot = takeSnapshot(rect);

        /* ③ 画本帧：透明索引的像素"保留下面"，其余覆盖 */
        for (let y = 0; y < ch; y++) {
          const srcRow = y * fw;
          let o = ((top + y) * width + left) * 4;
          for (let x = 0; x < cw; x++) {
            const idx = rows[srcRow + x];
            if (idx !== transIndex && pal) {
              const q = idx * 3;
              if (q + 2 < pal.length) {
                canvas[o] = pal[q];
                canvas[o + 1] = pal[q + 1];
                canvas[o + 2] = pal[q + 2];
                canvas[o + 3] = 255;
              }
            }
            o += 4;
          }
        }

        prevDisposal = disposal;
        prevRect = rect;
      }

      let ms = delayCs * 10;
      if (!(ms > 0)) ms = 100;

      index++;
      if (index > 600) {
        throw new Error('这个 GIF 帧数太多（上限 600 帧）；请先截短再试');
      }

      /* 总工作量兜底：像素 × 帧数。
         一帧 3.7 M 像素约 45 ms ⇒ 4 亿像素·帧 ≈ 5 s。
         挡住「4K × 几百帧」这种会把浏览器冻住的文件，而不是让它慢慢卡死。 */
      if (index * width * height > 400000000) {
        throw new Error(
          '这个 GIF 太大：已解 ' +
            index +
            ' 帧（' +
            width +
            '×' +
            height +
            '），累计约 ' +
            Math.round((index * width * height) / 1e6) +
            ' 百万像素·帧，解码会超过 5 秒。请先缩短帧数或缩小尺寸',
        );
      }

      onFrame({width, height, rgba: canvas, delayMs: ms, index: index - 1});

      delayCs = 0;
      disposal = 0;
      transIndex = -1;
      continue;
    }

    p++; /* 未知块：跳过 1 字节继续找 */
  }

  if (index === 0) throw new Error('GIF 里没有找到任何图像帧');
  return {width, height, frames: index};
}

export function gifSupported(): boolean {
  /* 拆帧已改为自己解析，不再需要 ImageDecoder；这里只用于判断
   * "能不能探测帧数"（见 probeAnimation），没有它也只影响动图识别精度。 */
  return typeof (window as {ImageDecoder?: unknown}).ImageDecoder !== 'undefined';
}
