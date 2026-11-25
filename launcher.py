#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
launcher.py —— 键盘网页驱动（via-driver）的本地启动器

职责只有三件：
  1. 找一个空闲端口（不写死端口号，撞了自动换下一个）
  2. 在本机 127.0.0.1 上，把 `dist/`（npm run build 的产物）当静态站点服务出来
  3. 用 Chrome / Edge 打开页面

============================================================================
为什么必须有这个本地服务（不能直接双击 dist/index.html）
============================================================================
WebHID（改键）和 Web Serial（传图）只在 **secure context** 下暴露。
用 file:// 打开时 navigator.hid / navigator.serial 都是 undefined，页面等于废的。
http://127.0.0.1 属于 loopback，浏览器视同 secure context，所以必须有个
本地 HTTP 服务来"递"这个页面。

（这条结论来自 pic-uploader 的 launcher.py，2026-10-20 实测确认。）

============================================================================
和 pic-uploader 那份启动器的关系
============================================================================
结构照抄、逻辑不改，只动了四处：
  · 服务目录      pic-uploader/  ->  via-driver/dist/
  · 锁端口/起始端口 18764/18765  ->  18754/18755（**必须错开**，
                    否则传图工具和驱动不能同时开着，会互相踢）
  · 端口记录文件  pic_uploader.port -> via_driver.port
  · 新增 SPA 回退（见 Handler.do_GET 的注释）—— 驱动是单页应用，
                    在 /screen 上按 F5 必须还能拿到 index.html

起始端口 18755 的选法沿用原注释：
  本机动态端口范围 1024..15000 -> 安全区 15001..65535
  Windows 默认     49152..65535 -> 安全区 1024..49151
  两者交集                      -> 15001..49151
  18754/18755 落在交集内。
"""

import http.server
import os
import socket
import socketserver
import subprocess
import sys
import tempfile
import threading
import urllib.error
import urllib.request
import webbrowser

HOST = "127.0.0.1"
PORT_START = 18755          # 只是"起点"，不是配置项
PORT_TRIES = 20             # 最多往后试 20 个
LOCK_PORT = 18754           # 仅用于单实例互斥
PAGE = "index.html"
SUBDIR = "dist"             # npm run build 的输出目录

PORT_FILE = os.path.join(tempfile.gettempdir(), "via_driver.port")

# WebHID / Web Serial 只有 Chromium 系支持。优先直接拉 Chrome / Edge，
# 而不是 webbrowser.open —— 后者会走系统默认浏览器，万一是 Firefox
# 就会得到一个"页面能开、功能全废"的结果，且错误信息难以理解。
CHROMIUM_CANDIDATES = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    os.path.join(os.environ.get("LOCALAPPDATA", ""),
                 r"Google\Chrome\Application\chrome.exe"),
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
]


def open_browser(url):
    """优先用 Chromium 系浏览器打开；都找不到才退回系统默认浏览器。"""
    for exe in CHROMIUM_CANDIDATES:
        if exe and os.path.isfile(exe):
            try:
                subprocess.Popen([exe, url], close_fds=True)
                return True
            except OSError:
                continue
    try:
        return webbrowser.open(url)
    except Exception:
        return False


def find_free_port():
    """从 PORT_START 起逐个试绑，返回第一个可用的端口；全满返回 None。"""
    for port in range(PORT_START, PORT_START + PORT_TRIES):
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            s.bind((HOST, port))
            return port
        except OSError:
            continue
        finally:
            s.close()
    return None


def acquire_lock():
    """占住 LOCK_PORT 表示"我是唯一实例"；占不到说明已经有一个在跑。"""
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.bind((HOST, LOCK_PORT))
        s.listen(1)
        return s
    except OSError:
        s.close()
        return None


def open_existing_instance():
    """已经有一个实例在跑：读出它用的端口，直接把那个页面打开。"""
    try:
        with open(PORT_FILE, "r", encoding="utf-8") as f:
            port = int(f.read().strip())
    except (OSError, ValueError):
        print("检测到已经有一个驱动服务在运行，但读不到它用的端口。")
        print("请先关掉那个命令行窗口，再重新双击。")
        return

    url = "http://%s:%d/%s" % (HOST, port, PAGE)
    try:
        urllib.request.urlopen(url, timeout=1.5).read(1)
    except (urllib.error.URLError, OSError):
        print("端口记录是残留的，对应的服务已经不在运行了。")
        print("请把这个窗口关掉，等几秒再双击一次。")
        return

    print("服务已经在运行，直接打开：%s" % url)
    open_browser(url)


class Handler(http.server.SimpleHTTPRequestHandler):
    """静态文件服务 + 三个小改动。"""

    def do_GET(self):
        if self.path in ("/", ""):
            self.send_response(302)
            self.send_header("Location", "/" + PAGE)
            self.end_headers()
            return

        # ⭐ SPA 回退：驱动是单页应用，wouter 用 History API 改地址栏，
        #    所以在 /screen 上按 F5 会请求 GET /screen —— 磁盘上没有这个文件，
        #    默认实现会 404。凡是"路径里没有扩展名、磁盘上确实不存在"的请求，
        #    一律交给 index.html，让前端自己按路由渲染。
        path_only = self.path.split("?")[0].split("#")[0].lstrip("/")
        if path_only and "." not in os.path.basename(path_only) \
                and not os.path.exists(path_only):
            self.path = "/" + PAGE

        super().do_GET()

    def end_headers(self):
        # 关掉缓存：重新构建后刷新就生效，不会被旧的 js 挡住
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        # 正常请求静默，只留错误
        line = fmt % args
        if " 200 " in line or " 304 " in line or " 302 " in line:
            return
        sys.stderr.write(line + "\n")


class Server(socketserver.ThreadingTCPServer):
    """必须多线程：Chrome 加载一个页面会并发发多个请求。"""
    allow_reuse_address = True
    daemon_threads = True


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    base = os.path.join(here, SUBDIR)
    os.chdir(base)

    if not os.path.isfile(PAGE):
        print("找不到 %s\\%s" % (SUBDIR, PAGE))
        print("请先在项目目录执行： npm run build")
        return 2

    lock = acquire_lock()
    if lock is None:
        open_existing_instance()
        return 0

    port = find_free_port()
    if port is None:
        print("%d~%d 全被占用，无法启动。" % (PORT_START, PORT_START + PORT_TRIES - 1))
        print("请关掉一些程序后重试。")
        lock.close()
        return 3

    try:
        httpd = Server((HOST, port), Handler)
    except OSError as e:
        print("在 %s:%d 上启动服务失败：%s" % (HOST, port, e))
        lock.close()
        return 4

    url = "http://%s:%d/%s" % (HOST, port, PAGE)
    try:
        with open(PORT_FILE, "w", encoding="utf-8") as f:
            f.write(str(port))
    except OSError:
        pass

    print("=" * 64)
    print("  键盘网页驱动  ·  via-driver")
    print("=" * 64)
    print("  页面地址 : %s" % url)
    print("  服务目录 : %s" % base)
    print("  服务端口 : %d  （自动选择；被占用会自己换）" % port)
    print()
    print("  浏览器会自动打开。没打开就手动复制上面的地址。")
    print("  必须用 Chrome 或 Edge —— Firefox / Safari 不支持 WebHID / Web Serial。")
    print()
    print("  关闭本窗口即停止服务。")
    print("=" * 64)

    # 稍等一拍再开浏览器，避免浏览器比服务先到、看到连接被拒。
    # 设 DRIVER_NO_BROWSER=1 可只起服务、不开浏览器。
    if not os.environ.get("DRIVER_NO_BROWSER"):
        threading.Timer(0.6, lambda: open_browser(url)).start()

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止。")
    finally:
        httpd.server_close()
        lock.close()
        try:
            os.remove(PORT_FILE)
        except OSError:
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
