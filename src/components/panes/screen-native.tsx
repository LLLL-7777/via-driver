import {useCallback, useEffect, useRef, useState} from 'react';
import type {DragEvent} from 'react';
import styled from 'styled-components';
import {useTranslation} from 'react-i18next';

import {
  PicProtocol,
  SerialTransport,
  PROTO_VERSION,
  buildCompressedPayload,
  crc32,
  decodeGifFrames,
  hex32,
  imageToRgb565,
  makeBeginPayload,
} from '../../lib/pic';
import type {PicFrame, SerialPortLike} from '../../lib/pic';

/*
 * Screen 页（B2）：传图原生化 —— 不用 iframe，直接是驱动自己的一个页面。
 *
 * 能力层来自 src/lib/pic（从 pic-uploader/index.html 原样搬来，已做逐字节等价校验：
 * npx tsx scripts/verify-pic-lib.ts）。本文件只负责 UI 与编排。
 *
 * ⚠️⚠️ 本页是**常驻挂载**的（Routes.tsx 的 PersistentPane，切走用 display:none）。
 *   但串口对象仍然放在**模块级**（见下方 session），原因：
 *     ① React 重挂载 / 热更新会让组件 state 归零，但串口不能跟着断；
 *     ② 以后要在顶部状态条显示连接状态，需要一个组件外的持有者。
 *   ⇒ 组件只镜像 session 的状态，不持有传输对象本身。
 *
 * 🌐 多语言（2026-11-13）：所有可见文案都走 i18next，key 统一 `Screen_xxx`。
 *   ⚠️ key 里**不能带冒号** —— i18next 默认 nsSeparator 是 ':'，`Screen:Connect`
 *   会被拆成 namespace="Screen" 而找不到资源。也不能带点（keySeparator）。
 *   ⇒ 只用下划线 + camelCase。
 *   目前只做中英（en / zh）；de / es / ja / ko 缺 key 时会自动回退英文
 *   （index.tsx 里 fallbackLng: 'en'），不需要改那 4 个文件。
 */

/* 顶部导航栏总高：global.tsx 里 height:25px + padding:12px 0 = 49px */
const MENU_BAR_HEIGHT = 49;

/* ============================================================
 * 模块级会话
 * ============================================================ */
type Session = {
  transport: SerialTransport | null;
  proto: PicProtocol | null;
  /* 存原始 VID/PID，不存翻译后的句子 —— 否则切语言时这半句不会跟着变 */
  portVid: string;
  portPid: string;
  /* PING 握手是否通过（固件协议版本与网页端一致） */
  protoOk: boolean;
  build: number;
};

const session: Session = {
  transport: null,
  proto: null,
  portVid: '',
  portPid: '',
  protoOk: false,
  build: 0,
};

/* 本机没有 `navigator.serial` 的类型定义（lib.dom 未包含 Web Serial） */
type PortInfo = {usbVendorId?: number; usbProductId?: number};
type SerialPortWithInfo = SerialPortLike & {getInfo?: () => PortInfo};
type NavigatorWithSerial = Navigator & {
  serial?: {
    requestPort(options?: {
      filters?: {usbVendorId?: number; usbProductId?: number}[];
    }): Promise<SerialPortWithInfo>;
    getPorts(): Promise<SerialPortWithInfo[]>;
  };
};

function serialApi() {
  return (navigator as NavigatorWithSerial).serial;
}

/* 设备错误码 → i18n key。
   ⚠️ 不改 lib/pic 里 ProtocolError 的中文 message —— 那个文件必须与
   pic-uploader 保持逐字节等价（有校验脚本守着）。这里在 UI 层按 status 映射。 */
const STATUS_KEY: Record<number, string> = {
  0x01: 'err_busy',
  0x02: 'err_crc',
  0x03: 'err_badState',
  0x04: 'err_badLen',
  0x05: 'err_overflow',
  0x06: 'err_flash',
  0x07: 'err_sleeping',
};

/* ============================================================
 * 样式（只用 VIA 的主题变量，保证 light/dark 都跟着走）
 * ============================================================ */
const Wrapper = styled.div`
  position: fixed;
  top: ${MENU_BAR_HEIGHT}px;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 3;
  display: flex;
  flex-direction: column;
  background: var(--bg_gradient);
  color: var(--color_label-highlighted);
  font-size: 13px;
`;

const Head = styled.div`
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--border_color_cell);
  flex: 0 0 auto;
`;

const Status = styled.span<{$tone?: 'ok' | 'warn' | 'err'}>`
  font-size: 13px;
  color: ${(p) =>
    p.$tone === 'ok'
      ? '#4f9d5d'
      : p.$tone === 'warn'
        ? '#c8922a'
        : p.$tone === 'err'
          ? 'var(--color_error)'
          : 'var(--color_label)'};
  margin-left: auto;
`;

const Btn = styled.button`
  font: inherit;
  font-size: 13px;
  padding: 6px 14px;
  border-radius: 7px;
  border: 1px solid var(--border_color_cell);
  background: var(--bg_control);
  color: var(--color_label-highlighted);
  cursor: pointer;

  &:disabled {
    opacity: 0.45;
    cursor: default;
  }
`;

const Body = styled.div`
  display: flex;
  flex: 1;
  min-height: 0;
`;

const Col = styled.div`
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  min-width: 0;
`;

/* 预览列：内容居中；预览块自己有尺寸上限，不靠 flex 撑满 */
const Left = styled(Col)`
  flex: 1;
  align-items: center;
  justify-content: center;
  border-right: 1px solid var(--border_color_cell);
`;

const Right = styled(Col)`
  width: 370px;
  flex: 0 0 auto;
  overflow: auto;
`;

/* 预览容器：作为尺寸查询基准（container-type: size），同时负责居中 */
const PreviewArea = styled.div`
  flex: 1;
  min-height: 0;
  width: 100%;
  container-type: size;
  display: flex;
  align-items: center;
  justify-content: center;
`;

/*
 * 预览块：固定 4:3（= 键盘屏 320×240 的比例），居中，黑底。
 * ⚠️ 尺寸用容器查询单位算"能放下的最大 4:3 矩形"：
 *      100cqw        = 容器宽
 *      133.333cqh    = 按容器高反推的宽（4/3）
 *      640px         = 上限，避免大屏上无限膨胀
 *    取三者最小值 ⇒ 窗口又矮又宽时也不会被压成扁条（2026-11-12 踩到：
 *    只写 max-height:100% 时宽仍是 640、高被压到 200，比例直接塌掉）。
 */
const Drop = styled.div<{$over?: boolean}>`
  width: min(100cqw, 133.333cqh, 640px);
  aspect-ratio: 4 / 3;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px dashed
    ${(p) => (p.$over ? 'var(--color_accent, #6f8fbf)' : 'var(--border_color_cell)')};
  border-radius: 10px;
  background: #000;
  cursor: pointer;
  text-align: center;
  color: var(--color_label);
  font-size: 13px;
  padding: 12px;
  overflow: hidden;
`;

const Preview = styled.img`
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  image-rendering: auto;
`;

const Row = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
`;

const Label = styled.label`
  color: var(--color_label);
  font-size: 13px;
  min-width: 76px;
`;

const Select = styled.select`
  font: inherit;
  font-size: 13px;
  padding: 5px 8px;
  border-radius: 6px;
  border: 1px solid var(--border_color_cell);
  background: var(--bg_control);
  color: var(--color_label-highlighted);
`;

const Bar = styled.div`
  height: 8px;
  border-radius: 4px;
  background: var(--bg_control);
  overflow: hidden;
`;

const Fill = styled.div<{$frac: number}>`
  height: 100%;
  width: ${(p) => Math.max(0, Math.min(1, p.$frac)) * 100}%;
  background: var(--color_accent, #6f8fbf);
  transition: width 0.12s linear;
`;

const LogBox = styled.div`
  flex: 0 0 130px;
  margin: 0 12px 12px;
  padding: 10px 12px;
  border: 1px solid var(--border_color_cell);
  border-radius: 6px;
  background: var(--bg_menu);
  font-family: ui-monospace, Consolas, monospace;
  font-size: 12px;
  line-height: 1.65;
  overflow: auto;
  white-space: pre-wrap;
  color: var(--color_label);
`;

const Banner = styled.div`
  margin: 0 12px 8px;
  padding: 10px 12px;
  border-radius: 6px;
  border: 1px solid var(--color_error);
  color: var(--color_error);
  font-size: 13px;
`;

const Note = styled.div`
  width: 100%;
  font-size: 12px;
  color: var(--color_label);
  line-height: 1.7;
`;

/* ============================================================
 * 组件
 * ============================================================ */
/* 与旧工具 pic-uploader 的 7 个选项一致（index.html:88-96），顺序也一致 */
const SIZES: {key: string; w: number; h: number}[] = [
  {key: 'Screen_size160x120', w: 160, h: 120},
  {key: 'Screen_size160x90', w: 160, h: 90},
  {key: 'Screen_size192x108', w: 192, h: 108},
  {key: 'Screen_size256x144', w: 256, h: 144},
  {key: 'Screen_size200x150', w: 200, h: 150},
  {key: 'Screen_size240x180', w: 240, h: 180},
  {key: 'Screen_size320x240', w: 320, h: 240},
];

type ConnState = 'idle' | 'connecting' | 'ready' | 'busy';

type Prepared = {
  frames: PicFrame[];
  /* 来源概览：尺寸 / 原始帧数 / 保留帧数（已翻译好的完整句子） */
  summary: string;
  kind: 'static' | 'anim';
};

export const ScreenNativePane = () => {
  const {t, i18n} = useTranslation();

  const [conn, setConn] = useState<ConnState>(session.transport ? 'ready' : 'idle');
  const [status, setStatus] = useState('');
  const [tone, setTone] = useState<'ok' | 'warn' | 'err' | undefined>(
    session.transport ? (session.protoOk ? 'ok' : 'err') : undefined,
  );
  const [banner, setBanner] = useState('');
  const [logs, setLogs] = useState<string[]>([]);
  const [sizeIdx, setSizeIdx] = useState(0);
  const [maxFrames, setMaxFrames] = useState(30);
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [previewUrl, setPreviewUrl] = useState('');
  const [fileName, setFileName] = useState('');
  const [over, setOver] = useState(false);
  const [progress, setProgress] = useState({frac: 0, text: ''});

  const fileRef = useRef<HTMLInputElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  /* 当前文件：改尺寸 / 帧数上限时要拿它自动重算（旧工具就是这么做的） */
  const currentFileRef = useRef<File | null>(null);
  /* 预览 URL 用 ref 存，让 prepare 不依赖 state，避免回调被反复重建 */
  const previewUrlRef = useRef('');
  /* 竞态守卫：连点两次尺寸时，先发起的那次可能后回来 */
  const jobRef = useRef(0);
  /* 状态文字随语言切换要重算：用 ref 拿到最近一次的原始状态值。
     只存原始 vid/pid，句子在 renderStatus 里现拼 —— 这样切语言后半句会整体重译。 */
  const statusRef = useRef<{vid: string; pid: string; protoVer: number; ok: boolean} | null>(
    session.transport
      ? {vid: session.portVid, pid: session.portPid, protoVer: PROTO_VERSION, ok: session.protoOk}
      : null,
  );

  const log = useCallback((msg: string) => {
    const ts = new Date().toLocaleTimeString('zh-CN', {hour12: false});
    setLogs((prev) => {
      const next = [...prev, '[' + ts + '] ' + msg];
      return next.length > 200 ? next.slice(next.length - 200) : next;
    });
  }, []);

  /* 把 session 状态渲染成一句话（语言切换时会重跑）。
     注意：两句都要现翻译，不能有任何一个字是"存下来"的。 */
  const renderStatus = useCallback(
    (st: {vid: string; pid: string; protoVer: number; ok: boolean} | null) => {
      if (!st) {
        setStatus(t('Screen_notConnected'));
        return;
      }
      setStatus(
        t('Screen_connected', {vid: st.vid, pid: st.pid}) +
          ' · ' +
          (st.ok
            ? t('Screen_protoSuffix', {v: st.protoVer})
            : t('Screen_protoMismatchSuffix')),
      );
    },
    [t],
  );

  /* 首次进入 & 语言切换时刷新状态文字 */
  useEffect(() => {
    renderStatus(statusRef.current);
  }, [renderStatus]);

  /* 语言切换时清掉"已经翻译成句子"的文字，让它们用新语言重新生成。
     status 不在此列 —— 它由 renderStatus + statusRef 负责重算。 */
  useEffect(() => {
    setLogs([]);
    setProgress((p) => ({frac: p.frac, text: ''}));
    setBanner('');
  }, [i18n.language]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs]);

  /* 只在本页真正卸载时释放预览 URL。
     ⚠️ 不要写成 [previewUrl] 依赖 —— 那样每次换图都会把"上一张"的 URL revoke 掉，
     而图片元素可能还在用它，表现为预览闪一下变空白。 */
  useEffect(() => {
    return () => {
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    };
  }, []);

  /* 把异常翻成用户能读的一句话：
     有 status ⇒ 用映射表（避开 lib/pic 里的中文常量）；超时单独一条；其余原样。 */
  const errorText = useCallback(
    (e: unknown) => {
      const status = (e as {status?: unknown}).status;
      if (typeof status === 'number' && STATUS_KEY[status]) {
        return t(STATUS_KEY[status]);
      }
      if ((e as Error)?.name === 'AckTimeout') return t('err_timeout');
      return (e as Error)?.message || String(e);
    },
    [t],
  );

  /* ---------------- 连接 ---------------- */
  const connect = async () => {
    const api = serialApi();
    if (!api) {
      setBanner(t('Screen_noWebSerial'));
      return;
    }
    if (!window.isSecureContext) {
      setBanner(t('Screen_notSecure'));
      return;
    }
    setBanner('');

    /* ⚠️ 不带 filters：给 filters 时若 VID/PID 对不上，列表会是空的，
       用户只会看到"没有可用端口"，反而查不出是驱动问题还是 PID 问题。
       手动选一次更透明（与独立传图工具的行为一致）。 */
    let port: SerialPortWithInfo;
    try {
      port = await api.requestPort();
    } catch {
      log(t('Screen_connectCancelled'));
      return;
    }

    setConn('connecting');
    setStatus(t('Screen_opening'));
    try {
      const tr = new SerialTransport();
      await tr.open(port);
      session.transport = tr;
      session.proto = new PicProtocol(tr, log);

      const info = port.getInfo ? port.getInfo() : {};
      const vid = info.usbVendorId
        ? '0x' + info.usbVendorId.toString(16).padStart(4, '0')
        : '?';
      const pid = info.usbProductId
        ? '0x' + info.usbProductId.toString(16).padStart(4, '0')
        : '?';
      session.portVid = vid;
      session.portPid = pid;
      log(t('Screen_portOpened', {vid, pid}));
      if (tr.droppedBytes > 0) {
        log(t('Screen_staleBytes', {n: tr.droppedBytes}));
      }

      log('PING …');
      const ack = await session.proto.ping();
      /* 固件把协议版本号放在 PING 的 written 字段；构建标识在 aux */
      session.build = ack.aux;
      session.protoOk = ack.written === PROTO_VERSION;
      if (session.protoOk) {
        log(
          t('Screen_pingOk', {
            v: ack.written,
            credit: ack.credit,
            build: ack.aux
              ? '0x' + ack.aux.toString(16).toUpperCase().padStart(4, '0')
              : t('Screen_noBuildTag'),
          }),
        );
        statusRef.current = {
          vid: session.portVid,
          pid: session.portPid,
          protoVer: PROTO_VERSION,
          ok: true,
        };
        renderStatus(statusRef.current);
        setTone('ok');
      } else {
        log(t('Screen_protoMismatchLog', {fw: ack.written, web: PROTO_VERSION}));
        setBanner(t('Screen_protoMismatchBanner', {fw: ack.written, web: PROTO_VERSION}));
        statusRef.current = {
          vid: session.portVid,
          pid: session.portPid,
          protoVer: ack.written,
          ok: false,
        };
        renderStatus(statusRef.current);
        setTone('err');
      }
      setConn('ready');
    } catch (e) {
      session.transport = null;
      session.proto = null;
      session.protoOk = false;
      statusRef.current = null;
      setConn('idle');
      setStatus(t('Screen_notConnected'));
      setTone('err');
      const msg = errorText(e);
      setBanner(t('Screen_openFailed', {err: msg}));
      log(t('Screen_openFailed', {err: msg}));
      log(t('Screen_openFailedHint'));
    }
  };

  const disconnect = async () => {
    if (!session.transport) return;
    setConn('busy');
    try {
      await session.transport.close();
    } catch {
      /* 已断开 */
    }
    session.transport = null;
    session.proto = null;
    session.protoOk = false;
    session.portVid = '';
    session.portPid = '';
    statusRef.current = null;
    setConn('idle');
    setStatus(t('Screen_notConnected'));
    setTone(undefined);
    log(t('Screen_disconnected'));
  };

  /* ---------------- 选图 ---------------- */
  const prepare = useCallback(
    async (file: File) => {
      const {w, h} = SIZES[sizeIdx];
      if (!file.type.startsWith('image/')) {
        log(t('Screen_notImage', {name: file.name}));
        return;
      }
      const job = ++jobRef.current;
      currentFileRef.current = file;
      setBanner('');
      setPrepared(null);
      setProgress({frac: 0, text: ''});
      setFileName(file.name);
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
      const url = URL.createObjectURL(file);
      previewUrlRef.current = url;
      setPreviewUrl(url);

      const t0 = performance.now();
      try {
        let p: Prepared;
        if (file.type === 'image/gif') {
          log(t('Screen_decodingGif', {name: file.name, w, h}));
          const g = await decodeGifFrames(file, w, h, maxFrames);
          p = {
            frames: g.frames,
            kind: g.frames.length > 1 ? 'anim' : 'static',
            summary: t('Screen_animSummary', {
              w: g.gifW,
              h: g.gifH,
              orig: g.origFrames,
              kept: g.frames.length,
              sec: (g.totalMs / 1000).toFixed(2),
            }),
          };
          log(
            t('Screen_framesReady', {
              summary: p.summary,
              ms: Math.round(performance.now() - t0),
            }),
          );
        } else {
          log(t('Screen_loadingStatic', {name: file.name, w, h}));
          const s = await imageToRgb565(file, 'contain', w, h);
          p = {
            frames: [{bytes: s.bytes, delay: 100}],
            kind: 'static',
            summary: t('Screen_staticSummary', {w: s.srcW, h: s.srcH}),
          };
          log(t('Screen_loaded', {summary: p.summary}));
        }
        /* 过期结果一律丢弃，否则"最后回来的"可能不是"最后发起的" */
        if (job !== jobRef.current) {
          log(t('Screen_staleResult'));
          return;
        }
        setPrepared(p);
      } catch (e) {
        if (job !== jobRef.current) return;
        const msg = errorText(e);
        setBanner(t('Screen_processFailed', {err: msg}));
        log('[X] ' + msg);
      }
    },
    [t, sizeIdx, maxFrames, log, errorText],
  );

  /*
   * ⭐ 改尺寸 / 帧数上限 → 用当前文件**自动重算**。
   *
   * 为什么必须重算：帧数据（bytes）是按目标尺寸生成的，而 BEGIN 报文里声明的
   * w/h 是"当前下拉框的值"。两者不一致时，固件会按新 w×h 去解旧尺寸的条带表
   * ⇒ 花屏 / 图像撕裂（2026-11-11 实测踩到）。
   * 旧工具 pic-uploader 的 size change 监听里就是直接 loadFile(app.file) 重算
   * （index.html:2015-2021），本页行为与它对齐。
   */
  useEffect(() => {
    const f = currentFileRef.current;
    if (!f) return;
    const s = SIZES[sizeIdx];
    log(t('Screen_regenFrames', {w: s.w, h: s.h}));
    void prepare(f);
    /* prepare 的依赖里就有 sizeIdx / maxFrames，这里不写依赖是刻意的 */
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [sizeIdx, maxFrames]);

  /* ---------------- 上传 ---------------- */
  const upload = async () => {
    if (!session.proto || !prepared) return;
    if (!session.protoOk) {
      setBanner(t('Screen_blockedProto'));
      return;
    }
    const {w, h} = SIZES[sizeIdx];
    setConn('busy');
    setBanner('');
    setProgress({frac: 0, text: t('Screen_preparing')});
    try {
      /* 单帧走无损 RGB565（format=1）；多帧走 256 色调色板（format=3） */
      const use565 = prepared.frames.length === 1;
      const built = buildCompressedPayload(prepared.frames, w, h, use565);
      const crc = crc32(built.payload);

      /* 诊断：把 BEGIN 报文原样打进日志。协议字段错位时这是最快的定位手段
         （旧工具同款，见 pic-uploader/index.html:1886-1891）。
         字节 16..19 = 条带行数(LE) + format(LE)+保留，例如 160×120 单帧应为
         "1e 00 01 00"（30 行 / format=1）。 */
      const bp = makeBeginPayload(
        built.payload.length,
        crc,
        w,
        h,
        prepared.frames.length,
        built.stripRows,
        built.format,
      );
      log(
        t('Screen_beginFrame', {
          len: bp.length,
          bytes: Array.from(bp)
            .map((b) => b.toString(16).padStart(2, '0'))
            .join(' '),
        }),
      );

      log(
        t('Screen_payloadInfo', {
          len: built.payload.length,
          raw: built.rawBytes,
          ratio: (built.rawBytes / Math.max(1, built.payload.length)).toFixed(2),
          fmt: built.format,
          rows: built.stripRows,
          crc: hex32(crc),
        }),
      );
      setProgress({
        frac: 0,
        text: t('Screen_waitingErase', {len: built.payload.length}),
      });

      const res = await session.proto.upload(
        built.payload,
        crc,
        w,
        h,
        prepared.frames.map((f) => f.delay),
        built.stripRows,
        built.format,
        (off, total) => {
          setProgress({
            frac: off / total,
            text: t('Screen_sending', {
              pct: Math.round((off / total) * 100),
              off,
              total,
            }),
          });
        },
        (written, span) => {
          setProgress({
            frac: (written / span) * 0.08 /* 擦除阶段只占进度条前 8% */,
            text: t('Screen_erasing', {
              pct: Math.round((written / span) * 100),
            }),
          });
        },
      );
      const sec = (res.elapsedMs / 1000).toFixed(2);
      setProgress({frac: 1, text: t('Screen_doneIn', {sec})});
      log(t('Screen_uploadFinished', {sec}));

      /* 端到端自证：设备回读整槽并核对页头 CRC。
         ⚠️ 这一步不能省 —— 缺了它，数据错了界面也会显示"完成"，
         用户只能对着花屏猜（2026-11-11 补上）。 */
      log(t('Screen_verifying'));
      await session.proto.verify();
      log(t('Screen_crcOk'));

      /* 再读一次设备元信息：设备认为自己收的是多大的图、几帧、哪个槽。
         这是判断"传错了"还是"固件显示错了"的直接证据。 */
      try {
        const info = await session.proto.info();
        const iw = info.written & 0xffff;
        const ih = (info.written >>> 16) & 0xffff;
        const ifr = info.credit & 0xffff;
        const iseq = (info.credit >>> 16) & 0xffff;
        log(t('Screen_deviceInfo', {w: iw, h: ih, frames: ifr, seq: iseq}));
        if (iw !== w || ih !== h) {
          log(t('Screen_sizeMismatch', {w, h}));
        }
      } catch (e) {
        log(t('Screen_deviceInfoFailed', {err: errorText(e)}));
      }
    } catch (e) {
      const msg = errorText(e);
      setBanner(msg);
      setProgress({frac: 0, text: t('Screen_failed')});
      log('[X] ' + msg);
    } finally {
      setConn(session.transport ? 'ready' : 'idle');
    }
  };

  /* ---------------- 交互 ---------------- */
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setOver(false);
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) void prepare(f);
  };

  const busy = conn === 'connecting' || conn === 'busy';
  const connected = !!session.transport;

  return (
    <Wrapper>
      <Head>
        <strong style={{fontWeight: 500, fontSize: 15}}>{t('Screen_title')}</strong>
        <Status $tone={tone}>{status}</Status>
        <Btn type="button" onClick={connect} disabled={busy || connected}>
          {t('Screen_connect')}
        </Btn>
        <Btn type="button" onClick={disconnect} disabled={busy || !connected}>
          {t('Screen_disconnect')}
        </Btn>
        <Btn type="button" onClick={() => void upload()} disabled={busy || !connected || !prepared}>
          {t('Screen_upload')}
        </Btn>
      </Head>

      {banner ? <Banner>{banner}</Banner> : null}

      <Body>
        <Left>
          <PreviewArea>
            <Drop
              $over={over}
              onClick={() => fileRef.current && fileRef.current.click()}
              onDragOver={(e) => {
                e.preventDefault();
                setOver(true);
              }}
              onDragLeave={() => setOver(false)}
              onDrop={onDrop}
            >
              {previewUrl ? (
                <Preview src={previewUrl} alt={t('Screen_previewAlt')} />
              ) : (
                <span>
                  {t('Screen_dropHint')}
                  <br />
                  <span style={{fontSize: 12}}>{t('Screen_dropHintSub')}</span>
                </span>
              )}
            </Drop>
          </PreviewArea>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            style={{display: 'none'}}
            onChange={(e) => {
              const f = e.target.files && e.target.files[0];
              if (f) void prepare(f);
              e.currentTarget.value = '';
            }}
          />
          <Note>
            {fileName ? (
              <>
                {t('Screen_fileLabel', {name: fileName})}
                {prepared ? '｜' + prepared.summary : '｜' + t('Screen_processing')}
                {prepared
                  ? '｜' +
                    (prepared.frames.length === 1
                      ? t('Screen_lossless')
                      : t('Screen_palette'))
                  : ''}
              </>
            ) : (
              t('Screen_noFile')
            )}
          </Note>
        </Left>

        <Right>
          <Row>
            <Label>{t('Screen_outputSize')}</Label>
            <Select
              value={sizeIdx}
              onChange={(e) => setSizeIdx(Number(e.target.value))}
              disabled={busy}
            >
              {SIZES.map((s, i) => (
                <option key={s.key} value={i}>
                  {t(s.key)}
                </option>
              ))}
            </Select>
          </Row>
          <Row>
            <Label>{t('Screen_frameLimit')}</Label>
            <Select
              value={maxFrames}
              onChange={(e) => setMaxFrames(Number(e.target.value))}
              disabled={busy}
            >
              {[15, 30, 60].map((n) => (
                <option key={n} value={n}>
                  {t('Screen_nFrames', {n})}
                </option>
              ))}
            </Select>
          </Row>
          <Note>{t('Screen_regenHint')}</Note>

          <Bar>
            <Fill $frac={progress.frac} />
          </Bar>
          <Note>{progress.text || t('Screen_ready')}</Note>

          <Note>{connected ? t('Screen_stayConnected') : t('Screen_clickConnect')}</Note>
        </Right>
      </Body>

      <LogBox ref={logRef}>{logs.join('\n')}</LogBox>
    </Wrapper>
  );
};
