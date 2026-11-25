/*
 * 传图能力层 · 共享类型
 *
 * 来源：pic-uploader/index.html（单一事实来源）。
 * 这里的类型只是给搬运过来的 JS 加壳，**不改变任何运行时行为**。
 */

/* 一帧上传数据：RGB565 小端字节（长度 = w*h*2）+ 显示延时（ms） */
export type PicFrame = {
  bytes: Uint8Array;
  delay: number;
};

/* 设备 → 主机 固定 12 字节回执（pic_transfer.h:43-48） */
export type PicAck = {
  status: number;
  /* 已落盘字节数 */
  written: number;
  /* 设备还能接收多少字节（快照，不是持续值） */
  credit: number;
  /* 对应哪条命令；进度/擦除类回执为 0（ACK_ECHO_NONE） */
  echo: number;
  /* v6 起：固件构建标识（PING 用）；旧固件为 0 */
  aux: number;
};

/*
 * 协议层对传输层的最小要求。
 * 只依赖这三个方法 ⇒ 协议层可以脱离 Web Serial 单独测试（Node 里喂假传输）。
 */
export type PicTransport = {
  write(bytes: Uint8Array): Promise<void>;
  takeAll(): PicAck[];
  waitArrival(deadline: number): Promise<boolean>;
};

/* 组包结果 */
export type PicPayload = {
  payload: Uint8Array;
  stripRows: number;
  compBytes: number;
  rawBytes: number;
  palette: Uint16Array | null;
  /* 1 = RGB565 无损；3 = 256 色调色板 */
  format: 1 | 3;
};

/* GIF 拆帧结果（输出契约与原网页端一致） */
export type GifDecodeResult = {
  frames: PicFrame[];
  origFrames: number;
  totalMs: number;
  gifW: number;
  gifH: number;
  drawMs: number;
  compBytesPerFrame: number;
  sampled: boolean;
};
