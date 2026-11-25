/*
 * 传图能力层 · CRC32
 *
 * 搬运自 pic-uploader/index.html:145-161，算法与常量一字未改。
 * CRC-32/ISO-HDLC，与 Python zlib.crc32、固件侧计算同值。
 *
 * ⚠️ 不要"优化"这里的任何表达式 —— 它必须与固件逐位一致，
 *    改一位就会造成 BAD_CRC，且现象是"传一半失败"，极难定位。
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[i] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = (CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)) >>> 0;
  }
  return (c ^ 0xffffffff) >>> 0;
}

/* 8 位大写十六进制（BEGIN / CRC 展示用） */
export function hex32(v: number): string {
  return (v >>> 0).toString(16).toUpperCase().padStart(8, '0');
}
