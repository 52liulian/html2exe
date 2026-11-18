// Html2Exe 核心引擎（浏览器 / Node 通用，无第三方依赖）
//
// 职责：
//  1. 把内容（网址重定向页 / HTML 源码 / ZIP 解包后的文件）构建为 STORED ZIP
//    （全部不压缩，外壳 stub 无需解压算法即可直接服务文件）
//  2. 拼接 外壳 stub（base64 内嵌）+ ZIP + 尾部 trailer，产出可直接运行的 EXE
//
// trailer 与 assets/stub.exe 外壳的约定一致：8 字节 ZIP 长度（小端）+ 12 字节魔数
const H2X_MAGIC = "HXEXE1.0MARK";
const H2X_CONFIG = "__h2x__.json";

// 外壳 stub 的 base64（由 tools/build.py 在构建时注入）
const H2X_STUB_B64 = "/*__STUB_B64__*/";

// ---------------------------------------------------------------- CRC32

const H2X_CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function h2xCrc32(u8) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < u8.length; i++) c = H2X_CRC_TABLE[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// ---------------------------------------------------------------- ZIP 构建（仅 STORED）

function h2xDosTime(d) {
  return ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() / 2) & 31);
}
function h2xDosDate(d) {
  return (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31);
}

// files: [{ name: string, data: Uint8Array }]
// 返回标准 ZIP 字节流（UTF-8 文件名，STORED 不压缩）
function h2xBuildZip(files) {
  const now = new Date();
  const dTime = h2xDosTime(now), dDate = h2xDosDate(now);
  const enc = new TextEncoder();

  // 预计算：文件名字节、CRC、每个条目的本地区偏移
  const items = [];
  let localSize = 0;
  for (const f of files) {
    const nameBytes = enc.encode(f.name);
    const crc = h2xCrc32(f.data);
    const lhSize = 30 + nameBytes.length + f.data.length;
    items.push({ nameBytes, crc, offset: localSize });
    localSize += lhSize;
  }

  // 本地区（本地头 + 数据）
  const local = new Uint8Array(localSize);
  let p = 0;
  for (let i = 0; i < files.length; i++) {
    const { nameBytes, crc } = items[i];
    const data = files[i].data;
    const lh = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true);       // 签名
    lv.setUint16(4, 20, true);               // 版本
    lv.setUint16(6, 0x0800, true);           // UTF-8 文件名
    lv.setUint16(8, 0, true);                // STORED
    lv.setUint16(10, dTime, true);
    lv.setUint16(12, dDate, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);     // 压缩后大小
    lv.setUint32(22, data.length, true);     // 原始大小
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    lh.set(nameBytes, 30);
    local.set(lh, p); p += lh.length;
    local.set(data, p); p += data.length;
  }

  // 中央目录
  const cdChunks = [];
  let cdSize = 0;
  for (let i = 0; i < files.length; i++) {
    const { nameBytes, crc, offset } = items[i];
    const cd = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, dTime, true);
    cv.setUint16(14, dDate, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, files[i].data.length, true);
    cv.setUint32(24, files[i].data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    cd.set(nameBytes, 46);
    cdChunks.push(cd);
    cdSize += cd.length;
  }

  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, localSize, true);

  const out = new Uint8Array(localSize + cdSize + 22);
  out.set(local, 0);
  p = localSize;
  for (const cd of cdChunks) { out.set(cd, p); p += cd.length; }
  out.set(eocd, p);
  return out;
}

// ---------------------------------------------------------------- ZIP 解析（来源为 ZIP 压缩包时）

// 解析 ZIP 并解出全部条目（STORED 直接切片，DEFLATE 用 DecompressionStream 解压）
async function h2xUnzip(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  // 从尾部向前找 EOCD 签名（注释最长 65535）
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 22 - 65535); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("无效的 ZIP 文件（未找到 EOCD）");
  const count = dv.getUint16(eocd + 10, true);
  let cdOffset = dv.getUint32(eocd + 16, true);
  if (cdOffset === 0xFFFFFFFF) throw new Error("暂不支持 ZIP64 格式，请重新打包 ZIP");
  if (cdOffset + 4 > u8.length) {
    // 部分工具会写错 cdOffset（前导数据导致），尝试扫描中央目录签名
    for (let i = 0; i < u8.length - 4; i++) {
      if (dv.getUint32(i, true) === 0x02014b50) { cdOffset = i; break; }
    }
  }
  const dec = new TextDecoder();
  const out = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const cSize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const lho = dv.getUint32(p + 42, true);
    const name = dec.decode(u8.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith("/")) continue; // 目录条目跳过
    // 定位本地头中的数据区
    const lNameLen = dv.getUint16(lho + 26, true);
    const lExtraLen = dv.getUint16(lho + 28, true);
    const dataStart = lho + 30 + lNameLen + lExtraLen;
    const raw = u8.subarray(dataStart, dataStart + cSize);
    let data;
    if (method === 0) {
      data = raw.slice();
    } else if (method === 8) {
      data = new Uint8Array(await new Response(
        new Blob([raw]).stream().pipeThrough(new DecompressionStream("deflate-raw"))
      ).arrayBuffer());
    } else {
      throw new Error("不支持的压缩方式（条目 " + name + "），请使用 STORED 或 DEFLATE 打包 ZIP");
    }
    if (lho >= u8.length || dv.getUint32(lho, true) !== 0x04034b50) continue;
    out.push({ name, data });
  }
  return out;
}

// ---------------------------------------------------------------- 内容来源处理

// 网址模式：生成重定向页（保持 <title> 为软件名称，Edge App 窗口标题栏显示它）
function h2xRedirectPage(url, title, favicon) {
  const safeTitle = title.replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${safeTitle}</title>
${favicon || ""}
<meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body style="margin:0;display:flex;justify-content:center;align-items:center;height:100vh;
font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;background:#0e9f6e;color:#fff;font-size:18px">
<div>正在打开 ${safeTitle} …</div>
<script>location.replace(${JSON.stringify(url)});<\/script>
</body>
</html>`;
}

// HTML 模式：若源码没有 <title>，注入软件名称（保证窗口标题正确显示）
function h2xEnsureTitle(html, title) {
  if (/<title[\s>]/i.test(html)) return html;
  const tag = `<title>${title.replace(/</g, "&lt;")}</title>`;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => m + tag);
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (m) => m + tag);
  return tag + html;
}

function h2xStrToU8(s) {
  return new TextEncoder().encode(s);
}

function h2xSafeName(title) {
  const n = title.replace(/[\\/:*?"<>|]/g, "").trim();
  return (n || "app") + ".exe";
}

// ---------------------------------------------------------------- 应用图标

// RT_ICON 使用的尺寸列表（16~128 编码为 DIB，256 编码为 PNG）
const H2X_ICON_SIZES = [16, 32, 48, 64, 128, 256];

// 页面 favicon 的条目名（Edge App 窗口左上角图标来自它）
const H2X_ICON_ENTRY = "__h2x_icon.png";

// RGBA 像素 → 32 位 DIB（BITMAPINFOHEADER + 自下而上 XOR + AND 掩码），RT_ICON 小尺寸用
function h2xEncodeDib(w, h, rgba) {
  const maskRowBytes = ((w + 31) >> 5) << 2;
  const xorSize = w * h * 4;
  const andSize = maskRowBytes * h;
  const out = new Uint8Array(40 + xorSize + andSize);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 40, true);                  // biSize
  dv.setInt32(4, w, true);                    // biWidth
  dv.setInt32(8, h * 2, true);                // biHeight = XOR + AND
  dv.setUint16(12, 1, true);                  // biPlanes
  dv.setUint16(14, 32, true);                 // biBitCount
  dv.setUint32(20, xorSize + andSize, true);  // biSizeImage
  // XOR 区：BGRA 像素，自下而上
  let p = 40;
  for (let y = h - 1; y >= 0; y--) {
    let s = y * w * 4;
    for (let x = 0; x < w; x++) {
      out[p++] = rgba[s + 2]; // B
      out[p++] = rgba[s + 1]; // G
      out[p++] = rgba[s];     // R
      out[p++] = rgba[s + 3]; // A
      s += 4;
    }
  }
  // AND 掩码保持全 0（不透明），透明度由 Alpha 通道表达
  return out;
}

// 源 PNG → 全套尺寸图标（浏览器端；Node 无 canvas，测试用合成 DIB 代替）
async function h2xPrepareIcons(pngU8) {
  const img = await createImageBitmap(new Blob([pngU8], { type: "image/png" }));
  const out = [];
  for (const s of H2X_ICON_SIZES) {
    const canvas = new OffscreenCanvas(s, s);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0, s, s);
    let data;
    if (s >= 256) {
      const b = await canvas.convertToBlob({ type: "image/png" });
      data = new Uint8Array(await b.arrayBuffer());
    } else {
      data = h2xEncodeDib(s, s, ctx.getImageData(0, 0, s, s).data);
    }
    out.push({ w: s, h: s, data });
  }
  img.close();
  return out;
}

// 默认图标：绿色圆角方块 + 白色 </> 符号，与工具主题一致
async function h2xDefaultIconPng() {
  const canvas = new OffscreenCanvas(256, 256);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#0e9f6e";
  ctx.beginPath();
  ctx.roundRect(16, 16, 224, 224, 48);
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 112px Consolas, Menlo, monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("</>", 128, 136);
  const b = await canvas.convertToBlob({ type: "image/png" });
  return new Uint8Array(await b.arrayBuffer());
}

// 给外壳 EXE 追加 .rsrc 资源节，写入图标（RT_ICON + RT_GROUP_ICON）
// icons: [{ w, h, data: Uint8Array }]（data 为 DIB 或 PNG 字节）
function h2xPatchExeIcon(exe, icons) {
  const h2xAlign = (v, a) => Math.ceil(v / a) * a;
  const dv = new DataView(exe.buffer, exe.byteOffset, exe.byteLength);

  // 解析 PE 头
  const peOff = dv.getUint32(0x3c, true);
  if (dv.getUint32(peOff, true) !== 0x00004550) throw new Error("无效的 PE 文件");
  const coff = peOff + 4;
  const numSections = dv.getUint16(coff + 2, true);
  const optSize = dv.getUint16(coff + 16, true);
  const opt = coff + 20;
  const pe32plus = dv.getUint16(opt, true) === 0x20b;
  const sectionAlign = dv.getUint32(opt + 32, true);
  const fileAlign = dv.getUint32(opt + 36, true);
  const sizeOfHeaders = dv.getUint32(opt + 60, true);
  const ddOff = opt + (pe32plus ? 112 : 96);
  const secTable = opt + optSize;

  // 新节表项必须放进现有头部空间内（头部页对齐后通常有富余）
  if (secTable + numSections * 40 + 40 > sizeOfHeaders) {
    throw new Error("PE 头部空间不足，无法追加资源节");
  }

  // 计算新节位置（排在所有现有节之后）
  let maxVA = 0, maxFileEnd = 0;
  for (let i = 0; i < numSections; i++) {
    const s = secTable + i * 40;
    maxVA = Math.max(maxVA, dv.getUint32(s + 12, true) + dv.getUint32(s + 8, true));
    maxFileEnd = Math.max(maxFileEnd, dv.getUint32(s + 20, true) + dv.getUint32(s + 16, true));
  }
  const newRVA = h2xAlign(maxVA, sectionAlign);
  const newRawPtr = h2xAlign(maxFileEnd, fileAlign);

  // ---- 构建资源节内容 ----
  // 目录布局：type 层(icon+group) → ID 层 → 语言层(叶) → 数据项 → 数据块
  const n = icons.length;
  const offIconDir = 32;                          // type 层 16+2*8
  const offGroupDir = offIconDir + 16 + 8 * n;    // ID 层 16+n*8
  const offIconLeaves = offGroupDir + 24;         // group ID 层 16+8
  const offGroupLeaf = offIconLeaves + 24 * n;    // 每个语言层 16+8
  const dataEntryStart = offGroupLeaf + 24;       // (n+1) 个数据项，每个 16 字节
  const blobStart = dataEntryStart + 16 * (n + 1);

  // 数据块偏移（图标依次排列，最后是 group 头）
  const blobOffsets = [];
  let cur = blobStart;
  for (const ic of icons) { blobOffsets.push(cur); cur += ic.data.length; }
  const groupOffset = cur;
  cur += 6 + 14 * n;

  const section = new Uint8Array(cur);
  const sv = new DataView(section.buffer);
  const writeDir = (base, numId, entries) => {
    sv.setUint16(base + 12, numId, true);
    entries.forEach(([id, offset], i) => {
      sv.setUint32(base + 16 + i * 8, id, true);
      sv.setUint32(base + 16 + i * 8 + 4, offset, true);
    });
  };
  // type 层：RT_ICON(3) 与 RT_GROUP_ICON(14)
  writeDir(0, 0, [[3, 0x80000000 | offIconDir], [14, 0x80000000 | offGroupDir]]);
  // icon ID 层：ID 1..n → 语言层
  for (let i = 0; i < n; i++) {
    writeDir(offIconDir, 0, [[i + 1, 0x80000000 | (offIconLeaves + 24 * i)]]);
  }
  // group ID 层：ID 1 → 语言层
  writeDir(offGroupDir, 0, [[1, 0x80000000 | offGroupLeaf]]);
  // 语言层（数据项入口统一用 0x409 en-US）
  for (let i = 0; i < n; i++) {
    writeDir(offIconLeaves + 24 * i, 0, [[0x409, dataEntryStart + i * 16]]);
  }
  writeDir(offGroupLeaf, 0, [[0x409, dataEntryStart + n * 16]]);
  // 数据项
  for (let i = 0; i < n; i++) {
    const e = dataEntryStart + i * 16;
    sv.setUint32(e, blobOffsets[i], true);      // OffsetToData（相对节起始）
    sv.setUint32(e + 4, icons[i].data.length, true);
  }
  sv.setUint32(dataEntryStart + n * 16, groupOffset, true);
  sv.setUint32(dataEntryStart + n * 16 + 4, 6 + 14 * n, true);
  // 数据块
  for (let i = 0; i < n; i++) section.set(icons[i].data, blobOffsets[i]);
  // RT_GROUP_ICON 头
  sv.setUint16(groupOffset + 2, 1, true);       // type = icon
  sv.setUint16(groupOffset + 4, n, true);       // count
  for (let i = 0; i < n; i++) {
    const b = groupOffset + 6 + i * 14;
    section[b] = icons[i].w === 256 ? 0 : icons[i].w;      // 宽（256 记 0）
    section[b + 1] = icons[i].h === 256 ? 0 : icons[i].h;  // 高
    section[b + 2] = 0;                                    // colorCount
    section[b + 3] = 0;
    sv.setUint16(b + 4, 1, true);           // planes
    sv.setUint16(b + 6, 32, true);          // bitCount
    sv.setUint32(b + 8, icons[i].data.length, true);
    sv.setUint16(b + 12, i + 1, true);      // 对应 RT_ICON 资源 ID
  }

  // ---- 拼装新 EXE：原文件 + 新节表项 + 节数据 ----
  const virtualSize = section.length;
  const rawSize = h2xAlign(virtualSize, fileAlign);
  const out = new Uint8Array(newRawPtr + rawSize);
  out.set(exe, 0);
  const ov = new DataView(out.buffer, out.byteOffset, out.byteLength);
  ov.setUint16(coff + 2, numSections + 1, true);                          // 节数量 +1
  ov.setUint32(opt + 56, h2xAlign(newRVA + virtualSize, sectionAlign), true); // SizeOfImage
  ov.setUint32(opt + 64, 0, true);                                        // CheckSum 清零
  ov.setUint32(ddOff + 16, newRVA, true);                                 // DataDirectory[2].VA
  ov.setUint32(ddOff + 20, virtualSize, true);                            // DataDirectory[2].Size
  const s = secTable + numSections * 40;
  out.set(new TextEncoder().encode(".rsrc"), s);
  ov.setUint32(s + 8, virtualSize, true);      // VirtualSize
  ov.setUint32(s + 12, newRVA, true);          // VirtualAddress
  ov.setUint32(s + 16, rawSize, true);         // SizeOfRawData
  ov.setUint32(s + 20, newRawPtr, true);       // PointerToRawData
  ov.setUint32(s + 36, 0x40000040, true);      // 初始化数据 + 可读
  out.set(section, newRawPtr);
  return out;
}

// 页面 favicon 注入：已有图标声明的页面不动，其余插入 <link rel="icon">
function h2xInjectFavicon(html) {
  if (/rel\s*=\s*["']?(shortcut )?icon/i.test(html)) return html;
  const tag = `<link rel="icon" type="image/png" href="/${H2X_ICON_ENTRY}">`;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => m + tag);
  return tag + html;
}

// ---------------------------------------------------------------- 对外接口

// build(opts) -> Promise<{ blob: Blob, name: string, size: number }>
// opts: { source: 'url'|'html'|'zip', url, html, zipData: Uint8Array,
//         title, port, debug, width, height }
async function h2xBuild(opts) {
  const title = (opts.title || "").trim();
  if (!title) throw new Error("请填写软件名称");
  if (!/^[^\\/:*?"<>|]{1,60}$/.test(title)) throw new Error("软件名称包含非法字符（不能含 \\ / : * ? \" < > |）");

  // 图标处理：用户上传的 PNG（或默认图标）→ 全套尺寸；Node 测试环境无 canvas 时跳过
  let icons = null, iconPng = null;
  try {
    const src = (opts.icon && opts.icon.length) ? opts.icon
      : (typeof OffscreenCanvas !== "undefined" ? await h2xDefaultIconPng() : null);
    if (src && src.length) {
      icons = await h2xPrepareIcons(src);
      iconPng = icons[icons.length - 1].data; // 256 PNG 兼作页面 favicon
    }
  } catch (e) { /* 图标处理失败不阻塞打包 */ }
  const faviconTag = iconPng ? `<link rel="icon" type="image/png" href="/${H2X_ICON_ENTRY}">` : "";

  const files = [];

  // 内容来源
  if (opts.source === "url") {
    let url = (opts.url || "").trim();
    if (!url) throw new Error("请填写网址");
    if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = "https://" + url;
    if (!/^https?:\/\//i.test(url)) throw new Error("网址格式不正确（仅支持 http/https）");
    files.push({ name: "index.html", data: h2xStrToU8(h2xRedirectPage(url, title, faviconTag)) });
  } else if (opts.source === "html") {
    const html = (opts.html || "").trim();
    if (!html) throw new Error("请粘贴 HTML 源码");
    let out = h2xEnsureTitle(html, title);
    if (iconPng) out = h2xInjectFavicon(out);
    files.push({ name: "index.html", data: h2xStrToU8(out) });
  } else if (opts.source === "zip") {
    if (!opts.zipData || !opts.zipData.length) throw new Error("请选择 ZIP 压缩包");
    const entries = await h2xUnzip(opts.zipData);
    if (!entries.length) throw new Error("ZIP 压缩包为空");
    if (!entries.some((e) => e.name === "index.html" || e.name === "index.htm")) {
      throw new Error("ZIP 根目录需包含 index.html");
    }
    for (const e of entries) {
      let data = e.data;
      // index 是 UTF-8 且缺少图标声明时注入 favicon（GBK 等非 UTF-8 文件跳过，避免乱码）
      if (iconPng && (e.name === "index.html" || e.name === "index.htm")) {
        try {
          const txt = new TextDecoder("utf-8", { fatal: true }).decode(data);
          data = h2xStrToU8(h2xInjectFavicon(txt));
        } catch (err) { /* 非 UTF-8，跳过注入 */ }
      }
      files.push({ name: e.name, data });
    }
  } else {
    throw new Error("未知的内容来源");
  }

  // 配置文件（stub 启动时读取）
  // hint 窗口提示：0 无 1 最小化 2 最大化 3 固定大小
  const cfg = {
    port: Math.max(0, Math.min(65535, opts.port | 0)),
    debug: !!opts.debug,
    width: Math.max(0, Math.min(8192, opts.width | 0)),
    height: Math.max(0, Math.min(8192, opts.height | 0)),
    hint: Math.max(0, Math.min(3, opts.hint | 0)),
    title,
  };
  files.push({ name: H2X_CONFIG, data: h2xStrToU8(JSON.stringify(cfg)) });

  // 图标文件（favicon 引用它）
  if (iconPng) files.push({ name: H2X_ICON_ENTRY, data: iconPng });

  // 拼装：外壳（打图标资源补丁）+ ZIP + trailer
  let stub = Uint8Array.from(atob(H2X_STUB_B64), (c) => c.charCodeAt(0));
  if (icons) stub = h2xPatchExeIcon(stub, icons);
  const zip = h2xBuildZip(files);
  const out = new Uint8Array(stub.length + zip.length + 20);
  out.set(stub, 0);
  out.set(zip, stub.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(out.length - 20, zip.length, true); // 8 字节长度（高 4 字节为 0，ZIP < 4GB 足够）
  for (let i = 0; i < H2X_MAGIC.length; i++) {
    out[out.length - 12 + i] = H2X_MAGIC.charCodeAt(i);
  }

  const name = h2xSafeName(title);
  return { blob: new Blob([out], { type: "application/x-msdownload" }), name, size: out.length };
}

// 挂载到全局（浏览器 window / Node globalThis）
if (typeof globalThis !== "undefined") {
  globalThis.Html2Exe = {
    build: h2xBuild,
    buildZip: h2xBuildZip,
    unzip: h2xUnzip,
    patchIcon: h2xPatchExeIcon,
    prepareIcons: h2xPrepareIcons,
    defaultIconPng: h2xDefaultIconPng,
  };
}
