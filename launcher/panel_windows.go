//go:build windows

package main

import (
	"fmt"
	"log"
	"syscall"
	"unsafe"
)

// ===== 状态面板 — 左键托盘弹出（v4：通过托盘消息循环分发） =====

const (
	panelBaseW = 300
	panelBaseH = 240

	// 颜色 (BGR)
	pnlColorBG      = 0x00faf9f7 // #f7f9fa
	pnlColorTitle   = 0x004c3420 // #20344c 深蓝灰
	pnlColorText    = 0x00303030 // #303030
	pnlColorSub     = 0x00706858 // #586870
	pnlColorGreen   = 0x0088b30e // #0eb388
	pnlColorRed     = 0x002c2cb9 // #b91c2c
	pnlColorSep     = 0x00e2e2e2 // #e2e2e2
	pnlColorBtnBG   = 0x004c3420 // #20344c 同标题栏
	pnlColorBtnText = 0x00ffffff // 白
)

// PanelState — 面板状态
type PanelState struct {
	hWnd          syscall.Handle
	hIcon         syscall.Handle
	version       string
	browserURL    string
	onOpenBrowser func()
	ollamaPort    int
	serverPort    int
	ollamaAlive   bool
	serverAlive   bool
	createdAt     uint32 // 创建时间（GetTickCount），用于防抖
}

var (
	panelState    *PanelState
	panelWndClass string = "SidematePanel"
)

// panelInitDPI — 复用 splash 的 dpi 全局变量
func panelInitDPI() int32 {
	if dpi > 0 {
		return dpi
	}
	hDC, _, _ := user32.NewProc("GetDC").Call(0)
	if hDC != 0 {
		gdc := syscall.NewLazyDLL("gdi32.dll").NewProc("GetDeviceCaps")
		dpiVal, _, _ := gdc.Call(hDC, 90) // LOGPIXELSY
		user32.NewProc("ReleaseDC").Call(0, hDC)
		if dpiVal > 0 {
			dpi = int32(dpiVal)
		}
	}
	if dpi == 0 {
		dpi = 96
	}
	return dpi
}

// ShowStatusPanel — 创建或刷新状态面板
func ShowStatusPanel(version string, browserURL string, ollamaPort, serverPort int, hIcon syscall.Handle, onOpenBrowser func()) {
	// 如果面板已存在，刷新状态
	if panelState != nil && panelState.hWnd != 0 {
		alive, _, _ := user32.NewProc("IsWindow").Call(uintptr(panelState.hWnd))
		if alive != 0 {
			panelState.ollamaAlive = isPortOpen("127.0.0.1", ollamaPort)
			panelState.serverAlive = isPortOpen("127.0.0.1", serverPort)
			splashProcInvalidateRect.Call(uintptr(panelState.hWnd), 0, 0)
			splashProcShowWindow.Call(uintptr(panelState.hWnd), 1)
			log.Println("[Panel] 面板已存在，前置刷新")
			return
		}
	}

	d := panelInitDPI()
	pw := panelBaseW * d / 96
	ph := panelBaseH * d / 96

	hInst, _, _ := kernel32.NewProc("GetModuleHandleW").Call(0)

	className, _ := syscall.UTF16PtrFromString(panelWndClass)
	procUnregisterClassW.Call(uintptr(unsafe.Pointer(className)), hInst)

	hCursor, _, _ := procLoadCursorW.Call(0, IDC_ARROW)

	wc := WNDCLASSEXW{
		CbSize:        uint32(unsafe.Sizeof(WNDCLASSEXW{})),
		LpfnWndProc:   syscall.NewCallback(panelWndProc),
		HInstance:     syscall.Handle(hInst),
		HCursor:       syscall.Handle(hCursor),
		LpszClassName: className,
		HIconSm:       syscall.Handle(hIcon),
	}
	ret, _, _ := procRegisterClassExW.Call(uintptr(unsafe.Pointer(&wc)))
	if ret == 0 {
		log.Println("[Panel] RegisterClassExW 失败")
		return
	}

	// 定位：屏幕右下角（托盘区域上方）
	screenW, _, _ := splashProcGetSysMetrics.Call(0)
	screenH, _, _ := splashProcGetSysMetrics.Call(1)
	x := int32(screenW) - pw - 16*d/96
	y := int32(screenH) - ph - 48*d/96

	windowName, _ := syscall.UTF16PtrFromString("Sidemate Status")
	// WS_EX_TOOLWINDOW(0x80) | WS_EX_TOPMOST(0x08) — 不抢焦点，不被 Alt+Tab 显示
	exStyle := uintptr(0x00000088)
	// WS_POPUP(0x80000000) | WS_CLIPCHILDREN(0x02000000)
	dwStyle := uintptr(0x80000000 | 0x02000000)

	hWnd, _, lastErr := procCreateWindowExW.Call(
		exStyle,
		uintptr(unsafe.Pointer(className)),
		uintptr(unsafe.Pointer(windowName)),
		dwStyle,
		uintptr(x), uintptr(y),
		uintptr(pw), uintptr(ph),
		0, 0, hInst, 0,
	)
	if hWnd == 0 {
		log.Printf("[Panel] CreateWindowExW 失败: %v", lastErr)
		return
	}

	// 圆角
	r := 12 * d / 96
	hRgn, _, _ := splashProcCreateRgn.Call(0, 0, uintptr(pw), uintptr(ph), uintptr(r*2), uintptr(r*2))
	if hRgn != 0 {
		splashProcSetWndRgn.Call(hWnd, hRgn, 1)
	}

	panelState = &PanelState{
		hWnd:          syscall.Handle(hWnd),
		hIcon:         hIcon,
		version:       version,
		browserURL:    browserURL,
		onOpenBrowser: onOpenBrowser,
		ollamaPort:    ollamaPort,
		serverPort:    serverPort,
		ollamaAlive:   isPortOpen("127.0.0.1", ollamaPort),
		serverAlive:   isPortOpen("127.0.0.1", serverPort),
	}
	// 记录创建时间（防抖用）
	tick, _, _ := kernel32.NewProc("GetTickCount").Call()
	panelState.createdAt = uint32(tick)

	// 设置定时器：每 2 秒刷新端口状态 + 每 300ms 检测鼠标是否离开
	splashProcSetTimer.Call(hWnd, 200, 2000, 0)
	splashProcSetTimer.Call(hWnd, 201, 300, 0)

	splashProcShowWindow.Call(hWnd, 1) // SW_SHOWNORMAL
	log.Printf("[Panel] 状态面板已显示: hWnd=0x%X, DPI=%d, size=%dx%d, pos=(%d,%d)", hWnd, d, pw, ph, x, y)
}

// panelWndProc — 面板窗口过程
func panelWndProc(hWnd syscall.Handle, msg uint32, wParam, lParam uintptr) uintptr {
	switch msg {
	case 0x000F: // WM_PAINT
		panelPaint(hWnd)
		return 0

	case 0x0014: // WM_ERASEBKGND
		return 1

	case 0x0113: // WM_TIMER
		if panelState == nil || panelState.hWnd != hWnd {
			return 0
		}
		if wParam == 200 {
			// 每 2 秒刷新端口状态（Patch5 P0：用 HTTP 深度探活替代 TCP 端口探活）
			// S4: P7-4 改为 /v1/models（llama-server 不提供 /api/tags）
			panelState.ollamaAlive = isServiceAlive(fmt.Sprintf("http://127.0.0.1:%d/v1/models", panelState.ollamaPort), "llama-server")
			panelState.serverAlive = isServiceAlive(fmt.Sprintf("http://127.0.0.1:%d/api/status", panelState.serverPort), "python")
			splashProcInvalidateRect.Call(uintptr(hWnd), 0, 0)
		} else if wParam == 201 {
			panelCheckMouseOutside(hWnd)
		}
		return 0

	case 0x0201: // WM_LBUTTONDOWN
		panelHandleClick(int32(lParam&0xFFFF), int32(lParam>>16))
		return 0

	case 0x0002: // WM_DESTROY
		splashProcKillTimer.Call(uintptr(hWnd), 200)
		splashProcKillTimer.Call(uintptr(hWnd), 201)
		if panelState != nil {
			panelState.hWnd = 0
		}
	}

	ret, _, _ := procDefWindowProcW.Call(uintptr(hWnd), uintptr(msg), wParam, lParam)
	return ret
}

// panelCheckMouseOutside — 鼠标离开面板时自动关闭
func panelCheckMouseOutside(hWnd syscall.Handle) {
	if panelState == nil {
		return
	}
	tick, _, _ := kernel32.NewProc("GetTickCount").Call()
	if panelState.createdAt > 0 && uint32(tick)-panelState.createdAt < 10000 {
		return // 创建后 10s 免疫，给用户足够时间查看
	}

	var pt struct{ X, Y int32 }
	user32.NewProc("GetCursorPos").Call(uintptr(unsafe.Pointer(&pt)))

	// POINT 按值传递（64位下 = uintptr）
	pointVal := uintptr(pt.X) & 0xFFFFFFFF
	pointVal |= uintptr(uint32(pt.Y)) << 32
	hwndUnder, _, _ := user32.NewProc("WindowFromPoint").Call(pointVal)

	if syscall.Handle(hwndUnder) != panelState.hWnd {
		log.Println("[Panel] 鼠标移出面板，自动关闭")
		panelClose()
	}
}

func panelClose() {
	if panelState != nil && panelState.hWnd != 0 {
		log.Printf("[Panel] 关闭面板: hWnd=0x%X", panelState.hWnd)
		procDestroyWindow.Call(uintptr(panelState.hWnd))
		panelState.hWnd = 0
	}
}

// ===== 面板绘制（复用 splash 的 PAINTSTRUCT + proc） =====

func panelPaint(hWnd syscall.Handle) {
	// 复用 splash 里已验证的 PAINTSTRUCT 定义
	var ps splashPAINTSTRUCT
	splashProcBeginPaint.Call(uintptr(hWnd), uintptr(unsafe.Pointer(&ps)))
	defer splashProcEndPaint.Call(uintptr(hWnd), uintptr(unsafe.Pointer(&ps)))

	if panelState == nil {
		return
	}

	hdc := ps.Hdc
	d := panelInitDPI()
	sc := func(v int32) int32 { return v * d / 96 }
	pw := panelBaseW * d / 96
	ph := panelBaseH * d / 96

	// === 整体背景 ===
	panelFillRect(hdc, 0, 0, pw, ph, pnlColorBG)

	// === 标题栏 ===
	titleH := sc(42)
	panelFillRect(hdc, 0, 0, pw, titleH, pnlColorTitle)

	// Logo
	if panelState.hIcon != 0 {
		iconSz := sc(26)
		splashProcDrawIconEx.Call(
			uintptr(hdc), uintptr(sc(14)), uintptr((titleH-iconSz)/2),
			uintptr(panelState.hIcon),
			uintptr(iconSz), uintptr(iconSz),
			0, 0, 3,
		)
	}

	// 标题
	panelDrawTextEx(hdc, "桌伴 · Sidemate", sc(46), 0, pw-sc(40), titleH, int32(0x00ffffff), sc(15), true)

	// 关闭 ✕
	panelDrawTextEx(hdc, "✕", pw-sc(34), sc(4), sc(30), titleH-sc(8), int32(0x00aaaaaa), sc(13), true)

	// === 版本号 ===
	vy := titleH + sc(10)
	panelDrawTextEx(hdc, panelState.version, 0, vy, pw, sc(18), int32(pnlColorSub), sc(11), true)

	// === 分隔线 ===
	sy := vy + sc(22)
	panelDrawLine(hdc, sc(20), sy, pw-sc(20), sy, pnlColorSep)

	// === 服务状态 ===
	sy += sc(16)
	sy += panelDrawServiceRow(hdc, "模型服务",
		fmt.Sprintf("127.0.0.1:%d", panelState.ollamaPort),
		panelState.ollamaAlive, sc(20), sy, pw, d)

	sy += sc(12)
	sy += panelDrawServiceRow(hdc, "基础服务",
		fmt.Sprintf("127.0.0.1:%d", panelState.serverPort),
		panelState.serverAlive, sc(20), sy, pw, d)

	// === 分隔线 ===
	sy += sc(8)
	panelDrawLine(hdc, sc(20), sy, pw-sc(20), sy, pnlColorSep)

	// === 浏览器按钮（居中） ===
	sy += sc(14)
	btnW := sc(180)
	btnH := sc(36)
	btnX := (pw - btnW) / 2
	browserBtnRect = panelRect{Left: btnX, Top: sy, Right: btnX + btnW, Bottom: sy + btnH}
	panelDrawButton(hdc, "打开浏览器", browserBtnRect, d)
}

// 按钮命中区域
var browserBtnRect panelRect

type panelRect struct {
	Left, Top, Right, Bottom int32
}

func panelHandleClick(x, y int32) {
	if panelState == nil {
		return
	}

	// 关闭按钮
	d := panelInitDPI()
	sc := func(v int32) int32 { return v * d / 96 }
	pw := panelBaseW * d / 96
	titleH := sc(42)
	closeRect := panelRect{Left: pw - sc(36), Top: 0, Right: pw, Bottom: titleH}
	if x >= closeRect.Left && x <= closeRect.Right &&
		y >= closeRect.Top && y <= closeRect.Bottom {
		panelClose()
		return
	}

	// 浏览器按钮
	if x >= browserBtnRect.Left && x <= browserBtnRect.Right &&
		y >= browserBtnRect.Top && y <= browserBtnRect.Bottom {
		if panelState.onOpenBrowser != nil {
			panelState.onOpenBrowser()
		}
		panelClose()
		return
	}
}

// ===== 绘制辅助（全部复用 splashProc* 避免重复 proc 声明） =====

func panelFillRect(hdc syscall.Handle, x1, y1, x2, y2 int32, color uintptr) {
	var rc splashRect
	rc.Left = x1
	rc.Top = y1
	rc.Right = x2
	rc.Bottom = y2
	hBrush, _, _ := splashProcCreateBrush.Call(color)
	splashProcFillRect.Call(uintptr(hdc), uintptr(unsafe.Pointer(&rc)), hBrush)
	splashProcDeleteObj.Call(hBrush)
}

func panelDrawTextEx(hdc syscall.Handle, text string, x, y, w, h int32, color, fontSize int32, center bool) {
	textPtr, _ := syscall.UTF16PtrFromString(text)
	splashProcSetBkMode.Call(uintptr(hdc), splashTRANSPARENT)
	splashProcSetTextColor.Call(uintptr(hdc), uintptr(color))

	hFont, _, _ := splashGdi32.NewProc("CreateFontW").Call(
		uintptr(-fontSize), 0, 0, 0, 400, 0, 0, 0,
		0x86, 0, 3, 0, 0x22, 0,
	)
	var oldFont uintptr
	if hFont != 0 {
		oldFont, _, _ = splashProcSelectObj.Call(uintptr(hdc), hFont)
	}

	var rc splashRect
	rc.Left = x
	rc.Top = y
	rc.Right = x + w
	rc.Bottom = y + h
	flags := uintptr(splashDT_VCENTER | splashDT_SINGLELINE)
	if center {
		flags |= splashDT_CENTER
	}
	splashProcDrawTextW.Call(
		uintptr(hdc),
		uintptr(unsafe.Pointer(textPtr)),
		0xFFFFFFFF,
		uintptr(unsafe.Pointer(&rc)),
		flags,
	)

	if hFont != 0 {
		splashProcSelectObj.Call(uintptr(hdc), oldFont)
		splashProcDeleteObj.Call(hFont)
	}
}

func panelDrawLine(hdc syscall.Handle, x1, y1, x2, y2 int32, color uintptr) {
	hPen, _, _ := splashProcCreatePen.Call(0, 1, color)
	oldPen, _, _ := splashProcSelectObj.Call(uintptr(hdc), hPen)
	splashProcMoveToEx.Call(uintptr(hdc), uintptr(x1), uintptr(y1), 0)
	splashProcLineTo.Call(uintptr(hdc), uintptr(x2), uintptr(y2))
	splashProcSelectObj.Call(uintptr(hdc), oldPen)
	splashProcDeleteObj.Call(hPen)
}

// panelDrawServiceRow — 画一行服务状态
func panelDrawServiceRow(hdc syscall.Handle, name, addr string, alive bool, x, y, pw, d int32) int32 {
	sc := func(v int32) int32 { return v * d / 96 }

	dotR := sc(7)
	dotCx := x + dotR + sc(2)
	dotCy := y + sc(12)

	var dotColor uintptr
	if alive {
		dotColor = pnlColorGreen
	} else {
		dotColor = pnlColorRed
	}

	hBrush, _, _ := splashProcCreateBrush.Call(dotColor)
	oldB, _, _ := splashProcSelectObj.Call(uintptr(hdc), hBrush)
	hPen, _, _ := splashProcCreatePen.Call(0, 1, dotColor)
	oldP, _, _ := splashProcSelectObj.Call(uintptr(hdc), hPen)
	splashProcEllipse.Call(
		uintptr(hdc),
		uintptr(dotCx-dotR), uintptr(dotCy-dotR),
		uintptr(dotCx+dotR), uintptr(dotCy+dotR),
	)

	if alive {
		hWhitePen, _, _ := splashProcCreatePen.Call(0, 2, 0x00ffffff)
		oldWP, _, _ := splashProcSelectObj.Call(uintptr(hdc), hWhitePen)
		splashProcMoveToEx.Call(uintptr(hdc), uintptr(dotCx-sc(3)), uintptr(dotCy), 0)
		splashProcLineTo.Call(uintptr(hdc), uintptr(dotCx-sc(1)), uintptr(dotCy+sc(3)))
		splashProcMoveToEx.Call(uintptr(hdc), uintptr(dotCx-sc(1)), uintptr(dotCy+sc(3)), 0)
		splashProcLineTo.Call(uintptr(hdc), uintptr(dotCx+sc(4)), uintptr(dotCy-sc(3)))
		splashProcSelectObj.Call(uintptr(hdc), oldWP)
		splashProcDeleteObj.Call(hWhitePen)
	}

	splashProcSelectObj.Call(uintptr(hdc), oldB)
	splashProcSelectObj.Call(uintptr(hdc), oldP)
	splashProcDeleteObj.Call(hBrush)
	splashProcDeleteObj.Call(hPen)

	textX := dotCx + dotR + sc(10)
	statusLabel := "运行中"
	statusColor := pnlColorGreen
	if !alive {
		statusLabel = "已停止"
		statusColor = pnlColorRed
	}

	panelDrawTextEx(hdc, name, textX, y, 200*d/96, 20*d/96, int32(pnlColorText), 13*d/96, false)
	panelDrawTextEx(hdc, addr+"  ·  "+statusLabel, textX, y+18*d/96, 300*d/96, 16*d/96, int32(statusColor), 10*d/96, false)

	return sc(38)
}

func panelDrawButton(hdc syscall.Handle, text string, r panelRect, d int32) {
	hBrush, _, _ := splashProcCreateBrush.Call(pnlColorBtnBG)
	oldB, _, _ := splashProcSelectObj.Call(uintptr(hdc), hBrush)
	hPen, _, _ := splashProcCreatePen.Call(0, 1, pnlColorBtnBG)
	oldP, _, _ := splashProcSelectObj.Call(uintptr(hdc), hPen)
	splashProcRectangle.Call(uintptr(hdc), uintptr(r.Left), uintptr(r.Top), uintptr(r.Right), uintptr(r.Bottom))
	splashProcSelectObj.Call(uintptr(hdc), oldB)
	splashProcSelectObj.Call(uintptr(hdc), oldP)
	splashProcDeleteObj.Call(hBrush)
	splashProcDeleteObj.Call(hPen)

	w := r.Right - r.Left
	h := r.Bottom - r.Top
	panelDrawTextEx(hdc, text, r.Left, r.Top, w, h, int32(pnlColorBtnText), 12*d/96, true)
}
