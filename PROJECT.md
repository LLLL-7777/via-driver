# via-driver · 使用与开发说明

> 这是我们自己的键盘网页驱动（fork 自 [the-via/app](https://github.com/the-via/app)，GPL-3.0）。
> 上游的 `README.md` 保持原样不动（方便以后跟官方对比/合并），本项目的说明都写在这里。
>
> 建立：2026-10-26

---

## 一、怎么跑

### 1. 开发模式（改代码用，带热更新）

双击 **`dev.bat`**，等它打出 `ready in xxx ms`，然后用 **Chrome / Edge** 打开：

```
http://127.0.0.1:5173
```

`dev.bat` 会依次做三件事：

| 步骤 | 作用 |
|---|---|
| `node scripts/build-definitions-local.js` | 把 `keyboard-definitions/v3/*.json` 转换并生成到 `public/definitions/` |
| `node scripts/sync-pic-uploader.js` | 把工作空间的 `pic-uploader/index.html` 复制成 `src/generated/pic-uploader.html`（给 iframe 用）|
| `npx vite --host 127.0.0.1 --port 5173 --strictPort` | 起开发服务器 |

⚠️ **必须用 `127.0.0.1`，不要用 `localhost`。** 浏览器把两者当作**不同的站点**，IndexedDB 里的东西（导入过的定义、串口授权）不互通。换地址等于换了个新网站。

### 2. 打包 + 双击运行（给同事/客户用）

```bash
npm run build          # 产物在 dist/（约 9.6 MB）
```

然后双击 **`启动网页驱动.bat`**：

- 起一个本地静态服务（`127.0.0.1`，端口自动从 **18755** 起找，锁 **18754** 保证单实例）
- 自动用 Chrome / Edge 打开
- **关掉黑窗口即停止服务**

端口和传图工具（`pic-uploader`，锁 18764 / 起 18765）**特意错开**，两个可以同时开着。

⚠️ **为什么必须有本地服务**：`WebHID`（改键）和 `Web Serial`（传图）只在 **secure context** 下暴露。直接双击 `dist/index.html`（`file://`）时 `navigator.hid` / `navigator.serial` 都是 `undefined`，页面等于废的。`http://127.0.0.1` 被浏览器视同 secure context，所以要用本地服务"递"这个页面。

⚠️ **浏览器只支持 Chromium 系**（Chrome / Edge）。Firefox、Safari 没有 WebHID / Web Serial。

⚠️ **改了前端代码要重新 `npm run build`**，双击运行的是 `dist/` 里的构建产物，不是源码。

---

## 二、怎么加一个新的键盘定义

### 1. 放文件

```
keyboard-definitions/v3/<vpid>.json
```

- **文件名必须是 vpid，十进制**：`vpid = vendorId × 65536 + productId`
  - 例：`0x0483 × 65536 + 0x572C = 75716396`
- **文件内容就是固件仓库里的 `via.json`**（同一个文件，可以原样拷）
- 格式是给"人"写的那套：`layouts.keymap` 用 `"0,0"` 这种行列字符串

### 2. 构建脚本会自动处理，不用手改

`scripts/build-definitions-local.js` 会依次：

1. 用 `@the-via/reader` 的 `keyboardDefinitionV3ToVIADefinitionV3()` **转换**：
   - `layouts.keymap`（`"0,0"` 字符串）→ `layouts.keys[]`（带 x/y/w/h）
   - 自动补上 **`vendorProductId`** 字段
2. 顺手做 **schema 校验 + 键位越界检查** —— 定义写错会在**构建期**报错，不会等到浏览器里才炸
3. 写 `public/definitions/v3/<vpid>.json`
4. 自动生成 `public/definitions/supported_kbs.json`（扫描目录得出，**不用手写**）
5. 写 `public/definitions/hash.json`（时间戳，用来让浏览器放弃旧缓存）

### 3. 必须重启

`vite.config.ts:8` 在**启动那一刻**读 `hash.json`。所以**改完定义必须重启 `dev.bat`**，热更新不会刷新 hash。

### 4. 两个容易踩的点

| 坑 | 说明 |
|---|---|
| **不能直接把 `via.json` 拷进 `public/definitions/`** | 服务给浏览器的是**预处理格式**（`layouts.keys[]` + 必须有 `vendorProductId`），原始格式浏览器不认 |
| **协议版本决定要 v3 还是 v2** | `devicesThunks.ts:206`：设备上报协议 `>= 11` 要 v3，否则 v2。我们固件是 `0x000C`(12) ⇒ v3 |

---

## 三、将来怎么改成"在线托管"（暂时不做）

现在这套东西**本来就是纯静态站点**（`dist/` 就是一堆 html/js/png），所以转在线几乎不用改代码：

1. `npm run build`
2. 把 `dist/` 整个目录上传到任意静态托管（Cloudflare Pages / Vercel / 公司服务器 / OSS+CDN）
3. 用 **HTTPS** 访问（secure context 要求，和 `127.0.0.1` 同理）

届时需要额外处理三件事：

| 事项 | 说明 |
|---|---|
| **HTTPS 证书** | 没有它 WebHID / Web Serial 不可用 |
| **GPL-3.0** | fork 自 VIA，分发（含在线提供）需要**提供源码**。可以放一个公开仓库，页面里给链接 |
| **隐私/合规** | 纯静态、不收集数据的话风险很低；但别顺手加统计脚本 |

**参考：QK80MK2 就是"纯在线"做法** —— 官方产品页原话是 *"QK's custom VIA web configurator"*，一个网址打开就用，不装任何东西。有趣的是他们老产品用的是桌面 App（`QK Config for Win`），**是他们从桌面迁移到了网页**，方向和我们一致。

不过我们**短期仍然用本地启动器**：POC 阶段离线可用、零合规负担更重要；工厂/售后场景经常没网。

---

## 四、已知坑（都是实际踩过的，别再踩一遍）

| # | 现象 | 根因 | 结论 |
|---|---|---|---|
| 1 | `npm install` 跑 7 分钟然后 `ECONNRESET` | `via-keyboards` 是 **git 依赖**（克隆整个 GitHub 仓库再在里面装 388 个包）| 已从 `package.json` 删除。它只用于"生成全世界键盘定义"，我们不需要。要恢复见 git 历史 |
| 2 | 静态文件放进 `public/pic-uploader/`，iframe 里却显示了 VIA 自己（无限套娃、高度每层递减 80px）| 请求被 **SPA 回退**吃掉，返回的是 `index.html` | 改为 `import html from '...?raw'` + `<iframe srcDoc>`，**完全不走 HTTP** |
| 3 | 切到别的标签再切回来，串口断了、图片没了 | VIA 路由**只渲染当前页**，切走即卸载 → iframe 销毁 | 改成 **常驻挂载**（`Routes.tsx` 的 `PersistentPane`，用 `display:none` 隐藏），照抄官方 HID Console 的做法 |
| 4 | 在 `/screen` 上按 F5 变成 404 | SPA 用 History API 改了地址栏，磁盘上没有 `/screen` 这个文件 | `launcher.py` 里加了 SPA 回退（无扩展名且文件不存在 → 交给 `index.html`）|
| 5 | 传 PNG/JPEG 也变成多帧、屏幕上有帧号 | 静态图分支误读了「帧数上限」（默认 30），把静态图复制成 30 帧；水印勾着就每帧烧数字 | 改为按 `ImageDecoder` 的真实 `frameCount` 判断；静态图固定 1 帧；水印只在「复制成多帧」调试模式下可用 |

---

## 五、改动面 & 与上游同步

我们尽量只碰必要的地方，方便以后合并官方更新：

| 类型 | 文件 |
|---|---|
| 修改（上游文件）| `package.json`、`package-lock.json`、`src/utils/pane-config.ts`、`src/Routes.tsx`、`.gitignore` |
| 新增（我们自己的）| `src/components/panes/screen.tsx`、`scripts/build-definitions-local.js`、`scripts/sync-pic-uploader.js`、`launcher.py`、`dev.bat`、`启动网页驱动.bat`、`keyboard-definitions/`、本文件 |

- 远端 `origin` = 我们的 fork（可推可改）
- 远端 `upstream` = 官方仓库（**只读**，用来对照/将来升级）
- **策略：锁版本，不追上游。** VIA 迭代很快，POC 阶段追新版只会不断返工
- 想看我们相对官方改了什么：`git fetch upstream && git diff upstream/main --stat`

---

## 六、页面结构备忘（改 UI 时有用）

| 页面 | 路径 | 组件 |
|---|---|---|
| 改键 Configure | `/` | `components/panes/configure.tsx` |
| **屏幕传图 Screen** | `/screen` | `components/panes/screen.tsx` ← 我们加的 |
| 键盘测试 | `/test` | `components/panes/test.tsx` |
| 设计 Design | `/design` | `components/panes/design.tsx` |
| 设置 / Debug / HID Console | … | 见 `src/utils/pane-config.ts` |

**加一个新页面 = 在 `src/utils/pane-config.ts` 的数组里加一项**（`{key, component, icon, title, path}`）。
如果要像 Screen 那样**切走不断连**，还得去 `src/Routes.tsx` 把它从 `RouteComponents` 里过滤掉、改成 `PersistentPane`。
