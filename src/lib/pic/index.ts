/*
 * 传图能力层 · 统一出口
 *
 * ⚠️ 这一层里的所有代码都是从 `pic-uploader/index.html` 原样搬来的，
 *    **运行时行为必须与它逐字节一致**。改动前请先跑：
 *      npx tsx scripts/verify-pic-lib.ts
 *    那个脚本会把旧实现的函数抽出来，和新实现跑同一组输入逐字节比对。
 *
 * 分层：
 *   crc       校验和
 *   protocol  帧编解码 + 命令状态机（纯逻辑）
 *   transport Web Serial 封装（唯一碰浏览器 API 的地方）
 *   lz4       条带压缩
 *   palette   256 色调色板
 *   payload   条带划分 + 组包 + 帧耗时估算
 *   gif       GIF 自解析（纯逻辑）
 *   image     canvas 缩放 / 转 RGB565 / GIF 拆帧（碰 DOM）
 */

export * from './types';
export * from './crc';
export * from './lz4';
export * from './palette';
export * from './payload';
export * from './protocol';
export * from './transport';
export * from './gif';
export * from './image';
