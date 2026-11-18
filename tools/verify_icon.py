# -*- coding: utf-8 -*-
"""图标提取权威验证：用资源管理器同款 API SHDefExtractIcon 提取图标并校验像素颜色。

用法: python tools/verify_icon.py <exe路径>
通过: 提取出的 32px 图标采样像素 == #0e9f6e（node-test.js 合成的纯绿图标）
"""
import ctypes
import ctypes.wintypes as wt
import sys

u32 = ctypes.windll.user32
g32 = ctypes.windll.gdi32
sh32 = ctypes.windll.shell32


class ICONINFO(ctypes.Structure):
    _fields_ = [("fIcon", wt.BOOL), ("xHotspot", wt.DWORD), ("yHotspot", wt.DWORD),
                ("hbmMask", wt.HBITMAP), ("hbmColor", wt.HBITMAP)]


class BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [("biSize", wt.DWORD), ("biWidth", wt.LONG), ("biHeight", wt.LONG),
                ("biPlanes", wt.WORD), ("biBitCount", wt.WORD), ("biCompression", wt.DWORD),
                ("biSizeImage", wt.DWORD), ("biXPelsPerMeter", wt.LONG),
                ("biYPelsPerMeter", wt.LONG), ("biClrUsed", wt.DWORD), ("biClrImportant", wt.DWORD)]


class BITMAP(ctypes.Structure):
    _fields_ = [("bmType", wt.LONG), ("bmWidth", wt.LONG), ("bmHeight", wt.LONG),
                ("bmWidthBytes", wt.LONG), ("bmPlanes", wt.WORD), ("bmBitsPixel", wt.WORD),
                ("bmBits", ctypes.c_void_p)]


# 64 位下句柄是 64 位值，显式声明参数类型避免 c_int 溢出
u32.GetIconInfo.argtypes = [wt.HICON, ctypes.POINTER(ICONINFO)]
u32.DestroyIcon.argtypes = [wt.HICON]
g32.GetObjectW.argtypes = [wt.HBITMAP, ctypes.c_int, ctypes.c_void_p]
g32.GetDIBits.argtypes = [wt.HDC, wt.HBITMAP, wt.UINT, wt.UINT, ctypes.c_void_p, ctypes.c_void_p, wt.UINT]
g32.CreateCompatibleDC.argtypes = [wt.HDC]
g32.DeleteDC.argtypes = [wt.HDC]
g32.DeleteObject.argtypes = [wt.HBITMAP]


def icon_pixels(hicon):
    """HICON → (宽, 高, [[(r,g,b,a), ...], ...])，自上而下"""
    ii = ICONINFO()
    if not u32.GetIconInfo(hicon, ctypes.byref(ii)):
        return None
    bmi = BITMAPINFOHEADER()
    bmi.biSize = ctypes.sizeof(BITMAPINFOHEADER)
    bmp = BITMAP()
    if not g32.GetObjectW(ii.hbmColor, ctypes.sizeof(BITMAP), ctypes.byref(bmp)):
        return None
    w, h = bmp.bmWidth, bmp.bmHeight
    bmi.biWidth = w
    bmi.biHeight = -h  # 负高 = 自上而下
    bmi.biPlanes = 1
    bmi.biBitCount = 32
    bmi.biCompression = 0  # BI_RGB
    bmi.biSizeImage = w * h * 4
    buf = ctypes.create_string_buffer(w * h * 4)
    dc = g32.CreateCompatibleDC(None)
    lines = g32.GetDIBits(dc, ii.hbmColor, 0, h, buf, ctypes.byref(bmi), 0)  # DIB_RGB_COLORS
    g32.DeleteDC(dc)
    if lines != h:
        print("GetDIBits FAIL ret=%d" % lines)
        return None
    rows = []
    for y in range(h):
        row = []
        for x in range(w):
            b, g_, r_, a = buf[(y * w + x) * 4:(y * w + x) * 4 + 4]
            row.append((r_, g_, b, a))
        rows.append(row)
    u32.DestroyIcon(hicon)
    g32.DeleteObject(ii.hbmColor)
    g32.DeleteObject(ii.hbmMask)
    return w, h, rows


def main():
    exe = sys.argv[1]
    hicon = wt.HICON()
    hr = sh32.SHDefExtractIconW(exe, 0, 0, ctypes.byref(hicon), None, 32)
    if hr != 0 or not hicon:
        print("SHDefExtractIcon FAIL hr=0x%08x" % (hr & 0xFFFFFFFF))
        return 1
    got = icon_pixels(hicon)
    if not got:
        print("GetIconInfo/GetDIBits FAIL")
        return 1
    w, h, rows = got
    cx, cy = w // 2, h // 2
    samples = [rows[4][4], rows[cy][cx], rows[h - 5][w - 5]]
    print("提取图标 %dx%d，采样像素: %s" % (w, h, samples))
    expect = (14, 159, 110)  # #0e9f6e
    ok = all((abs(p[0] - expect[0]) <= 2 and abs(p[1] - expect[1]) <= 2
              and abs(p[2] - expect[2]) <= 2 and p[3] >= 200) for p in samples)
    print("PASS: 图标即我们写入的绿色图标" if ok else
          "FAIL: 提取到的是通用默认图标，资源仍无效")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
