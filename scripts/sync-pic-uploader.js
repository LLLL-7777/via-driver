/*
 * 把独立的传图工具"打包"成前端可 import 的原始 HTML 字符串。
 *
 * 为什么不用 public/ 静态文件：
 *   2026-10-26 实测踩坑 —— 把 index.html 放进 public/pic-uploader/ 后，
 *   iframe 请求 /pic-uploader/index.html 拿到的却是 VIA 自己的首页（标题 "VIA"），
 *   即被 SPA 回退吃掉了，结果 iframe 里套一个 VIA，无限递归、高度一层层缩。
 *   改用 `?raw` 导入 + iframe srcdoc：文档由父页面直接提供，
 *   完全不走 HTTP，也就不存在"服务不到"的问题；vite build 后同样成立。
 *
 * 单一事实来源 = 工作空间上一级的 `pic-uploader/index.html`。
 * 那个工具本身仍可独立使用（双击 启动传图.bat），这里只生成一份给 VIA 用。
 *
 * 产物：src/generated/pic-uploader.html（已 gitignore，属构建产物）
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const src = path.resolve(root, '..', 'pic-uploader', 'index.html');
const outDir = path.join(root, 'src', 'generated');
const out = path.join(outDir, 'pic-uploader.html');

if (!fs.existsSync(src)) {
  console.error(`[pic] 找不到源文件: ${src}`);
  console.error('      传图工具应位于工作空间的 pic-uploader/index.html');
  process.exit(1);
}

fs.mkdirSync(outDir, {recursive: true});
fs.copyFileSync(src, out);

const kb = (fs.statSync(out).size / 1024).toFixed(1);
console.log(
  `[pic] pic-uploader/index.html -> src/generated/pic-uploader.html (${kb} KB)`,
);
