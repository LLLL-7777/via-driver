/*
 * 传图能力层 · 传输层（Web Serial）
 *
 * 搬运自 pic-uploader/index.html:459-576，逻辑一字未改。
 *
 * 读循环必须常驻：Web Serial 如果不持续 read()，设备端 USB 缓冲会填满
 * 进而丢字节，而丢字节在协议上表现为偏移错/溢出，排查极绕。
 *
 * ACK 等待用 Promise 唤醒而不是轮询：浏览器 setTimeout 最小 4 ms，整图
 * 约 75 轮，轮询会把每轮往返从 1 ms 抬到 5 ms，凭空多出 0.3 s。
 */

import {ACK_SIZE, parseAck} from './protocol';
import type {PicAck, PicTransport} from './types';

/*
 * 打开串口后的"清洗窗口"：这段时间内收到的字节一律丢弃，用于清掉上次
 * 会话可能残留在设备端环形缓冲里的半条 ACK（否则 12 字节切分会整体错位）。
 * 窗口必须很短 —— open() 要等它结束才返回，否则紧接着发出的第一条命令
 * （PING）的应答会落进窗口被丢掉，表现为"设备一声不吭直到超时"。
 */
export const ARM_WINDOW_MS = 120;

/*
 * Web Serial 的最小类型声明。
 * 项目没装 @types/w3c-web-serial，而 lib.dom 里也没有 SerialPort，
 * 所以这里按用到的成员自己声明 —— 只用这 4 个。
 */
export type SerialPortLike = {
  open(options: {baudRate: number}): Promise<void>;
  close(): Promise<void>;
  writable: WritableStream<Uint8Array> | null;
  readable: ReadableStream<Uint8Array> | null;
};

type Waiter = {resolve: (v: boolean) => void; reject: (e: unknown) => void};

export class SerialTransport implements PicTransport {
  port: SerialPortLike | null = null;
  reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  buf: Uint8Array = new Uint8Array(0);
  acks: PicAck[] = [];
  waiters: Waiter[] = [];
  error: unknown = null;
  closed = false;
  armAt = 0;
  droppedBytes = 0;

  static get supported(): boolean {
    return typeof navigator !== 'undefined' && 'serial' in navigator;
  }

  async open(port: SerialPortLike): Promise<void> {
    this.port = port;
    /* CDC 是虚拟串口，波特率对设备无意义（真实速率是 USB 全速），但接口要求给一个 */
    await port.open({baudRate: 115200});
    this.writer = port.writable!.getWriter();
    this.reader = port.readable!.getReader();
    this.error = null;
    this.closed = false;
    this.droppedBytes = 0;
    this.armAt = performance.now() + ARM_WINDOW_MS;
    void this._loop();

    /* ⚠️ 关键：等清洗窗口结束后再返回。
       否则调用方紧接着发出的 PING 的应答会在窗口内到达并被丢弃，
       现象就是"串口能打开、PING 却一直超时"（2026-10-20 实测踩到）。 */
    await new Promise<void>((r) => setTimeout(r, ARM_WINDOW_MS + 10));
  }

  private async _loop(): Promise<void> {
    try {
      for (;;) {
        const r = await this.reader!.read();
        if (r.done) break;
        if (r.value && r.value.length) this._feed(r.value);
      }
    } catch (e) {
      if (!this.closed) this._fail(e);
      return;
    }
    if (!this.closed) {
      this._fail(new Error('串口连接已断开（设备被拔出或复位）'));
    }
  }

  private _feed(chunk: Uint8Array): void {
    if (performance.now() < this.armAt) {
      this.droppedBytes += chunk.length;
      return;
    }
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf, 0);
    merged.set(chunk, this.buf.length);
    this.buf = merged;
    while (this.buf.length >= ACK_SIZE) {
      this.acks.push(parseAck(this.buf, 0));
      this.buf = this.buf.subarray(ACK_SIZE);
    }
    this._wake();
  }

  private _wake(): void {
    if (this.waiters.length === 0) return;
    const ws = this.waiters;
    this.waiters = [];
    for (const w of ws) w.resolve(true);
  }

  private _fail(err: unknown): void {
    this.error = err;
    const ws = this.waiters;
    this.waiters = [];
    for (const w of ws) w.reject(err);
  }

  takeAll(): PicAck[] {
    const out = this.acks;
    this.acks = [];
    return out;
  }

  /* 有新 ACK → true；到 deadline → false；串口出错 → reject */
  waitArrival(deadline: number): Promise<boolean> {
    if (this.acks.length) return Promise.resolve(true);
    if (this.error) return Promise.reject(this.error);
    return new Promise<boolean>((resolve, reject) => {
      const entry: Waiter = {
        resolve: (v: boolean) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e: unknown) => {
          clearTimeout(timer);
          reject(e);
        },
      };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== entry);
        resolve(false);
      }, Math.max(0, deadline - performance.now()));
      this.waiters.push(entry);
    });
  }

  async write(bytes: Uint8Array): Promise<void> {
    if (!this.writer) throw new Error('串口未打开');
    await this.writer.write(bytes);
  }

  async close(): Promise<void> {
    this.closed = true;
    this._wake();
    try {
      if (this.reader) await this.reader.cancel();
    } catch {
      /* 已断开 */
    }
    try {
      if (this.reader) this.reader.releaseLock();
    } catch {
      /* 忽略 */
    }
    try {
      if (this.writer) this.writer.releaseLock();
    } catch {
      /* 忽略 */
    }
    try {
      if (this.port) await this.port.close();
    } catch {
      /* 已断开 */
    }
    this.reader = null;
    this.writer = null;
    this.port = null;
    this.buf = new Uint8Array(0);
    this.acks = [];
  }
}
