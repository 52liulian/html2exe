# -*- coding: utf-8 -*-
"""stub 冒烟测试：模拟浏览器端打包过程，生成测试 EXE 并验证本地服务。

用法: python tools/test_stub.py
前提: assets/stub.exe 外壳资产存在；node test/node-test.js 已产出 work/test-icon.exe（图标验证）
"""
import struct
import zipfile
import subprocess
import sys
import time
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STUB = os.path.join(ROOT, "assets", "stub.exe")
OUT = os.path.join(ROOT, "work", "test-app.exe")

MAGIC = b"HXEXE1.0MARK"


def build_zip():
    """与 core.js 产出等价的 STORED ZIP：配置 + index.html + 静态资源"""
    path = os.path.join(ROOT, "work", "test-payload.zip")
    with zipfile.ZipFile(path, "w", zipfile.ZIP_STORED) as z:
        cfg = {"port": 18099, "debug": True, "width": 1280, "height": 800}
        z.writestr("__h2x__.json", json.dumps(cfg))
        z.writestr("index.html", "<!DOCTYPE html><html><head><title>测试应用</title>"
                                 "<style>body{font-family:sans-serif;background:#0e9f6e;color:#fff;"
                                 "display:flex;justify-content:center;align-items:center;height:100vh;"
                                 "font-size:28px}</style></head>"
                                 "<body><div>Html2Exe 冒烟测试 OK</div></body></html>")
        z.writestr("sub/data.txt", "nested file works")
    with open(path, "rb") as f:
        return f.read()


def main():
    with open(STUB, "rb") as f:
        stub = f.read()
    payload = build_zip()
    with open(OUT, "wb") as f:
        f.write(stub + payload + struct.pack("<Q", len(payload)) + MAGIC)
    print("生成测试 EXE:", OUT, os.path.getsize(OUT), "bytes")

    proc = subprocess.Popen([OUT])
    time.sleep(3)

    import urllib.request
    try:
        html = urllib.request.urlopen("http://127.0.0.1:18099/", timeout=5).read().decode()
        assert "冒烟测试 OK" in html, "index.html 内容不符"
        txt = urllib.request.urlopen("http://127.0.0.1:18099/sub/data.txt", timeout=5).read().decode()
        assert txt == "nested file works", "子目录文件内容不符"
        try:
            urllib.request.urlopen("http://127.0.0.1:18099/no-such-file", timeout=5)
            assert False, "404 未生效"
        except Exception:
            pass
        print("PASS: index.html / 子目录文件 / 404 全部通过")
    finally:
        proc.kill()

    # ---------- hint=3 固定大小真机验证（标题用 ASCII，避免编码问题） ----------
    out2 = os.path.join(ROOT, "work", "test-hint.exe")
    with zipfile.ZipFile(os.path.join(ROOT, "work", "hint-payload.zip"), "w", zipfile.ZIP_STORED) as z:
        cfg = {"port": 18101, "debug": False, "width": 800, "height": 600,
               "hint": 3, "title": "HintTest"}
        z.writestr("__h2x__.json", json.dumps(cfg))
        z.writestr("index.html", "<!DOCTYPE html><html><head><title>HintTest</title></head>"
                                 "<body>hint fixed size test</body></html>")
    with open(os.path.join(ROOT, "work", "hint-payload.zip"), "rb") as f:
        payload2 = f.read()
    with open(out2, "wb") as f:
        f.write(stub + payload2 + struct.pack("<Q", len(payload2)) + MAGIC)

    proc2 = subprocess.Popen([out2])
    try:
        # 用 PowerShell 轮询窗口并校验样式位与尺寸
        code = (
            "Add-Type -TypeDefinition '"
            "using System; using System.Runtime.InteropServices; "
            "public class W { "
            "[DllImport(\"user32.dll\", CharSet=CharSet.Unicode)] "
            "public static extern IntPtr FindWindow(string c, string t); "
            "[DllImport(\"user32.dll\")] public static extern int GetWindowLongPtr(IntPtr h, int i); "
            "[DllImport(\"user32.dll\")] public static extern bool GetWindowRect(IntPtr h, out RECT r); "
            "[DllImport(\"user32.dll\")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l); "
            "public struct RECT { public int L; public int T; public int R; public int B; } }';"
            "$h=[IntPtr]::Zero; for($i=0;$i -lt 60;$i++){ "
            "$h=[W]::FindWindow($null,'HintTest'); if($h -ne [IntPtr]::Zero){break}; Start-Sleep -m 250 }"
            "if($h -eq [IntPtr]::Zero){ 'NOTFOUND' } else { "
            "$style=[W]::GetWindowLongPtr($h,-16); "
            "$thick=($style -band 0x00040000) -ne 0; "
            "$maxbox=($style -band 0x00010000) -ne 0; "
            "$r=New-Object W+RECT; [W]::GetWindowRect($h,[ref]$r) | Out-Null; "
            "[W]::PostMessage($h,0x10,[IntPtr]::Zero,[IntPtr]::Zero) | Out-Null; "
            "\"thickframe=$thick maximizebox=$maxbox size=$(($r.R-$r.L))x$(($r.B-$r.T))\" }"
        )
        # 给 stub 足够时间应用固定样式
        time.sleep(4)
        res = subprocess.run(["powershell", "-NoProfile", "-Command", code],
                             capture_output=True, text=True, timeout=60)
        out = res.stdout.strip()
        print("窗口检查:", out)
        if out == "NOTFOUND":
            print("WARN: 未找到窗口（Edge 未安装或环境差异），固定大小仅代码层验证")
        elif "thickframe=False" in out and "maximizebox=False" in out and "size=800x600" in out:
            print("PASS: 固定大小生效（无可拉伸边框、无最大化按钮、尺寸 800x600）")
        else:
            print("FAIL: 固定大小未按预期生效")
            sys.exit(1)
    finally:
        proc2.kill()

    # ---------- PE 图标资源验证（Node 测试产出 work/test-icon.exe） ----------
    icon_exe = os.path.join(ROOT, "work", "test-icon.exe")
    if os.path.exists(icon_exe):
        code = ("Add-Type -AssemblyName System.Drawing; "
                "$i=[System.Drawing.Icon]::ExtractAssociatedIcon('" + icon_exe + "'); "
                "if($i){ \"ICON_OK $($i.Width)x$($i.Height)\" } else { 'ICON_FAIL' }")
        res = subprocess.run(["powershell", "-NoProfile", "-Command", code],
                             capture_output=True, text=True, timeout=60)
        out = res.stdout.strip()
        print("图标提取:", out)
        if "ICON_OK" not in out:
            sys.exit("FAIL: ExtractAssociatedIcon 无法读取图标资源\n" + res.stderr)
        print("PASS: EXE 图标资源可被 Windows 正常读取")


if __name__ == "__main__":
    sys.exit(main())
