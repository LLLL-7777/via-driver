import {useEffect, useRef, useState} from 'react';
import styled from 'styled-components';
import picHtml from '../../generated/pic-uploader.html?raw';

/*
 * Screen 页（4.3a）：用 iframe（srcdoc）装现成的传图工具，先打通链路。
 *
 * 为什么先用 iframe 而不是直接重写 UI：
 *   1. 要验证两个"从没验过"的前提 ——
 *      ① Web Serial 在 VIA 页面的 iframe 里能否正常选到 COM 口；
 *      ② WebHID（改键）与 Web Serial（传图）能否同时持有同一个设备。
 *   2. 传图工具逻辑本来就是分层的（协议层零依赖、传输层只依赖浏览器 API），
 *      确认可行后再原样搬成 TS 模块（4.3b），不用返工。
 *
 * ⚠️ 三次踩坑记录（2026-10-26）：
 *   ① 首版 iframe 只写 `flex: 1` → #root（display:flex, height:100%）布局里高度塌成 0。
 *   ② 改 `height:100%` 仍塌 → 改用 `position: fixed` 贴视口，尺寸确定。
 *   ③ 致命的一个：把 HTML 放 public/pic-uploader/ 走静态服务，结果请求被 SPA 回退
 *      吃成 VIA 首页（iframe 标题读出来是「VIA」），于是 iframe 里又是一个 VIA、
 *      再一个 VIA…高度每层递减 80px。
 *      ⇒ 改为 `?raw` 导入 + `srcDoc`：文档由父页直接注入，不走 HTTP。
 *      源文件是 `pic-uploader/index.html`，由 scripts/sync-pic-uploader.js 生成到
 *      `src/generated/`（构建产物，已 gitignore）。
 */

/* 顶部导航栏总高：global.tsx 里 height:25px + padding:12px 0 = 49px */
const MENU_BAR_HEIGHT = 49;

const Wrapper = styled.div`
  position: fixed;
  top: ${MENU_BAR_HEIGHT}px;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 3;
  display: flex;
  flex-direction: column;
  background: #14161a;
`;

const Bar = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 6px 12px;
  font-size: 12px;
  line-height: 1.5;
  color: #9aa2b1;
  background: #1c1f26;
  border-bottom: 1px solid #2b303a;
  flex: 0 0 auto;

  button {
    font: inherit;
    font-size: 12px;
    padding: 2px 10px;
    border-radius: 5px;
    border: 1px solid #2b303a;
    background: #242833;
    color: #cfd6e0;
    cursor: pointer;
  }

  .warn {
    color: #f0b429;
  }
`;

const Frame = styled.iframe`
  display: block;
  width: 100%;
  flex: 1;
  min-height: 0;
  border: 0;
  background: #14161a;
`;

type FrameInfo = {
  height: number;
  title: string;
  textLen: number;
};

export const ScreenPane = () => {
  const [info, setInfo] = useState<FrameInfo | null>(null);
  const [nonce, setNonce] = useState(0);
  const frameRef = useRef<HTMLIFrameElement>(null);

  /* 尺寸 + 内容自检。
     ⚠️ 本页现在是**常驻挂载**（切走只是 display:none），所以首屏加载时高度是 0。
        高度 <= 0 时不更新状态，免得把"隐藏时的 0"当成结论存下来。 */
  const measure = () => {
    const el = frameRef.current;
    if (!el || el.clientHeight <= 0) {
      return;
    }
    let title = '';
    let textLen = 0;
    try {
      title = el.contentDocument?.title ?? '';
      textLen = (el.contentDocument?.body?.innerText ?? '').trim().length;
    } catch {
      /* 跨源才读不到；srcdoc 同源，正常不会走到 */
    }
    setInfo({height: el.clientHeight, title, textLen});
  };

  /* display:none → 显示的瞬间高度从 0 变成实际值，ResizeObserver 正好能捕捉到，
     比 onLoad 可靠（常驻挂载时 onLoad 只在首次触发一次）。 */
  useEffect(() => {
    const el = frameRef.current;
    if (!el || typeof ResizeObserver === 'undefined') {
      return;
    }
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const healthy = !!info && info.height > 100 && info.textLen > 0;

  return (
    <Wrapper>
      <Bar>
        <span>
          {!info && '正在加载传图工具…'}
          {info && healthy && `屏幕传图 · 已加载（高 ${info.height}px）`}
          {info && !healthy && (
            <span className="warn">
              {`诊断：iframe 高 ${info.height}px，正文 ${info.textLen} 字，标题「${
                info.title || '空'
              }」`}
            </span>
          )}
        </span>
        <button type="button" onClick={() => setNonce((n) => n + 1)}>
          重新加载
        </button>
      </Bar>
      <Frame
        key={nonce}
        ref={frameRef}
        srcDoc={picHtml}
        title="Screen / Picture upload"
        allow="serial; hid"
        onLoad={measure}
      />
    </Wrapper>
  );
};
