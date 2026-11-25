import {UnconnectedGlobalMenu} from './components/menus/global';
import {Route} from 'wouter';
import PANES from './utils/pane-config';
import {Home} from './components/Home';
import {createGlobalStyle} from 'styled-components';
import {CanvasRouter as CanvasRouter3D} from './components/three-fiber/canvas-router';
import {CanvasRouter as CanvasRouter2D} from './components/two-string/canvas-router';
import {TestContext} from './components/panes/test';
import {useMemo, useState} from 'react';
import {OVERRIDE_HID_CHECK} from './utils/override';
import {useAppSelector} from './store/hooks';
import {getRenderMode, getShowConsoleTab} from './store/settingsSlice';
import {useLocation} from 'wouter';
import {HIDConsole} from './components/panes/hid-console';
/* B2：Screen 页改为原生化实现（不用 iframe）。
   旧实现 src/components/panes/screen.tsx 保留未删 —— 想回退只需把这里和
   pane-config.ts 的 import 改回 ScreenPane（两行）。 */
import {ScreenNativePane} from './components/panes/screen-native';
import styled from 'styled-components';

const GlobalStyle = createGlobalStyle`
  *:focus {
    outline: none;
  }
`;

const PersistentPane = styled.div<{$active: boolean}>`
  display: ${({$active}) => ($active ? 'flex' : 'none')};
  flex: 1;
  min-height: 0;
`;

export default () => {
  const hasHIDSupport = 'hid' in navigator || OVERRIDE_HID_CHECK;

  const renderMode = useAppSelector(getRenderMode);
  const showConsoleTab = useAppSelector(getShowConsoleTab);
  const [location] = useLocation();
  const RouteComponents = useMemo(
    () =>
      /* ⚠️ 'screen' 与 'console' 一样要从路由里摘出来，改成**常驻挂载**：
         切走时用 display:none 隐藏，而不是卸载。
         原因：Screen 页里是个 iframe，卸载 = Web Serial 连接和已选图片全丢，
         切回来必须重新点「连接」、重新选图（2026-10-26 实测）。
         官方 HID Console 用的就是这个模式，我们照抄。 */
      PANES.filter((pane) => pane.key !== 'console' && pane.key !== 'screen').map(
        (pane) => {
          return (
            <Route component={pane.component} key={pane.key} path={pane.path} />
          );
        },
      ),
    [],
  );

  const CanvasRouter = renderMode === '2D' ? CanvasRouter2D : CanvasRouter3D;
  const testContextState = useState({clearTestKeys: () => {}});
  return (
    <>
        <TestContext.Provider value={testContextState}>
          <GlobalStyle />
          {hasHIDSupport && <UnconnectedGlobalMenu />}
          <CanvasRouter />

          <Home hasHIDSupport={hasHIDSupport}>
            {RouteComponents}
            {showConsoleTab && (
              <PersistentPane $active={location === '/console'}>
                <HIDConsole isActive={location === '/console'} />
              </PersistentPane>
            )}
            <PersistentPane $active={location === '/screen'}>
              <ScreenNativePane />
            </PersistentPane>
          </Home>
        </TestContext.Provider>
    </>
  );
};
