# -*- coding: utf-8 -*-
"""
core/dir_dialog.py — Windows 原生目录选择对话框（纯 ctypes，零依赖）

为什么不用 tkinter：发布包用的是嵌入式 Python（python embeddable package），
默认不带 tkinter/tcl——实测打包实例 `import tkinter` 直接 ModuleNotFoundError。
ctypes 在嵌入式版里可用，直接调 COM 的 IFileOpenDialog（Vista+ 现代目录对话框，
FOS_PICKFOLDERS），失败时回落 SHBrowseForFolder（旧式树形对话框）。

仅 Windows 有意义；其他平台 pick_directory 返回 None（调用方按取消处理）。
"""
import ctypes
import threading
import time
from ctypes import wintypes

# FOS flags
_FOS_PICKFOLDERS = 0x00000020
_FOS_FORCEFILESYSTEM = 0x00000040
# IShellItem::GetDisplayName
_SIGDN_FILESYSPATH = 0x80058007

_S_OK = 0
_ERROR_CANCELLED = 0x800704C7  # HRESULT_FROM_WIN32(ERROR_CANCELLED)


class _GUID(ctypes.Structure):
    _fields_ = [
        ("Data1", ctypes.c_ulong),
        ("Data2", ctypes.c_ushort),
        ("Data3", ctypes.c_ushort),
        ("Data4", ctypes.c_ubyte * 8),
    ]


def _guid(text):
    """'{XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX}' → _GUID"""
    h = text.strip("{}").replace("-", "")
    d4 = (ctypes.c_ubyte * 8)(*[int(h[i:i + 2], 16) for i in range(16, 32, 2)])
    return _GUID(int(h[0:8], 16), int(h[8:12], 16), int(h[12:16], 16), d4)


_CLSID_FileOpenDialog = _guid("{DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7}")
_IID_IFileOpenDialog = _guid("{D57C7288-D4AD-4768-BE02-9D969532D960}")

# vtable 序号（IFileOpenDialog = IUnknown+IModalWindow+IFileDialog+IFileOpenDialog）
_VT_RELEASE = 2
_VT_SHOW = 3
_VT_GETOPTIONS = 10
_VT_SETOPTIONS = 9
_VT_SETTITLE = 17
_VT_GETRESULT = 20
# IShellItem vtable
_VT_SI_RELEASE = 2
_VT_SI_GETDISPLAYNAME = 5

_WinFunc = ctypes.WINFUNCTYPE


def _vt_call(obj, index, restype, *args):
    """按 vtable 序号调 COM 方法。args 首参隐含 this。"""
    vtable = ctypes.cast(
        ctypes.cast(obj, ctypes.POINTER(ctypes.c_void_p)).contents,
        ctypes.POINTER(ctypes.c_void_p * (index + 1)),
    ).contents
    argtypes = [ctypes.c_void_p] + [type(a) for a in args]
    # 对指针类参数统一放宽为 c_void_p，避免类型严格化带来的转换问题
    argtypes = [ctypes.c_void_p if t is not ctypes.c_ulong else t for t in argtypes]
    fn = _WinFunc(restype, *argtypes)(vtable[index])
    return fn(obj, *args)


_HWND_TOPMOST = -1
_SWP_NOSIZE = 0x0001
_SWP_NOMOVE = 0x0002


def _topmost_bomber(title, stop):
    """服务端是无窗口后台进程，Show() 出的对话框会被当前前台窗口（浏览器/ZCode）
    压在下面——用户以为没弹窗，页面请求又挂着，看起来像「UI 不更新」。
    在 Show 期间轮询找到对话框窗口并提为 TOPMOST，让它浮到最前。"""
    user32 = ctypes.windll.user32
    while not stop.is_set():
        hwnd = user32.FindWindowW(None, title)
        if hwnd:
            user32.SetWindowPos(hwnd, _HWND_TOPMOST, 0, 0, 0, 0,
                                _SWP_NOSIZE | _SWP_NOMOVE)
            user32.SetForegroundWindow(hwnd)
            return
        time.sleep(0.05)


def _pick_folder_modern(title):
    """IFileOpenDialog + FOS_PICKFOLDERS。返回 (status, path)：
    status: 'ok' | 'cancelled' | 'error'
    """
    ole32 = ctypes.windll.ole32
    hr = ole32.CoInitializeEx(None, 0x2)  # COINIT_APARTMENTTHREADED
    # S_FALSE(1) 也算成功（已初始化）
    if hr not in (0, 1):
        return ("error", None)
    dlg = ctypes.c_void_p()
    try:
        hr = ole32.CoCreateInstance(
            ctypes.byref(_CLSID_FileOpenDialog), None, 1,  # CLSCTX_INPROC_SERVER
            ctypes.byref(_IID_IFileOpenDialog), ctypes.byref(dlg),
        )
        if hr != _S_OK or not dlg:
            return ("error", None)
        # options |= FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM
        opts = ctypes.c_ulong(0)
        if _vt_call(dlg, _VT_GETOPTIONS, ctypes.c_long, ctypes.byref(opts)) == _S_OK:
            _vt_call(dlg, _VT_SETOPTIONS, ctypes.c_long,
                     ctypes.c_ulong(opts.value | _FOS_PICKFOLDERS | _FOS_FORCEFILESYSTEM))
        if title:
            _vt_call(dlg, _VT_SETTITLE, ctypes.c_long, ctypes.c_wchar_p(title))
        # owner = 当前前台窗口（通常是发起点击的浏览器），保证对话框归在它名下；
        # 同时起 topmost 线程兜底——后台进程弹窗很容易被前台窗口压住
        hwnd = ctypes.windll.user32.GetForegroundWindow()
        stop = threading.Event()
        bomber = threading.Thread(target=_topmost_bomber,
                                  args=(title or "选择工作目录", stop), daemon=True)
        bomber.start()
        try:
            hr = _vt_call(dlg, _VT_SHOW, ctypes.c_long, ctypes.c_void_p(hwnd))
        finally:
            stop.set()
        if hr == _ERROR_CANCELLED:
            return ("cancelled", None)
        if hr != _S_OK:
            return ("error", None)
        item = ctypes.c_void_p()
        hr = _vt_call(dlg, _VT_GETRESULT, ctypes.c_long, ctypes.byref(item))
        if hr != _S_OK or not item:
            return ("error", None)
        try:
            name_ptr = ctypes.c_void_p()
            hr = _vt_call(item, _VT_SI_GETDISPLAYNAME, ctypes.c_long,
                          ctypes.c_ulong(_SIGDN_FILESYSPATH), ctypes.byref(name_ptr))
            if hr != _S_OK or not name_ptr:
                return ("error", None)
            try:
                path = ctypes.wstring_at(name_ptr.value)
            finally:
                ole32.CoTaskMemFree(name_ptr)
            return ("ok", path)
        finally:
            _vt_call(item, _VT_SI_RELEASE, ctypes.c_ulong)
    finally:
        if dlg:
            _vt_call(dlg, _VT_RELEASE, ctypes.c_ulong)
        ole32.CoUninitialize()


class _BROWSEINFO(ctypes.Structure):
    _fields_ = [
        ("hwndOwner", wintypes.HWND),
        ("pidlRoot", ctypes.c_void_p),
        ("pszDisplayName", ctypes.c_wchar_p),
        ("lpszTitle", ctypes.c_wchar_p),
        ("ulFlags", wintypes.UINT),
        ("lpfn", ctypes.c_void_p),
        ("lParam", ctypes.c_void_p),
        ("iImage", ctypes.c_int),
    ]


def _pick_folder_legacy(title):
    """SHBrowseForFolder 回落（旧式对话框）。返回 (status, path)。"""
    shell32 = ctypes.windll.shell32
    ole32 = ctypes.windll.ole32
    BIF_RETURNONLYFSDIRS = 0x0001
    BIF_NEWDIALOGSTYLE = 0x0040
    buf = ctypes.create_unicode_buffer(260)
    bi = _BROWSEINFO()
    bi.hwndOwner = ctypes.windll.user32.GetForegroundWindow()
    bi.pszDisplayName = ctypes.cast(buf, ctypes.c_wchar_p)
    bi.lpszTitle = title or "选择工作目录"
    bi.ulFlags = BIF_RETURNONLYFSDIRS | BIF_NEWDIALOGSTYLE
    pidl = shell32.SHBrowseForFolderW(ctypes.byref(bi))
    if not pidl:
        return ("cancelled", None)
    try:
        path_buf = ctypes.create_unicode_buffer(1024)
        if shell32.SHGetPathFromIDListW(pidl, path_buf):
            return ("ok", path_buf.value)
        return ("error", None)
    finally:
        ole32.CoTaskMemFree(pidl)


def pick_directory(title="选择工作目录"):
    """弹出系统目录选择对话框，返回用户选的绝对路径；取消/失败返回 None。

    阻塞调用（对话框模态）。FastAPI 端点里要用 sync def（线程池执行）。
    """
    try:
        status, path = _pick_folder_modern(title)
        if status == "ok" and path:
            return path
        if status == "cancelled":
            return None
        # error → 回落旧式对话框
        status2, path2 = _pick_folder_legacy(title)
        return path2 if status2 == "ok" else None
    except Exception:
        try:
            status2, path2 = _pick_folder_legacy(title)
            return path2 if status2 == "ok" else None
        except Exception:
            return None
