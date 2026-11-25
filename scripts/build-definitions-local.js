/*
 * 本地键盘定义构建脚本（替代官方的 scripts/build-definitions.js）
 *
 * 官方脚本调用 `via-keyboards`，把全世界上千个键盘定义生成到 public/definitions。
 * 我们这个 fork 只需要自家键盘，所以改成"只处理本地定义 + 官方转换函数"：
 *
 *   keyboard-definitions/v3/<任意名字>.json   （人写的原始格式，和固件仓库的 via.json 同一种）
 *        --keyboardDefinitionV3ToVIADefinitionV3()-->  官方预处理格式
 *   public/definitions/v3/<vendorProductId>.json
 *   public/definitions/supported_kbs.json    扫描输出目录自动生成
 *   public/definitions/hash.json             构建时间戳（让浏览器放弃旧定义缓存）
 *
 * ⚠️ 为什么不能直接拷 via.json：
 *   1. 官方给浏览器的 v3 定义里 layouts 是 {width,height,optionKeys,keys[]} 预处理格式，
 *      我们手写的是 {keymap:[["0,0",...]]}；
 *   2. 定义文件必须带 vendorProductId 字段 —— src/store/definitionsSlice.ts:380 拿它当字典键，
 *      缺了就认不到设备。
 *   官方转换函数会同时完成这两件事，并做 schema 校验 + 键位越界检查（错了构建期就报错）。
 *
 * vpid = vendorId * 65536 + productId（与 src/utils/hid-keyboards.ts:6-9 一致）
 *   当前键盘：0x0483 * 65536 + 0x572C = 75716396
 *
 * 加载链路（实读 src/utils/device-store.ts）：
 *   index.html:28 注入 hash -> device-store.ts:71 读 hash
 *   device-store.ts:77  拉 /definitions/supported_kbs.json
 *   device-store.ts:125 拉 /definitions/v3/<vpid>.json
 *   协议版本 >= 11 才要 v3（src/store/devicesThunks.ts:206；本固件为 0x000C）
 */
const fs = require('fs');
const path = require('path');

// @the-via/reader 加载时会用 ajv 编译 schema，往控制台刷几十行 strict mode 警告。
// 静音包住 require + 转换，只在真的校验失败时把错误打出来。
const realWarn = console.warn;
const realError = console.error;
const mute = () => {
  console.warn = () => {};
  console.error = () => {};
};
const unmute = () => {
  console.warn = realWarn;
  console.error = realError;
};

let reader;
mute();
try {
  reader = require('@the-via/reader');
} finally {
  unmute();
}
const {keyboardDefinitionV3ToVIADefinitionV3} = reader;

const root = path.resolve(__dirname, '..');
const srcV3 = path.join(root, 'keyboard-definitions', 'v3');
const outDir = path.join(root, 'public', 'definitions');
const outV3 = path.join(outDir, 'v3');

if (!fs.existsSync(srcV3)) {
  console.error(`[defs] 找不到源目录: ${srcV3}`);
  process.exit(1);
}

fs.mkdirSync(outV3, {recursive: true});

const files = fs.readdirSync(srcV3).filter((f) => f.endsWith('.json')).sort();

if (files.length === 0) {
  console.warn('[defs] 源目录里没有任何 .json 定义文件');
}

const produced = [];
const written = [];

files.forEach((file) => {
  const raw = fs.readFileSync(path.join(srcV3, file), 'utf8');
  let definition;
  mute();
  try {
    definition = keyboardDefinitionV3ToVIADefinitionV3(JSON.parse(raw));
  } catch (e) {
    unmute();
    realError(`[defs] 定义校验失败: ${file}`);
    realError(`       ${String(e.message).split('\n')[0]}`);
    process.exit(1);
  } finally {
    unmute();
  }
  const outName = `${definition.vendorProductId}.json`;
  fs.writeFileSync(
    path.join(outV3, outName),
    JSON.stringify(definition, null, 2) + '\n',
  );
  produced.push(definition);
  written.push(outName);
  console.log(
    `[defs] ${file} -> v3/${outName}  («${definition.name}», ${definition.layouts.keys.length} 键)`,
  );
});

// 清掉已经不存在于源目录的残留定义
fs.readdirSync(outV3)
  .filter((f) => f.endsWith('.json') && !written.includes(f))
  .forEach((f) => {
    fs.unlinkSync(path.join(outV3, f));
    console.log(`[defs] 移除残留: ${f}`);
  });

const index = {
  generatedAt: Date.now(),
  version: 'local-4.2',
  theme: {},
  vendorProductIds: {
    v2: [],
    v3: produced.map((d) => d.vendorProductId),
  },
};
fs.writeFileSync(
  path.join(outDir, 'supported_kbs.json'),
  JSON.stringify(index, null, 2) + '\n',
);

const hash = String(Date.now());
fs.writeFileSync(path.join(outDir, 'hash.json'), JSON.stringify(hash) + '\n');

console.log(`[defs] 共 ${produced.length} 份定义，vpid = ${index.vendorProductIds.v3.join(', ')}`);
console.log(`[defs] hash = ${hash}`);
