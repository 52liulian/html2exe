# -*- coding: utf-8 -*-
"""Html2Exe 单文件构建脚本：把引擎与外壳 stub 注入 UI 模板，产出 dist/html2exe.html。

用法:
    python tools/build.py

说明:
    assets/stub.exe 是预编译的外壳二进制资产（与 html2apk 内嵌 template.apk 同理），
    运行时被 base64 内嵌进成品，全程纯前端完成打包，无需任何编译工具链。
"""
import base64
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UI = os.path.join(ROOT, "src", "ui.html")
CORE = os.path.join(ROOT, "src", "core.js")
STUB = os.path.join(ROOT, "assets", "stub.exe")
OUT = os.path.join(ROOT, "dist", "html2exe.html")


def main():
    for p, desc in [(UI, "界面模板"), (CORE, "核心引擎"), (STUB, "外壳 stub 资产 assets/stub.exe")]:
        if not os.path.exists(p):
            sys.exit(f"缺少{desc}: {p}")

    with open(UI, "r", encoding="utf-8") as f:
        ui = f.read()
    with open(CORE, "r", encoding="utf-8") as f:
        core = f.read()
    with open(STUB, "rb") as f:
        stub_b64 = base64.b64encode(f.read()).decode()

    # 注入外壳 stub base64（core.js 中的占位符）
    if '"/*__STUB_B64__*/"' not in core:
        sys.exit("core.js 中未找到 stub 占位符 \"/*__STUB_B64__*/\"")
    core = core.replace('"/*__STUB_B64__*/"', f'"{stub_b64}"')

    # 注入核心引擎（ui.html 中的占位符）
    if "/*__CORE__*/" not in ui:
        sys.exit("ui.html 中未找到引擎占位符 /*__CORE__*/")
    ui = ui.replace("/*__CORE__*/", core)

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        f.write(ui)

    # 校验：不允许残留任何占位符
    for token in ("__STUB_B64__", "__CORE__"):
        if token in ui:
            sys.exit(f"构建异常：仍残留占位符 {token}")

    size = os.path.getsize(OUT)
    print(f"构建完成: {OUT}")
    print(f"文件大小: {size / 1024 / 1024:.2f} MB（stub {len(stub_b64) * 3 // 4 / 1024 / 1024:.2f} MB）")


if __name__ == "__main__":
    main()
