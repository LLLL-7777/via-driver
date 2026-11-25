/*
 * 传图能力层 · 协议层（纯逻辑：不碰 DOM、不碰 navigator.serial）
 *
 * 搬运自 pic-uploader/index.html:176-444，逻辑一字未改。
 *
 * 常量与帧格式逐条对齐固件：
 *   App/PIC/pic_transfer.h:29     帧 = [type:1][payload_len:4 LE] + payload
 *   App/PIC/pic_transfer.h:43     设备 → 主机固定 12 字节
 *   App/PIC/pic_transfer.h:44-48  status / written / credit / echo / 保留
 *   App/PIC/pic_transfer.h        环 4096，信用余量 256 ⇒ 上限 3840
 *
 * 传输层只需要提供三个方法：write / takeAll / waitArrival
 * ⇒ 协议层可以脱离 Web Serial 单独测试（Node 里喂假传输）。
 */

import type {PicAck, PicTransport} from './types';

export const CMD_BEGIN = 0x01;
export const CMD_DATA = 0x02;
export const CMD_COMMIT = 0x03;
export const CMD_ABORT = 0x04;
export const CMD_VERIFY = 0x05;
export const CMD_FRAMES = 0x06;
export const CMD_INFO = 0x07;
export const CMD_PING = 0x7f;

export const ST_OK = 0x00;
export const ST_BUSY = 0x01;
export const ST_BAD_CRC = 0x02;
export const ST_BAD_STATE = 0x03;
export const ST_BAD_LEN = 0x04;
export const ST_OVERFLOW = 0x05;
export const ST_FLASH_ERR = 0x06;
export const ST_SLEEPING = 0x07;
export const ST_ERASING = 0x08;
export const ST_READY = 0x7f;

export const ACK_SIZE = 12;
export const ACK_ECHO_NONE = 0x00;

/* 屏幕尺寸：图居中放在这个画布里 */
export const IMG_W = 320;
export const IMG_H = 240;

/* 帧表定长：每帧 2 B 延时，最多 128 帧 */
export const FRAME_TABLE_BYTES = 256;
/* 槽内数据起点 = 页头 32 B + 帧表 256 B（擦除进度的分母 = payload + 288） */
export const PIC_DATA_OFFSET = 288;

/*
 * 协议版本：与固件的 PT_PROTO_VERSION 必须一致。
 * v1 = BEGIN 8 B ｜ v2 = 16 B 只收满屏 ｜ v3 = 16 B 宽高生效 ｜ v4 = 多帧 + 帧表 + 查询
 * v5 = 3.9：BEGIN 20 B（加条带行数）+ 载荷按条带 LZ4 压缩（变长）
 * v6 = 3.10：format=3，载荷开头 512 B 调色板（256×u16 RGB565）
 * ⇒ 当前正式固件 3.11 也是 v6
 */
export const PROTO_VERSION = 6;

export const BURST_CHUNK = 512; /* 单条 DATA 帧携带的数据字节数 */
export const BURST_CAP = 2048; /* 单轮连续发送上限 */
export const RING_SAFE = 3840; /* 在途量上限 = 设备环 4096 − 余量 256 */

export const ST_NAME: Record<number, string> = {
  0x00: 'OK',
  0x01: 'BUSY',
  0x02: 'BAD_CRC',
  0x03: 'BAD_STATE',
  0x04: 'BAD_LEN',
  0x05: 'OVERFLOW',
  0x06: 'FLASH_ERR',
  0x07: 'SLEEPING',
  0x08: 'ERASING',
  0x7f: 'READY',
};

export const ST_HINT: Record<number, string> = {
  0x01: '设备忙（正在擦除或写入），稍等再试',
  0x02: 'CRC 不符 —— 数据在传输中出错，请重传',
  0x03: '状态错 —— 没 BEGIN 就发数据了',
  0x04: '长度或偏移错',
  0x05: '缓冲溢出 —— 有字节丢失，请重传',
  0x06: 'Flash 操作失败',
  0x07: '键盘正在休眠 —— 按一下键盘任意键唤醒它，再重试',
};

export const ERROR_STATUSES = new Set<number>([
  ST_BUSY,
  ST_BAD_CRC,
  ST_BAD_STATE,
  ST_BAD_LEN,
  ST_OVERFLOW,
  ST_FLASH_ERR,
  ST_SLEEPING,
]);

export class ProtocolError extends Error {
  status: number;
  written: number;

  constructor(ack: PicAck, where: string) {
    const name = ST_NAME[ack.status] || '0x' + ack.status.toString(16);
    const hint = ST_HINT[ack.status] || '';
    super(
      where +
        '：设备回报 ' +
        name +
        (hint ? ' —— ' + hint : '') +
        '（已落盘 ' +
        ack.written +
        ' 字节）',
    );
    this.name = 'ProtocolError';
    this.status = ack.status;
    this.written = ack.written;
  }
}

export class AckTimeout extends Error {
  constructor(where: string) {
    super(where + '：等待设备应答超时。设备可能卡住了，拔线重插或断电重上电可恢复');
    this.name = 'AckTimeout';
  }
}

export function encodeFrame(cmd: number, payload?: Uint8Array | null): Uint8Array {
  const p = payload || new Uint8Array(0);
  const out = new Uint8Array(5 + p.length);
  out[0] = cmd & 0xff;
  out[1] = p.length & 0xff;
  out[2] = (p.length >>> 8) & 0xff;
  out[3] = (p.length >>> 16) & 0xff;
  out[4] = (p.length >>> 24) & 0xff;
  out.set(p, 5);
  return out;
}

export function parseAck(b: Uint8Array, o: number): PicAck {
  return {
    status: b[o],
    written: (b[o + 1] | (b[o + 2] << 8) | (b[o + 3] << 16) | (b[o + 4] << 24)) >>> 0,
    credit: (b[o + 5] | (b[o + 6] << 8) | (b[o + 7] << 16) | (b[o + 8] << 24)) >>> 0,
    echo: b[o + 9],
    aux: b[o + 10] | (b[o + 11] << 8),
  };
}

/*
 * BEGIN 载荷 20 B（v5）：
 *   0..3 总长(压缩后，变长)  4..7 CRC32  8..9 宽  10..11 高  12..13 帧数
 *   14..15 保留=0  16..17 每条带行数 strip_rows  18..19 条带格式 format（1/2/3）
 * ⚠️ v5 起 total **不再等于** w*h*2*frames（压缩后变长），固件只做边界校验。
 * ⚠️ format 位曾整段漏写（2026-10-27），表现为 BEGIN 一直回 BAD_LEN —— 别动它。
 */
export function makeBeginPayload(
  total: number,
  crc: number,
  w: number,
  h: number,
  frames: number,
  stripRows: number,
  format?: number,
): Uint8Array {
  const p = new Uint8Array(20);
  p[0] = total & 0xff;
  p[1] = (total >>> 8) & 0xff;
  p[2] = (total >>> 16) & 0xff;
  p[3] = (total >>> 24) & 0xff;
  p[4] = crc & 0xff;
  p[5] = (crc >>> 8) & 0xff;
  p[6] = (crc >>> 16) & 0xff;
  p[7] = (crc >>> 24) & 0xff;
  p[8] = w & 0xff;
  p[9] = (w >>> 8) & 0xff;
  p[10] = h & 0xff;
  p[11] = (h >>> 8) & 0xff;
  p[12] = frames & 0xff;
  p[13] = (frames >>> 8) & 0xff;
  p[14] = 0;
  p[15] = 0;
  p[16] = stripRows & 0xff;
  p[17] = (stripRows >>> 8) & 0xff;
  p[18] = (format === undefined ? 3 : format) & 0xff;
  p[19] = 0;
  return p;
}

/*
 * 帧表：定长 256 B，每帧一个 16 位小端延时（ms）。
 * 定长是刻意的 —— 帧数据起点因此恒为 288，固件不用按帧数算偏移。
 * ⚠️ 帧表**不参与 CRC**（CRC 只覆盖帧数据）。
 */
export function makeFrameTable(delays: number | number[]): Uint8Array {
  const t = new Uint8Array(FRAME_TABLE_BYTES);
  const arr = Array.isArray(delays) ? delays : [delays];
  for (let i = 0; i < arr.length && i < FRAME_TABLE_BYTES / 2; i++) {
    const d = Math.max(1, Math.min(65535, Math.round(arr[i])));
    t[i * 2] = d & 0xff;
    t[i * 2 + 1] = (d >>> 8) & 0xff;
  }
  return t;
}

export type UploadResult = {written: number; elapsedMs: number};

export class PicProtocol {
  private t: PicTransport;
  private log: (msg: string) => void;

  constructor(transport: PicTransport, log?: (msg: string) => void) {
    this.t = transport;
    this.log = log || function () {};
  }

  /* 发一条命令并等它的回执；accept 是"成功"对应的 status */
  async cmd(
    id: number,
    payload: Uint8Array | null,
    accept: number,
    timeoutMs?: number,
  ): Promise<PicAck> {
    await this.t.write(encodeFrame(id, payload));
    const deadline = performance.now() + (timeoutMs || 5000);
    const where = '命令 0x' + id.toString(16);
    for (;;) {
      const batch = await this._nextBatch(deadline, where);
      let hit: PicAck | null = null;
      for (const ack of batch) {
        /* 规则一：错误 ACK 一律立即抛，不管它的 echo 是不是我们在等的。
           否则设备回的错误会被当成"不是我要的"而丢掉，主机只能干等到
           超时，现象就成了"设备不吭声"。（2026-10-14 踩过这个坑） */
        if (ERROR_STATUSES.has(ack.status)) throw new ProtocolError(ack, where);
        if (ack.echo === id) hit = ack;
      }
      if (hit) {
        if (hit.status === accept) return hit;
        throw new ProtocolError(hit, where);
      }
    }
  }

  /* 数据阶段的进度 ACK：一批里可能有多条，取最后一条（它带最新信用） */
  async waitProgress(timeoutMs?: number): Promise<PicAck> {
    const deadline = performance.now() + (timeoutMs || 15000);
    for (;;) {
      const batch = await this._nextBatch(deadline, '接收数据');
      let newest: PicAck | null = null;
      for (const ack of batch) {
        if (ERROR_STATUSES.has(ack.status)) {
          throw new ProtocolError(ack, '接收数据');
        }
        if (ack.echo === ACK_ECHO_NONE) newest = ack;
      }
      /* 规则二：取这一批里最后一条 —— 取最早那条等于拿"过时的路况"决定
         现在发多快，正是溢出的主因（2026-10-16 实测定位）。 */
      if (newest) return newest;
    }
  }

  private async _nextBatch(deadline: number, where: string): Promise<PicAck[]> {
    let batch = this.t.takeAll();
    while (batch.length === 0) {
      const arrived = await this.t.waitArrival(deadline);
      if (!arrived) throw new AckTimeout(where);
      batch = this.t.takeAll();
    }
    return batch;
  }

  ping() {
    return this.cmd(CMD_PING, null, ST_OK, 6000);
  }
  verify() {
    return this.cmd(CMD_VERIFY, null, ST_OK, 15000);
  }
  info() {
    return this.cmd(CMD_INFO, null, ST_OK, 6000);
  }

  /* 3.4：帧表独立一条命令。必须等 BEGIN 回 READY（擦除完成）之后再发，
     否则刚写进 Flash 就被擦除覆盖。 */
  sendFrameTable(delays: number | number[]) {
    return this.cmd(CMD_FRAMES, makeFrameTable(delays), ST_OK, 8000);
  }

  /*
   * 3.2：BEGIN 单独实现（不能走 cmd）。
   * 设备擦除期间会持续回 0x08 进度 ACK，且 echo 必须是 0（PT_ECHO_NONE）——
   * 一旦把 echo 填成 BEGIN 的命令码，cmd() 会把它当成 BEGIN 的完成回执，
   * 看到状态不是 READY 就直接抛错。这里把 0x08 转给 onErase，READY 才算成功。
   */
  async begin(
    total: number,
    crc: number,
    w: number,
    h: number,
    frames: number,
    stripRows: number,
    format: number,
    onErase?: (written: number, span: number) => void,
  ): Promise<PicAck> {
    await this.t.write(
      encodeFrame(
        CMD_BEGIN,
        makeBeginPayload(total, crc, w, h, frames, stripRows, format),
      ),
    );

    const span = total + PIC_DATA_OFFSET; /* 页头 + 帧表 + 载荷 */
    /* ⚠️ 这是"空闲超时"而不是"总超时"：每收到一条擦除进度就续期。
       因为 320×240 × 30 帧要擦约 17.6 s，固定 20 s 的总超时几乎贴脸；
       只要设备还在报进度，就说明它活着，不该判超时。 */
    let deadline = performance.now() + 20000;

    for (;;) {
      const batch = await this._nextBatch(deadline, 'BEGIN');
      for (const ack of batch) {
        if (ERROR_STATUSES.has(ack.status)) throw new ProtocolError(ack, 'BEGIN');
        if (ack.status === ST_ERASING) {
          if (onErase) onErase(ack.written, span);
          deadline = performance.now() + 20000; /* 有进度就续期 */
          continue;
        }
        if (ack.echo === CMD_BEGIN) {
          if (ack.status === ST_READY) return ack;
          throw new ProtocolError(ack, 'BEGIN');
        }
      }
    }
  }

  async upload(
    img: Uint8Array,
    crc: number,
    w: number,
    h: number,
    delays: number[],
    stripRows: number,
    format: number,
    onProgress?: (
      off: number,
      total: number,
      written: number,
      elapsedMs: number,
    ) => void,
    onErase?: (written: number, span: number) => void,
  ): Promise<UploadResult> {
    const total = img.length;
    const frames = delays.length;
    const t0 = performance.now();

    /* BEGIN：设备先失效页头，再分块擦除（每擦完一块回一条 0x08 进度），
       全部擦完才回 READY；READY 之后才允许写帧表、发数据。 */
    const ready = await this.begin(
      total,
      crc,
      w,
      h,
      frames,
      stripRows,
      format,
      onErase,
    );

    /* 帧表在数据之前发 —— 放进数据流前面会让 CRC 要"跳过 256 B"，
       容易算错位；独立一条命令只多一次往返（约 1~2 ms）。 */
    await this.sendFrameTable(delays);
    let credit = ready.credit;
    /* READY 时设备还没写数据，此值正常为 0。取 ACK 里的实际值而不是写死 0 ——
       万一设备改了口径（比如报累计值），在途量封顶会算错而失效。 */
    let written = ready.written;
    let off = 0;
    this.log('BEGIN ok，缓冲信用 ' + credit + ' 字节');

    while (off < total) {
      /* 四个上限取最小：设备报的信用 / 单轮突发上限 / 剩余总量 / 在途量余量。
         最后一项才真正封死"两轮叠加灌爆环"：
         在途量 = 已发 − 已落盘，数学上是设备环形缓冲占用量的上界。 */
      let burst = Math.min(credit, BURST_CAP, total - off, RING_SAFE - (off - written));
      if (burst < 1) burst = 1; /* 信用为 0 时不死等，发最小一帧试探 */

      let sent = 0;
      while (sent < burst) {
        const n = Math.min(BURST_CHUNK, burst - sent);
        const o = off + sent;
        const payload = new Uint8Array(4 + n);
        payload[0] = o & 0xff;
        payload[1] = (o >>> 8) & 0xff;
        payload[2] = (o >>> 16) & 0xff;
        payload[3] = (o >>> 24) & 0xff;
        payload.set(img.subarray(o, o + n), 4);
        await this.t.write(encodeFrame(CMD_DATA, payload));
        sent += n;
      }
      off += sent;

      const ack = await this.waitProgress(15000);
      written = ack.written;
      credit = ack.credit;
      if (onProgress) onProgress(off, total, written, performance.now() - t0);
    }

    /* COMMIT：设备核对自己算的 CRC 与 BEGIN 声明的是否一致，一致才写页头 */
    const done = await this.cmd(CMD_COMMIT, null, ST_OK, 15000);
    return {written: done.written, elapsedMs: performance.now() - t0};
  }
}
