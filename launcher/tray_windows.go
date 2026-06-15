//go:build windows

package main

import (
	"log"
	"os"
	"path/filepath"
	"syscall"
	"unsafe"
)

var (
	user32                  = syscall.NewLazyDLL("user32.dll")
	shell32                 = syscall.NewLazyDLL("shell32.dll")
	kernel32                = syscall.NewLazyDLL("kernel32.dll")
	procRegisterClassExW    = user32.NewProc("RegisterClassExW")
	procCreateWindowExW     = user32.NewProc("CreateWindowExW")
	procDefWindowProcW      = user32.NewProc("DefWindowProcW")
	procGetMessageW         = user32.NewProc("GetMessageW")
	procTranslateMessage    = user32.NewProc("TranslateMessage")
	procDispatchMessageW    = user32.NewProc("DispatchMessageW")
	procPostQuitMessage     = user32.NewProc("PostQuitMessage")
	procLoadCursorW         = user32.NewProc("LoadCursorW")
	procLoadIconW           = user32.NewProc("LoadIconW")
	procDestroyWindow       = user32.NewProc("DestroyWindow")
	procPostMessageW        = user32.NewProc("PostMessageW")
	procSetForegroundWindow = user32.NewProc("SetForegroundWindow")
	procCreatePopupMenu     = user32.NewProc("CreatePopupMenu")
	procAppendMenuW         = user32.NewProc("AppendMenuW")
	procTrackPopupMenu      = user32.NewProc("TrackPopupMenu")
	procDestroyMenu         = user32.NewProc("DestroyMenu")
	procGetCursorPos        = user32.NewProc("GetCursorPos")
	procShellNotifyIconW    = shell32.NewProc("Shell_NotifyIconW")
	procExtractIconW        = shell32.NewProc("ExtractIconW")
	procUnregisterClassW    = user32.NewProc("UnregisterClassW")
)

const (
	WM_DESTROY    = 0x0002
	WM_CLOSE      = 0x0010
	WM_USER       = 0x0400
	WM_TRAYICON   = WM_USER + 1
	WM_COMMAND    = 0x0111
	WM_RBUTTONUP  = 0x0205
	WM_LBUTTONDBLCLK = 0x0203
	WM_NULL       = 0x0000

	NIM_ADD    = 0x00000000
	NIM_MODIFY = 0x00000001
	NIM_DELETE = 0x00000002

	NIF_MESSAGE = 0x00000001
	NIF_ICON    = 0x00000002
	NIF_TIP     = 0x00000004

	MF_STRING   = 0x00000000
	MF_SEPARATOR = 0x00000800

	TPM_LEFTALIGN = 0x0000
	TPM_NONOTIFY  = 0x0080
	TPM_RETURNCMD = 0x0100

	IDI_APPLICATION = 32512
	 IDC_ARROW     = 32512

	CW_USEDEFAULT = ^0x7fffffff

	HWND_MESSAGE  = ^uintptr(2) // -3，消息专用窗口

	// Menu command IDs
	IDM_OPEN = 1001
	IDM_EXIT = 1002
)

type WNDCLASSEXW struct {
	CbSize        uint32
	Style         uint32
	LpfnWndProc   uintptr
	CbClsExtra    int32
	CbWndExtra    int32
	HInstance     syscall.Handle
	HIcon         syscall.Handle
	HCursor       syscall.Handle
	HbrBackground syscall.Handle
	LpszMenuName  *uint16
	LpszClassName *uint16
	HIconSm       syscall.Handle
}

type NOTIFYICONDATAW struct {
	CbSize           uint32
	HWnd             syscall.Handle
	UID              uint32
	UFlags           uint32
	UCallbackMessage uint32
	HIcon            syscall.Handle
	SzTip            [128]uint16
	DwState          uint32
	DwStateMask      uint32
	SzInfo           [256]uint16
	UVersion         uint32
	SzInfoTitle      [64]uint16
	DwInfoFlags      uint32
}

type MSG struct {
	HWnd    syscall.Handle
	Message uint32
	WParam  uintptr
	LParam  uintptr
	Time    uint32
	Pt      struct{ X, Y int32 }
}

var (
	trayHWnd     syscall.Handle
	trayOnOpen   func()
	trayOnExit   func()
	trayOnPanel  func() // 左键 → 状态面板
	shouldExit   bool

	// CRITICAL: 必须用包级变量持有 callback，防止 Go GC 回收
	trayWndProcCb uintptr

	// 托盘图标句柄（给面板复用）
	trayHIcon   syscall.Handle
	trayVersion string
	trayBrowserURL string
)

// trayWndProc — 窗口过程
func trayWndProc(hWnd syscall.Handle, msg uint32, wParam, lParam uintptr) uintptr {
	switch msg {
	case WM_COMMAND:
		switch wParam {
		case IDM_OPEN:
			if trayOnOpen != nil {
				trayOnOpen()
			}
		case IDM_EXIT:
			RemoveTrayIcon()
			procPostQuitMessage.Call(0)
			shouldExit = true
		}

	case WM_TRAYICON:
		switch lParam {
		case 0x0202: // WM_LBUTTONUP — 左键 → 状态面板
			if trayOnPanel != nil {
				trayOnPanel()
			}
		case WM_LBUTTONDBLCLK:
			// 双击也弹面板（如果面板已开则不重复）
			if trayOnPanel != nil {
				trayOnPanel()
			}
		case WM_RBUTTONUP:
			showContextMenu(hWnd)
		}

	case WM_DESTROY:
		RemoveTrayIcon()
		procPostQuitMessage.Call(0)
		shouldExit = true
	}

	ret, _, _ := procDefWindowProcW.Call(
		uintptr(hWnd), uintptr(msg), wParam, lParam,
	)
	return ret
}

func showContextMenu(hWnd syscall.Handle) {
	hMenu, _, _ := procCreatePopupMenu.Call()
	if hMenu == 0 {
		log.Printf("[Tray] CreatePopupMenu failed")
		return
	}

	openStr, _ := syscall.UTF16PtrFromString("打开浏览器")
	exitStr, _ := syscall.UTF16PtrFromString("退出")

	procAppendMenuW.Call(hMenu, MF_STRING, IDM_OPEN, uintptr(unsafe.Pointer(openStr)))
	procAppendMenuW.Call(hMenu, MF_SEPARATOR, 0, 0)
	procAppendMenuW.Call(hMenu, MF_STRING, IDM_EXIT, uintptr(unsafe.Pointer(exitStr)))

	// 获取鼠标当前位置
	var pt struct{ X, Y int32 }
	ret, _, _ := procGetCursorPos.Call(uintptr(unsafe.Pointer(&pt)))
	if ret == 0 {
		log.Printf("[Tray] GetCursorPos failed")
		procDestroyMenu.Call(hMenu)
		return
	}

	// Windows 经典修复：SetForegroundWindow 必须在 TrackPopupMenu 之前调用
	procSetForegroundWindow.Call(uintptr(hWnd))

	// 使用 TPM_RETURNCMD：TrackPopupMenu 直接返回选中的命令 ID
	// 不依赖 WM_COMMAND 回调——更可靠，不会被消息窗口类型干扰
	cmd, _, _ := procTrackPopupMenu.Call(
		hMenu,
		TPM_LEFTALIGN|TPM_RETURNCMD,
		uintptr(pt.X), uintptr(pt.Y), 0,
		uintptr(hWnd),
		0,
	)

	// PostMessage WM_NULL 修复焦点问题
	procPostMessageW.Call(uintptr(hWnd), WM_NULL, 0, 0)
	procDestroyMenu.Call(hMenu)

	// 手动处理选中的命令
	switch cmd {
	case IDM_OPEN:
		if trayOnOpen != nil {
			trayOnOpen()
		}
	case IDM_EXIT:
		RemoveTrayIcon()
		procPostQuitMessage.Call(0)
		shouldExit = true
	}
}

// InitTray — 创建隐藏窗口 + 托盘图标
func InitTray(className string, tip string, onOpen func(), onExit func(), onPanel func(), version string, browserURL string) error {
	trayOnOpen = onOpen
	trayOnExit = onExit
	trayOnPanel = onPanel
	trayVersion = version
	trayBrowserURL = browserURL

	// 用 GetModuleHandle 获取 hInstance
	k32 := syscall.NewLazyDLL("kernel32.dll")
	getModuleHandle := k32.NewProc("GetModuleHandleW")
	hInst, _, _ := getModuleHandle.Call(0)
	if hInst == 0 {
		log.Printf("[Tray] GetModuleHandle failed")
	}

	// 加载图标：优先 logo.ico → exe 内嵌 → 系统默认
	hIcon, _, _ := procLoadIconW.Call(0, IDI_APPLICATION)

	// 方案1: 尝试加载 logo.ico
	exePath := getExePath()
	appDir := filepath.Dir(exePath)
	icoPath := filepath.Join(appDir, "server", "static", "img", "logo.ico")
	if _, err := os.Stat(icoPath); err == nil {
		icoPtr, _ := syscall.UTF16PtrFromString(icoPath)
		// LoadImageW 加载 .ico 文件
		IMAGE_ICON := 1
		LR_LOADFROMFILE := 0x00000010
		hLoaded, _, _ := user32.NewProc("LoadImageW").Call(
			0,
			uintptr(unsafe.Pointer(icoPtr)),
			uintptr(IMAGE_ICON),
			32, 32,
			uintptr(LR_LOADFROMFILE),
		)
		if hLoaded != 0 {
			hIcon = hLoaded
			log.Printf("[Tray] 使用 logo.ico 图标: %s", icoPath)
		} else {
			log.Printf("[Tray] logo.ico 加载失败，尝试其他方案")
		}
	}

	// 方案2: 尝试从 exe 提取图标
	if hIcon == 0 || hIcon == IDI_APPLICATION {
		exePath16, _ := syscall.UTF16PtrFromString(exePath)
		hExeIcon, _, _ := procExtractIconW.Call(hInst, uintptr(unsafe.Pointer(exePath16)), 0)
		if hExeIcon != 0 && hExeIcon != 1 {
			hIcon = hExeIcon
			log.Printf("[Tray] 使用 exe 内嵌图标")
		} else {
			log.Printf("[Tray] 使用系统默认图标")
		}
	}

	// 先尝试注销旧窗口类（防止重复注册）
	classNamePtr, _ := syscall.UTF16PtrFromString(className)
	procUnregisterClassW.Call(uintptr(unsafe.Pointer(classNamePtr)), hInst)
	hCursor, _, _ := procLoadCursorW.Call(0, IDC_ARROW)

	// 将 callback 存入包级变量，防止 GC 回收
	// 这是托盘菜单几分钟后失效的根因：GC 回收了 callback → 野指针
	trayWndProcCb = syscall.NewCallback(trayWndProc)

	wndClass := WNDCLASSEXW{
		CbSize:        uint32(unsafe.Sizeof(WNDCLASSEXW{})),
		LpfnWndProc:   trayWndProcCb, // 使用包级变量引用
		HInstance:     syscall.Handle(hInst),
		HIcon:         syscall.Handle(hIcon),
		HCursor:       syscall.Handle(hCursor),
		LpszClassName: classNamePtr,
		HIconSm:       syscall.Handle(hIcon),
	}

	ret, _, err := procRegisterClassExW.Call(uintptr(unsafe.Pointer(&wndClass)))
	if ret == 0 {
		log.Printf("[Tray] RegisterClassEx failed: %v", err)
		return err
	}

	// 创建消息专用隐藏窗口（HWND_MESSAGE 确保不在任务栏显示、不接收广播消息）
	windowName, _ := syscall.UTF16PtrFromString("SidemateTray")
	hWnd, _, err := procCreateWindowExW.Call(
		0,
		uintptr(unsafe.Pointer(classNamePtr)),
		uintptr(unsafe.Pointer(windowName)),
		0, // 不可见
		0, 0, 0, 0,
		HWND_MESSAGE, // -3：消息专用窗口，不会出现在任务栏
		0, hInst, 0,
	)
	if hWnd == 0 {
		log.Printf("[Tray] CreateWindow failed: %v", err)
		return err
	}
	trayHWnd = syscall.Handle(hWnd)
	trayHIcon = syscall.Handle(hIcon) // 保存给面板复用

	// 添加托盘图标
	nid := NOTIFYICONDATAW{
		CbSize:           uint32(unsafe.Sizeof(NOTIFYICONDATAW{})),
		HWnd:             trayHWnd,
		UID:              1,
		UFlags:           NIF_MESSAGE | NIF_ICON | NIF_TIP,
		UCallbackMessage: WM_TRAYICON,
		HIcon:            syscall.Handle(hIcon),
	}
	copy(nid.SzTip[:], utf16FromString(tip))

	ret, _, err = procShellNotifyIconW.Call(NIM_ADD, uintptr(unsafe.Pointer(&nid)))
	if ret == 0 {
		log.Printf("[Tray] Shell_NotifyIcon failed: %v", err)
		return err
	}

	log.Printf("[Tray] 托盘图标已创建")
	return nil
}

// RemoveTrayIcon — 移除托盘图标
func RemoveTrayIcon() {
	if trayHWnd == 0 {
		return
	}
	nid := NOTIFYICONDATAW{
		CbSize: uint32(unsafe.Sizeof(NOTIFYICONDATAW{})),
		HWnd:   trayHWnd,
		UID:    1,
	}
	procShellNotifyIconW.Call(NIM_DELETE, uintptr(unsafe.Pointer(&nid)))
	procDestroyWindow.Call(uintptr(trayHWnd))
	trayHWnd = 0
	log.Printf("[Tray] 托盘图标已移除")
}

// TrayMessageLoop — 运行托盘消息循环（阻塞）
func TrayMessageLoop() {
	var msg MSG
	for {
		ret, _, _ := procGetMessageW.Call(uintptr(unsafe.Pointer(&msg)), 0, 0, 0)
		if ret == 0 || shouldExit {
			break
		}
		procTranslateMessage.Call(uintptr(unsafe.Pointer(&msg)))
		procDispatchMessageW.Call(uintptr(unsafe.Pointer(&msg)))
	}

	if trayOnExit != nil {
		trayOnExit()
	}
}

// getExePath — 获取当前 exe 路径
func getExePath() string {
	k32 := syscall.NewLazyDLL("kernel32.dll")
	getModuleFileName := k32.NewProc("GetModuleFileNameW")
	buf := make([]uint16, 512)
	ret, _, _ := getModuleFileName.Call(0, uintptr(unsafe.Pointer(&buf[0])), 512)
	if ret == 0 {
		return ""
	}
	return syscall.UTF16ToString(buf)
}

// utf16FromString — 转换 UTF-8 到 UTF-16 切片
func utf16FromString(s string) []uint16 {
	runes := []rune(s)
	result := make([]uint16, 0, len(runes)+1)
	for _, r := range runes {
		result = append(result, uint16(r))
	}
	return result
}
