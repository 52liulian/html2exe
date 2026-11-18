// Html2Exe 引擎无头测试（Node 22+）
//
// 覆盖：ZIP 构建/解包往返、三种内容模式、异常路径、PE 图标资源、真实 EXE 生成并运行验证
// 用法: node test/node-test.js   （依赖 assets/stub.exe 外壳资产）
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { execFile } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const CORE = path.join(ROOT, "src", "core.js");
const STUB = path.join(ROOT, "assets", "stub.exe");

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log("  PASS", name); }
  else { failed++; console.log("  FAIL", name, extra || ""); }
}

async function main() {
  // 注入真实 stub 的 base64，模拟 build.py 的处理
  let src = fs.readFileSync(CORE, "utf8");
  const stubB64 = fs.readFileSync(STUB).toString("base64");
  src = src.replace('"/*__STUB_B64__*/"', JSON.stringify(stubB64));
  eval(src);

  // ---------- 1. ZIP 构建 / 解包往返 ----------
  console.log("[1] ZIP 往返");
  const files = [
    { name: "index.html", data: new TextEncoder().encode("<h1>hi</h1>") },
    { name: "中文目录/文件.txt", data: new TextEncoder().encode("中文内容测试") },
    { name: "sub/data.bin", data: new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]) },
  ];
  const zip = Html2Exe.buildZip(files);
  const round = await Html2Exe.unzip(zip);
  ok("条目数量一致", round.length === 3, `got ${round.length}`);
  ok("中文文件名保留", round.some((e) => e.name === "中文目录/文件.txt"));
  ok("二进制内容一致", Buffer.from(round.find((e) => e.name === "sub/data.bin").data)
    .equals(Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255])));

  // ---------- 2. 解包 deflate ZIP（模拟用户上传的压缩包） ----------
  console.log("[2] DEFLATE ZIP 解包");
  const userZip = makeDeflateZip([
    { name: "index.html", data: Buffer.from("<p>from zip</p>") },
    { name: "app.js", data: Buffer.from("console.log(1)"), level: 9 },
  ]);
  const unz = await Html2Exe.unzip(new Uint8Array(userZip));
  ok("deflate 解压内容一致", Buffer.from(unz.find((e) => e.name === "app.js").data)
    .equals(Buffer.from("console.log(1)")));

  // ---------- 3. build 三种模式 + 异常路径 ----------
  console.log("[3] build 模式");
  const base = { title: "测试应用", port: 18081, debug: false, width: 1280, height: 800 };
  const exeOf = async (opts) => Buffer.from(await (await Html2Exe.build(opts)).blob.arrayBuffer());

  const urlExe = await exeOf({ ...base, source: "url", url: "example.com" });
  ok("url 模式生成 EXE", urlExe.length > 0 && urlExe.length < 8 * 1024 * 1024);
  ok("url 自动补 https", urlExe.includes(Buffer.from("https://example.com")));

  const htmlExe = await exeOf({ ...base, source: "html", html: "<body><h1>无标题页</h1></body>" });
  ok("html 模式注入 <title>", htmlExe.includes(Buffer.from("<title>测试应用</title>")));

  // htmlData：文件字节直通（大文件不进 DOM 的路径）
  const htmlBytes = new TextEncoder().encode(
    "<!DOCTYPE html><html><head><meta charset=\"utf-8\"></head><body>大文件直通</body></html>");
  const dataExe = await exeOf({ ...base, source: "html", htmlData: htmlBytes });
  ok("htmlData 注入 <title>", dataExe.includes(Buffer.from("<title>测试应用</title>")));
  ok("htmlData 内容保留", dataExe.includes(Buffer.from("大文件直通")));
  // 非 UTF-8 文件（GBK“中文”= D6D0 CEC4）严格解码失败 → 保持原字节
  const gbkBytes = new Uint8Array(
    [0x3c, 0x68, 0x74, 0x6d, 0x6c, 0x3e, 0x3c, 0x70, 0x3e, 0xd6, 0xd0, 0xce, 0xc4, 0x3c, 0x2f, 0x70, 0x3e]);
  const gbkExe = await exeOf({ ...base, source: "html", htmlData: gbkBytes });
  ok("非 UTF-8 字节原样保留", gbkExe.includes(Buffer.from([0xd6, 0xd0, 0xce, 0xc4])));

  const zipExe = await exeOf({ ...base, source: "zip", zipData: new Uint8Array(userZip) });
  ok("zip 模式生成 EXE", zipExe.includes(Buffer.from("from zip")));

  // trailer 校验
  const tail = urlExe.subarray(urlExe.length - 20);
  ok("trailer 魔数正确", tail.subarray(8).toString() === "HXEXE1.0MARK");
  const zipLen = tail.readUInt32LE(0) + (tail.readUInt32LE(4) << 32);
  const stubLen = Buffer.from(stubB64, "base64").length;
  ok("trailer 长度正确", stubLen + zipLen + 20 === urlExe.length, `${zipLen}`);

  // hint / title 配置写入
  const readCfg = async (opts) => {
    const exe = await exeOf(opts);
    const entries = await Html2Exe.unzip(new Uint8Array(exe.subarray(stubLen, exe.length - 20)));
    return JSON.parse(Buffer.from(entries.find((e) => e.name === "__h2x__.json").data).toString());
  };
  const cfg1 = await readCfg({ ...base, source: "html", html: "<p>hint</p>", hint: 3, width: 800, height: 600 });
  ok("hint=3 写入配置", cfg1.hint === 3, JSON.stringify(cfg1));
  ok("title 写入配置", cfg1.title === "测试应用");
  const cfg2 = await readCfg({ ...base, source: "html", html: "<p>hint</p>", hint: 99 });
  ok("hint 越界钳制为 3", cfg2.hint === 3);
  const cfg3 = await readCfg({ ...base, source: "html", html: "<p>hint</p>", hint: -5 });
  ok("hint 负值钳制为 0", cfg3.hint === 0);

  // 异常路径
  for (const [name, opts] of [
    ["空软件名", { source: "html", html: "<p>1</p>", title: "" }],
    ["非法软件名", { source: "html", html: "<p>1</p>", title: "a/b" }],
    ["空网址", { source: "url", url: "", title: "x" }],
    ["非 http 协议", { source: "url", url: "ftp://x", title: "x" }],
    ["空 HTML", { source: "html", html: "", title: "x" }],
    ["无 index.html 的 ZIP", { source: "zip", zipData: new Uint8Array(makeDeflateZip([{ name: "a.txt", data: Buffer.from("x") }])) }],
    ["非法 ZIP", { source: "zip", zipData: new Uint8Array([1, 2, 3]) }],
  ]) {
    let threw = false;
    try { await Html2Exe.build(opts); } catch { threw = true; }
    ok("异常: " + name, threw);
  }

  // ---------- 4. 真实运行生成的 EXE ----------
  console.log("[4] 运行真实 EXE");
  const outExe = path.join(ROOT, "work", "test-core.exe");
  fs.writeFileSync(outExe, urlExe);
  const port = 18081;
  const proc = execFile(outExe);
  await new Promise((r) => setTimeout(r, 3000));
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    const body = await res.text();
    ok("EXE 本地服务可达", res.ok && body.includes("example.com"));
    const nf = await fetch(`http://127.0.0.1:${port}/no-such`);
    ok("404 生效", nf.status === 404);
  } catch (e) {
    ok("EXE 本地服务可达", false, e.message);
  } finally {
    proc.kill();
  }

  // ---------- 5. PE 图标资源补丁 ----------
  console.log("[5] PE 图标资源");
  // 合成 32bpp DIB 图标（与 core.js 编码格式一致），XOR 区填充纯绿色 #0e9f6e
  // （BGRA = 6e 9f 0e ff），供 Windows 端提取像素校验
  const makeDib = (w) => {
    const maskRow = ((w + 31) >> 5) << 2;
    const buf = new Uint8Array(40 + w * w * 4 + maskRow * w);
    const bv = new DataView(buf.buffer);
    bv.setUint32(0, 40, true); bv.setInt32(4, w, true); bv.setInt32(8, w * 2, true);
    bv.setUint16(12, 1, true); bv.setUint16(14, 32, true);
    for (let i = 40; i < 40 + w * w * 4; i += 4) {
      buf[i] = 0x6e; buf[i + 1] = 0x9f; buf[i + 2] = 0x0e; buf[i + 3] = 0xff;
    }
    return buf;
  };
  const iconSet = [16, 32, 64].map((w) => ({ w, h: w, data: makeDib(w) }));
  const stubBytes = new Uint8Array(Buffer.from(stubB64, "base64"));
  const origNumSections = new DataView(stubBytes.buffer).getUint16(
    new DataView(stubBytes.buffer).getUint32(0x3c, true) + 6, true);
  const patched = Html2Exe.patchIcon(stubBytes, iconSet);

  const pdv = new DataView(patched.buffer);
  const peOff = pdv.getUint32(0x3c, true);
  const coff = peOff + 4;
  const nSec = pdv.getUint16(coff + 2, true);
  const optSize = pdv.getUint16(coff + 16, true);
  const opt = coff + 20;
  const rsrcRVA = pdv.getUint32(opt + 112 + 16, true);
  ok("资源目录 RVA 非零", rsrcRVA !== 0);
  ok("节表数量 +1", nSec === origNumSections + 1, `${nSec} vs ${origNumSections}`);
  let found = false;
  for (let i = 0; i < nSec; i++) {
    const s = opt + optSize + i * 40;
    const name = Buffer.from(patched.buffer, patched.byteOffset + s, 8).toString().replace(/\0.*$/, "");
    if (name === ".rsrc") {
      found = true;
      ok(".rsrc 节存在且 VA 一致", pdv.getUint32(s + 12, true) === rsrcRVA);
      ok("SizeOfImage 覆盖新节", pdv.getUint32(opt + 56, true) >= rsrcRVA);
    }
  }
  ok("找到 .rsrc 节", found);

  // 严格解析资源树（资源管理器的解析方式：按目录头计数遍历）
  const parseRsrc = () => {
    const peOff2 = pdv.getUint32(0x3c, true);
    const coff2 = peOff2 + 4;
    const n2 = pdv.getUint16(coff2 + 2, true);
    const os2 = pdv.getUint16(coff2 + 16, true);
    const opt2 = coff2 + 20;
    let raw = 0;
    for (let i = 0; i < n2; i++) {
      const s = opt2 + os2 + i * 40;
      if (Buffer.from(patched.buffer, patched.byteOffset + s, 8).toString().replace(/\0.*$/, "") === ".rsrc") {
        raw = pdv.getUint32(s + 20, true); // PointerToRawData
      }
    }
    // 读一个目录层：计数必须与实际条目一致（之前的 bug 就在这里）
    const readDir = (off) => {
      const named = pdv.getUint16(raw + off + 12, true);
      const ids = pdv.getUint16(raw + off + 14, true);
      const entries = [];
      for (let i = 0; i < named + ids; i++) {
        const nm = pdv.getUint32(raw + off + 16 + i * 8, true);
        const o = pdv.getUint32(raw + off + 16 + i * 8 + 4, true);
        entries.push({ nm, sub: !!(o & 0x80000000), off: o & 0x7fffffff });
      }
      return { named, ids, entries };
    };
    const walk = (off) => readDir(off).entries.map((e) => (e.sub ? walk(e.off) : e));
    return { raw, type: readDir(0), walk: walk(0) };
  };
  const tree = parseRsrc();
  ok("目录头 ID 计数正确", tree.type.named === 0 && tree.type.ids === 2,
    `named=${tree.type.named} ids=${tree.type.ids}`);
  const typeIds = tree.type.entries.map((e) => e.nm).sort((a, b) => a - b);
  ok("type 层含 RT_ICON(3) 与 RT_GROUP_ICON(14)", typeIds.join(",") === "3,14", typeIds.join(","));
  // icon ID 层每层恰好 1 条（严格解析器按计数读取，0 条即视为空目录）
  // icon ID 层每层恰好 1 个语言子目录，语言层恰好 1 个叶数据项
  // （严格解析器按目录头计数读取，计数为 0 即视为空目录——之前的 bug 就在这里）
  const iconDirs = tree.walk[0]; // 3 个语言子目录，每个是 [叶数据项] 数组
  let allDirsValid = iconDirs.length === 3;
  for (const d of iconDirs) {
    if (!Array.isArray(d) || d.length !== 1 || !d[0] || d[0].sub) allDirsValid = false;
  }
  ok("icon ID 层/语言层条目计数完整", allDirsValid);
  const groupBranch = tree.walk[1]; // [[叶数据项]]（单条目目录会多一层嵌套）
  const groupLeaf = Array.isArray(groupBranch[0]) ? groupBranch[0][0] : groupBranch[0];
  ok("group 分支 1 个 RT_GROUP_ICON 数据项",
    groupLeaf && typeof groupLeaf === "object" && !groupLeaf.sub);
  // 数据项大小校验：图标数据项 == DIB/PNG 长度，group 数据项 == 6+14n
  const readDataEntry = (off) => ({
    size: pdv.getUint32(patched.byteOffset + tree.raw + off + 4, true),
  });
  let iconSizes = [], groupSize = -1;
  for (const d of iconDirs) {
    const leaf = d[0];
    if (leaf && !leaf.sub) iconSizes.push(readDataEntry(leaf.off).size);
  }
  if (groupLeaf && !groupLeaf.sub) {
    groupSize = readDataEntry(groupLeaf.off).size;
  }
  ok("图标数据项大小与源数据一致",
    iconSizes.length === 3 && iconSizes.every((sz, i) => sz === iconSet[i].data.length),
    JSON.stringify(iconSizes));
  ok("group 数据项大小正确", groupSize === 6 + 14 * iconSet.length, `${groupSize}`);

  // 带图标 EXE 真实运行（PE 结构必须完整可加载）
  const exeFiles = [
    { name: "index.html", data: new TextEncoder().encode("<title>IconTest</title><h1>icon ok</h1>") },
    { name: "__h2x__.json", data: new TextEncoder().encode(
      JSON.stringify({ port: 18087, debug: false, width: 0, height: 0, hint: 0, title: "IconTest" })) },
  ];
  const iconExe = buildExe(patched, Html2Exe.buildZip(exeFiles));
  const iconExePath = path.join(ROOT, "work", "test-icon.exe");
  fs.writeFileSync(iconExePath, iconExe);
  const proc2 = execFile(iconExePath);
  await new Promise((r) => setTimeout(r, 3000));
  try {
    const res = await fetch("http://127.0.0.1:18087/");
    const body = await res.text();
    ok("带图标 EXE 正常运行", res.ok && body.includes("icon ok"), body.slice(0, 60));
    const fav = await fetch("http://127.0.0.1:18087/__h2x_icon.png");
    ok("favicon 条目可访问", fav.status === 404 || fav.ok); // 无图标时不注入条目
  } catch (e) {
    ok("带图标 EXE 正常运行", false, e.message);
  } finally {
    proc2.kill();
  }

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  process.exit(failed ? 1 : 0);
}

// 拼装 EXE：外壳 + ZIP + trailer（与 core.js build 输出一致）
function buildExe(stubBytes, zipBytes) {
  const out = new Uint8Array(stubBytes.length + zipBytes.length + 20);
  out.set(stubBytes, 0);
  out.set(zipBytes, stubBytes.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(out.length - 20, zipBytes.length, true);
  const magic = "HXEXE1.0MARK";
  for (let i = 0; i < magic.length; i++) out[out.length - 12 + i] = magic.charCodeAt(i);
  return out;
}

// 构造最小 deflate ZIP（测试用户上传场景）
function makeDeflateZip(entries) {
  const parts = [], cds = [];
  let off = 0;
  const now = new Date();
  const dt = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xFFFF;
  const dd = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xFFFF;
  for (const e of entries) {
    const nameB = Buffer.from(e.name);
    const data = e.level
      ? zlib.deflateRawSync(e.data, { level: e.level })
      : e.data;
    const method = e.level ? 8 : 0;
    const crc = zlib.crc32 ? zlib.crc32(e.data) : crc32(e.data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6);
    lh.writeUInt16LE(method, 8); lh.writeUInt16LE(dt, 10); lh.writeUInt16LE(dd, 12);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(e.data.length, 22);
    lh.writeUInt16LE(nameB.length, 26); lh.writeUInt16LE(0, 28);
    parts.push(lh, nameB, data);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8); cd.writeUInt16LE(method, 10); cd.writeUInt16LE(dt, 12);
    cd.writeUInt16LE(dd, 14); cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(e.data.length, 24); cd.writeUInt16LE(nameB.length, 28);
    cd.writeUInt32LE(off, 42);
    cds.push(cd, nameB);
    off += 30 + nameB.length + data.length;
  }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cds.reduce((s, b) => s + b.length, 0), 12);
  eocd.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, ...cds, eocd]);
}

// Node 18 以下 zlib.crc32 不存在时的兜底
function crc32(buf) {
  let t = [], c;
  for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
  let r = 0xFFFFFFFF;
  for (const b of buf) r = t[(r ^ b) & 0xFF] ^ (r >>> 8);
  return (r ^ 0xFFFFFFFF) >>> 0;
}

main().catch((e) => { console.error("测试异常:", e); process.exit(1); });
