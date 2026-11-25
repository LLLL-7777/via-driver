/*
 * 传图能力层 · LZ4 block 压缩
 *
 * 搬运自 pic-uploader/index.html:704-755，逻辑一字未改。
 *
 * 为什么要有它：固件端存的是"每条带 LZ4 压缩后的数据"，压缩必须在浏览器里做。
 * 解码端是固件里的 lz4tiny.c —— 标准 LZ4 block 格式，所以这里按同一格式输出。
 *
 * ⚠️ 两个必须守住的规范细节，少一条标准解码器就报错（2026-10-27 踩过）：
 *    ① 最后 5 个字节必须是字面量（匹配不能顶到结尾）
 *    ② 匹配起点必须在结尾前 12 字节之外（mflimit）
 * 已验证：与 python lz4.block.decompress（参考 C 实现）字节级互通。
 */

export function lz4Compress(src: Uint8Array): Uint8Array {
  const n = src.length;
  const dst = new Uint8Array(n + Math.ceil(n / 255) + 32);
  let dp = 0;
  let ip = 0;
  let anchor = 0;
  const HASH_LOG = 12;
  const HSIZE = 1 << HASH_LOG;
  const tbl = new Int32Array(HSIZE).fill(-1);
  const hash4 = (q: number) =>
    (((src[q] |
      (src[q + 1] << 8) |
      (src[q + 2] << 16) |
      (src[q + 3] << 24)) *
      2654435761) >>>
      (32 - HASH_LOG)) &
    (HSIZE - 1);
  const mflimit = n - 12;

  function emitLen(len: number) {
    while (len >= 255) {
      dst[dp++] = 255;
      len -= 255;
    }
    dst[dp++] = len;
  }

  while (ip < mflimit) {
    const h = hash4(ip);
    const cand = tbl[h];
    tbl[h] = ip;
    if (
      cand < 0 ||
      ip - cand > 65535 ||
      src[cand] !== src[ip] ||
      src[cand + 1] !== src[ip + 1] ||
      src[cand + 2] !== src[ip + 2] ||
      src[cand + 3] !== src[ip + 3]
    ) {
      ip++;
      continue;
    }

    let ml = 4;
    /* 规范①：匹配不能顶到结尾 5 字节内 */
    while (ip + ml < n - 5 && src[cand + ml] === src[ip + ml]) {
      ml++;
    }

    const litLen = ip - anchor;
    const tokPos = dp++;
    let tok = Math.min(litLen, 15) << 4;
    if (litLen >= 15) {
      emitLen(litLen - 15);
    }
    for (let i = 0; i < litLen; i++) {
      dst[dp++] = src[anchor + i];
    }

    const off = ip - cand;
    dst[dp++] = off & 0xff;
    dst[dp++] = (off >> 8) & 0xff;

    const mlen = ml - 4;
    tok |= Math.min(mlen, 15);
    dst[tokPos] = tok;
    if (mlen >= 15) {
      emitLen(mlen - 15);
    }

    ip += ml;
    anchor = ip;
  }

  const litLen = n - anchor;
  const tokPos = dp++;
  dst[tokPos] = Math.min(litLen, 15) << 4;
  if (litLen >= 15) {
    emitLen(litLen - 15);
  }
  for (let i = 0; i < litLen; i++) {
    dst[dp++] = src[anchor + i];
  }
  return dst.subarray(0, dp);
}
