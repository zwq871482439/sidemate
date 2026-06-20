//go:build windows

package main

import (
	"fmt"
	"log"
	"math"
	"os"
	"syscall"
	"time"
	"unsafe"
)

// ===== Splash 窗口 — 设计参数（逻辑像素 96dpi 基准） =====

const (
	// 基准尺寸（96 DPI 下的逻辑像素）
	baseW          = 440
	baseH          = 560
	baseTitleH     = 42
	baseCornerR    = 14
	baseLogoSz     = 72
	baseLogoBox    = 84
	baseStepStartY = 290
	baseStepRowH   = 46
	baseDotR       = 12
	baseProgressH  = 5

	// 窗口样式
	splashWS_POPUP       uint32 = 0x80000000
	splashWS_EX_TOOLWIN  uint32 = 0x00000080
	splashWS_EX_TOPMOST  uint32 = 0x00000008

	// 消息 (tray 中未定义的)
	splashWM_PAINT      = 0x000F
	splashWM_TIMER      = 0x0113
	splashWM_ERASEBKGND = 0x0014
	splashWM_LBUTTONUP  = 0x0202

	// GDI
	splashTRANSPARENT   = 1
	splashDT_CENTER     = 0x00000001
	splashDT_VCENTER    = 0x00000004
	splashDT_SINGLELINE = 0x00000020

	// 颜色 COLORREF (BGR)
	splashColorTitleBG  = 0x004c3420 // #20344c 深蓝灰
	splashColorBodyBG   = 0x00faf9f7 // #f7f9fa 极浅灰白
	splashColorWhite    = 0x00ffffff
	splashColorDone     = 0x0088b30e // #0eb388 翡翠绿
	splashColorRun      = 0x00a87832 // #3278a8 海蓝
	splashColorWait     = 0x00c8ccc8 // #c8ccc8 浅灰
	splashColorRetry    = 0x000677d9 // #d97706 琥珀
	splashColorFail     = 0x002c2cb9 // #b91c1c 警示红
	splashColorProgBG   = 0x00ececec // #ececec
	splashColorSubtitle = 0x00605848 // #485860 深灰蓝
	splashColorPillBG   = 0x00c0883a // #3a88c0 钴蓝
	splashColorLogoBox  = 0x00d8eef0 // #f0eed8 柔和米色
	splashColorSub      = 0x00605848 // #485860 深灰蓝（副文字）

	// 定时器
	splashTimerID = 100
)

// dpiScale — 运行时 DPI 缩放后的实际像素值
var (
	dpi           int32
	sW, sH        int32 // 窗口宽高
	sTitleH       int32
	sCornerR      int32
	sLogoSz       int32
	sLogoBox      int32
	sStepStartY   int32
	sStepRowH     int32
	sDotR         int32
	sProgressY    int32
	sErrCardX     int32
	sErrCardY     int32
	sErrCardW     int32
	sErrCardH     int32
	sBtnY         int32
)

func splashInitDPI() {
	// 获取 DPI（SM_CXSCREEN 取屏幕宽，结合 EnumDisplaySettings 取 DPI 更准但复杂，
	// 用 GetDeviceCaps(LOGPIXELSY) 最简洁）
	hDC, _, _ := user32.NewProc("GetDC").Call(0)
	if hDC != 0 {
		gdc := splashGdi32.NewProc("GetDeviceCaps")
		dpiVal, _, _ := gdc.Call(hDC, 90) // LOGPIXELSY = 90
		user32.NewProc("ReleaseDC").Call(0, hDC)
		if dpiVal > 0 {
			dpi = int32(dpiVal)
		}
	}
	if dpi == 0 {
		dpi = 96 // fallback
	}

	scale := func(v int32) int32 { return v * dpi / 96 }

	sW = scale(baseW)
	sH = scale(baseH)
	sTitleH = scale(baseTitleH)
	sCornerR = scale(baseCornerR)
	sLogoSz = scale(baseLogoSz)
	sLogoBox = scale(baseLogoBox)
	sStepStartY = scale(baseStepStartY)
	sStepRowH = scale(baseStepRowH)
	sDotR = scale(baseDotR)
	sProgressY = sH - scale(baseProgressH)
	sErrCardW = scale(380)
	sErrCardX = (sW - sErrCardW) / 2
	sErrCardH = scale(70)
	sErrCardY = sH - scale(100)
	sBtnY = sErrCardY + sErrCardH - scale(40)
}

// ===== 步骤状态 =====

type StepStatus int

const (
	StepWaiting StepStatus = iota
	StepRunning
	StepRetry
	StepDone
	StepFailed
)

type SplashStep struct {
	Status   StepStatus
	Text     string
	RetryN   int
	Duration time.Duration
}

// ===== SplashState =====

type SplashState struct {
	hWnd    syscall.Handle
	hIcon   syscall.Handle
	steps   [3]SplashStep // 保留数组兼容旧 API（不再用于显示，但仍用于错误状态等）
	version string
	logPath string
	failed  bool
	failMsg string
	progress       int
	targetProgress int

	// Patch5 启动重构：单行动态步骤
	currentStepText    string // 当前步骤的文案（如"检查环境依赖..."）
	currentStepStatus  StepStatus // 当前步骤的状态
	currentStepName    string // 当前步骤名称（如"环境"），用于日志
	stageStartTime     time.Time // 当前阶段开始时间（用于强制延迟）
	// Patch5 Splash 方案 B：环形进度 + 流水指示器
	totalStages        int    // 总阶段数（动态计算，去掉未装的扩展）
	currentStageIdx    int    // 当前阶段索引（0-based）
	stageSubText       string // 阶段子状态（如"正在加载 bge-m3"）

	closeBtnRect   splashRect
	openLogBtnRect splashRect
	forceExitRect  splashRect
}

type splashRect struct {
	Left, Top, Right, Bottom int32
}

// ===== Win32 lazy procs (splash 专用) =====

var (
	splashGdi32 = syscall.NewLazyDLL("gdi32.dll")

	splashProcShowWindow  = user32.NewProc("ShowWindow")
	splashProcUpdateWindow = user32.NewProc("UpdateWindow")
	splashProcInvalidateRect = user32.NewProc("InvalidateRect")
	splashProcBeginPaint  = user32.NewProc("BeginPaint")
	splashProcEndPaint    = user32.NewProc("EndPaint")
	splashProcDrawTextW   = user32.NewProc("DrawTextW")
	splashProcSetBkMode   = splashGdi32.NewProc("SetBkMode")   // GDI32, not USER32!
	splashProcSetTextColor = splashGdi32.NewProc("SetTextColor") // GDI32, not USER32!
	splashProcSetTimer    = user32.NewProc("SetTimer")
	splashProcKillTimer   = user32.NewProc("KillTimer")
	splashProcGetSysMetrics = user32.NewProc("GetSystemMetrics")
	splashProcCreateRgn   = splashGdi32.NewProc("CreateRoundRectRgn") // GDI32, not USER32!
	splashProcSetWndRgn   = user32.NewProc("SetWindowRgn")
	splashProcDrawIconEx  = user32.NewProc("DrawIconEx")
	splashProcPeekMsgW    = user32.NewProc("PeekMessageW")

	splashProcShellExecW  = shell32.NewProc("ShellExecuteW")

	splashProcFillRect      = user32.NewProc("FillRect")
	splashProcCreateBrush   = splashGdi32.NewProc("CreateSolidBrush")
	splashProcDeleteObj     = splashGdi32.NewProc("DeleteObject")
	splashProcEllipse       = splashGdi32.NewProc("Ellipse")
	splashProcMoveToEx      = splashGdi32.NewProc("MoveToEx")
	splashProcLineTo        = splashGdi32.NewProc("LineTo")
	splashProcSelectObj     = splashGdi32.NewProc("SelectObject")
	splashProcCreatePen     = splashGdi32.NewProc("CreatePen")
	splashProcRectangle     = splashGdi32.NewProc("Rectangle")
)

// ===== PAINTSTRUCT =====

type splashPAINTSTRUCT struct {
	Hdc         syscall.Handle
	FErase      int32
	RcPaint     splashRect
	FRestore    int32
	IncUpdate   int32
	RgbReserved [32]byte
}

// ===== 全局状态 =====

var (
	splashStateList  []*SplashState
	splashWndProcPtr uintptr
)

func splashFindState(hWnd syscall.Handle) *SplashState {
	for _, ss := range splashStateList {
		if ss.hWnd == hWnd {
			return ss
		}
	}
	return nil
}

// ===== WndProc =====

func splashWndProc(hWnd syscall.Handle, msg uint32, wParam, lParam uintptr) uintptr {
	ss := splashFindState(hWnd)
	if ss == nil {
		ret, _, _ := procDefWindowProcW.Call(uintptr(hWnd), uintptr(msg), wParam, lParam)
		return ret
	}

	switch msg {
	case splashWM_PAINT:
		var ps splashPAINTSTRUCT
		hdc, _, _ := splashProcBeginPaint.Call(uintptr(hWnd), uintptr(unsafe.Pointer(&ps)))
		if hdc == 0 {
			return 0
		}
		splashPaint(syscall.Handle(hdc), ss)
		splashProcEndPaint.Call(uintptr(hWnd), uintptr(unsafe.Pointer(&ps)))
		return 1

	case splashWM_ERASEBKGND:
		return 1

	case splashWM_TIMER:
		// 平滑进度动画：每 100ms 向 targetProgress 逼近
		ss := splashFindState(hWnd)
		if ss != nil && ss.progress < ss.targetProgress {
			gap := ss.targetProgress - ss.progress
			// 大跳跃（>15）立即跟上，小步缓慢逼近
			var step int
			if gap > 30 {
				step = gap // 立即到位
			} else if gap > 15 {
				step = gap * 2 / 3
			} else {
				step = gap / 3
				if step < 2 {
					step = 2
				}
			}
			ss.progress += step
			if ss.progress > ss.targetProgress {
				ss.progress = ss.targetProgress
			}
		}
		splashProcInvalidateRect.Call(uintptr(hWnd), 0, 0)
		return 0

	case splashWM_LBUTTONUP:
		// lParam 低 16 位 = x, 高 16 位 = y
		mx := int32(uint16(lParam))
		my := int32(uint16(lParam >> 16))
		if splashPtInRect(mx, my, ss.closeBtnRect) {
			log.Println("[Splash] 用户点击关闭")
			terminateJob()
			splashProcKillTimer.Call(uintptr(ss.hWnd), splashTimerID, 0, 0)
			procDestroyWindow.Call(uintptr(ss.hWnd))
			os.Exit(0)
			return 0
		}
		if ss.failed {
			if splashPtInRect(mx, my, ss.openLogBtnRect) {
				log.Println("[Splash] 打开日志文件")
				splashOpenLog(ss.logPath)
				return 0
			}
			if splashPtInRect(mx, my, ss.forceExitRect) {
				log.Println("[Splash] 强制退出")
				terminateJob()
				splashProcKillTimer.Call(uintptr(ss.hWnd), splashTimerID, 0, 0)
				procDestroyWindow.Call(uintptr(ss.hWnd))
				os.Exit(1)
				return 0
			}
		}
		return 0

	case WM_DESTROY:
		splashProcKillTimer.Call(uintptr(hWnd), splashTimerID, 0, 0)
		return 0
	}

	ret, _, _ := procDefWindowProcW.Call(uintptr(hWnd), uintptr(msg), wParam, lParam)
	return ret
}

// ===== CreateSplashWindow =====

func CreateSplashWindow(appDir string, version string, logPath string) *SplashState {
	// DPI 感知初始化
	splashInitDPI()

	k32 := syscall.NewLazyDLL("kernel32.dll")
	getModuleHandle := k32.NewProc("GetModuleHandleW")
	hInst, _, _ := getModuleHandle.Call(0)

	className, _ := syscall.UTF16PtrFromString("SidemateSplash")

	// 先注销旧窗口类
	procUnregisterClassW.Call(uintptr(unsafe.Pointer(className)), hInst)

	hCursor, _, _ := procLoadCursorW.Call(0, IDC_ARROW)

	// 防止 GC
	splashWndProcPtr = syscall.NewCallback(func(hWnd syscall.Handle, msg uint32, wParam, lParam uintptr) uintptr {
		return splashWndProc(hWnd, msg, wParam, lParam)
	})

	wc := WNDCLASSEXW{
		CbSize:        uint32(unsafe.Sizeof(WNDCLASSEXW{})),
		LpfnWndProc:   splashWndProcPtr,
		HInstance:     syscall.Handle(hInst),
		HCursor:       syscall.Handle(hCursor),
		LpszClassName: className,
	}
	ret, _, _ := procRegisterClassExW.Call(uintptr(unsafe.Pointer(&wc)))
	if ret == 0 {
		log.Println("[Splash] RegisterClassExW 失败")
		return nil
	}

	// 屏幕居中
	cx, _, _ := splashProcGetSysMetrics.Call(0) // SM_CXSCREEN
	cy, _, _ := splashProcGetSysMetrics.Call(1) // SM_CYSCREEN
	x := (int32(cx) - sW) / 2
	y := (int32(cy) - sH) / 2

	windowName, _ := syscall.UTF16PtrFromString("Sidemate Splash")
	exStyle := uintptr(splashWS_EX_TOOLWIN | splashWS_EX_TOPMOST)
	dwStyle := uintptr(splashWS_POPUP)
	log.Printf("[Splash] DPI=%d, Window=%dx%d, pos=(%d,%d)", dpi, sW, sH, x, y)
	hWnd, _, lastErr := procCreateWindowExW.Call(
		exStyle,
		uintptr(unsafe.Pointer(className)),
		uintptr(unsafe.Pointer(windowName)),
		dwStyle,
		uintptr(x), uintptr(y),
		uintptr(sW), uintptr(sH),
		0, 0, hInst, 0,
	)
	log.Printf("[Splash] CreateWindowExW returned hWnd=0x%X, lastErr=%v", hWnd, lastErr)
	if hWnd == 0 {
		log.Printf("[Splash] CreateWindowExW 失败, lastErr=%v", lastErr)
		return nil
	}

	// 圆角
	hRgn, _, _ := splashProcCreateRgn.Call(0, 0, uintptr(sW), uintptr(sH), uintptr(sCornerR*2), uintptr(sCornerR*2))
	if hRgn != 0 {
		splashProcSetWndRgn.Call(hWnd, hRgn, 1)
	}

	// 加载 logo.ico（用 DPI 缩放后尺寸）
	var hIcon syscall.Handle
	icoPath := appDir + "\\logo.ico"
	icoPtr, _ := syscall.UTF16PtrFromString(icoPath)
	IMAGE_ICON := 1
	LR_LOADFROMFILE := 0x00000010
	hLoaded, _, _ := user32.NewProc("LoadImageW").Call(
		0,
		uintptr(unsafe.Pointer(icoPtr)),
		uintptr(IMAGE_ICON),
		uintptr(sLogoSz), uintptr(sLogoSz),
		uintptr(LR_LOADFROMFILE),
	)
	if hLoaded != 0 {
		hIcon = syscall.Handle(hLoaded)
		log.Println("[Splash] logo.ico 已加载")
	} else {
		log.Println("[Splash] logo.ico 加载失败")
	}

	sBtnH := 30 * dpi / 96
	ss := &SplashState{
		hWnd:    syscall.Handle(hWnd),
		hIcon:   hIcon,
		version: version,
		logPath: logPath,
		steps: [3]SplashStep{
			{Status: StepWaiting, Text: "等待中"},
			{Status: StepWaiting, Text: "等待中"},
			{Status: StepWaiting, Text: "等待中"},
		},
		closeBtnRect: splashRect{Left: sW - 42*dpi/96, Top: 0, Right: sW, Bottom: sTitleH},
		openLogBtnRect: splashRect{
			Left:   sErrCardX + 20*dpi/96,
			Top:    sBtnY,
			Right:  sErrCardX + 20*dpi/96 + 140*dpi/96,
			Bottom: sBtnY + int32(sBtnH),
		},
		forceExitRect: splashRect{
			Left:   sErrCardX + sErrCardW - 140*dpi/96 - 20*dpi/96,
			Top:    sBtnY,
			Right:  sErrCardX + sErrCardW - 20*dpi/96,
			Bottom: sBtnY + int32(sBtnH),
		},
	}

	splashStateList = append(splashStateList, ss)

	splashProcSetTimer.Call(hWnd, splashTimerID, 100, 0)
	log.Println("[Splash] Timer 已设置，准备 ShowWindow")
	splashProcShowWindow.Call(hWnd, 1) // SW_SHOWNORMAL
	log.Println("[Splash] ShowWindow 已调用")
	splashProcUpdateWindow.Call(hWnd)
	log.Println("[Splash] UpdateWindow 已调用")

	log.Println("[Splash] 启动画面已显示")
	return ss
}

// ===== 自绘主函数 =====

func splashPaint(hdc syscall.Handle, ss *SplashState) {
	// 主体背景
	splashFillRect(hdc, 0, 0, sW, sH, splashColorBodyBG)

	// 标题栏
	splashFillRect(hdc, 0, 0, sW, sTitleH, splashColorTitleBG)

	// 标题文字（DPI 缩放字号）
	titleFontSize := 18 * dpi / 96
	splashDrawTextEx(hdc, "桌伴 · Sidemate", titleFontSize, 16*dpi/96, 0, sW-42*dpi/96, sTitleH, splashColorWhite, false)

	// 关闭按钮
	closeSize := 16 * dpi / 96
	splashDrawTextEx(hdc, "✕", closeSize, sW-42*dpi/96, 6*dpi/96, 36*dpi/96, sTitleH-6*dpi/96, splashColorWhite, true)

	// --- Logo 区域 ---
	logoX := (sW - sLogoBox) / 2
	logoY := sTitleH + 28*dpi/96

	// 柔和背景框
	hBoxBrush, _, _ := splashProcCreateBrush.Call(splashColorLogoBox)
	hOldB, _, _ := splashProcSelectObj.Call(uintptr(hdc), hBoxBrush)
	hBoxPen, _, _ := splashProcCreatePen.Call(0, 1, splashColorLogoBox)
	hOldP, _, _ := splashProcSelectObj.Call(uintptr(hdc), hBoxPen)
	splashProcRectangle.Call(uintptr(hdc), uintptr(logoX), uintptr(logoY),
		uintptr(logoX+sLogoBox), uintptr(logoY+sLogoBox))
	splashProcSelectObj.Call(uintptr(hdc), hOldB)
	splashProcSelectObj.Call(uintptr(hdc), hOldP)
	splashProcDeleteObj.Call(hBoxBrush)
	splashProcDeleteObj.Call(hBoxPen)

	// 图标
	if ss.hIcon != 0 {
		iconX := logoX + (sLogoBox-sLogoSz)/2
		iconY := logoY + (sLogoBox-sLogoSz)/2
		splashProcDrawIconEx.Call(
			uintptr(hdc), uintptr(iconX), uintptr(iconY),
			uintptr(ss.hIcon),
			uintptr(sLogoSz), uintptr(sLogoSz),
			0, 0, 3, // DI_NORMAL
		)
	}

	// --- 副标题 ---
	verY := logoY + sLogoBox + 14*dpi/96
	subFontSize := 20 * dpi / 96
	splashDrawTextEx(hdc, "桌伴 · Sidemate", subFontSize, 0, verY, sW, subFontSize+8*dpi/96, splashColorTitleBG, true)

	// 版本标签（纯文字，无底色）
	pillY := verY + subFontSize + 8*dpi/96
	pillText := ss.version
	pillFontSize := 12 * dpi / 96
	splashDrawTextEx(hdc, pillText, pillFontSize, 0, pillY, sW, pillFontSize+8*dpi/96, splashColorSubtitle, true)

	// --- 分隔线 ---
	sepY := pillY + pillFontSize + 12*dpi/96
	sepPen, _, _ := splashProcCreatePen.Call(0, 1, splashColorWait)
	hOldSepPen, _, _ := splashProcSelectObj.Call(uintptr(hdc), sepPen)
	splashProcMoveToEx.Call(uintptr(hdc), uintptr(40*dpi/96), uintptr(sepY), 0)
	splashProcLineTo.Call(uintptr(hdc), uintptr(sW-40*dpi/96), uintptr(sepY))
	splashProcSelectObj.Call(uintptr(hdc), hOldSepPen)
	splashProcDeleteObj.Call(sepPen)

	// --- Patch5 Splash 方案 B：环形进度 + 阶段名 + 子状态 + 流水指示器 ---
	// 替换原来的单行动态步骤 + 线性进度条
	splashDrawRingProgress(hdc, ss)

	// --- 错误卡片 ---
	if ss.failed {
		splashDrawErrorCard(hdc, ss)
	}
}

func splashDrawStepRow(hdc syscall.Handle, ss *SplashState, idx int, stepLabel string) {
	step := ss.steps[idx]
	rowY := sStepStartY + int32(idx)*sStepRowH
	dotCx := int32(52 * dpi / 96)
	dotCy := rowY + 14*dpi/96

	var dotColor uintptr
	var statusText string
	switch step.Status {
	case StepWaiting:
		dotColor = splashColorWait
		statusText = "等待中"
	case StepRunning:
		dotColor = splashColorRun
		statusText = "正在启动..."
		if step.Text != "" {
			statusText = step.Text
		}
	case StepRetry:
		dotColor = splashColorRetry
		statusText = fmt.Sprintf("自修复中 · 第 %d/3 次", step.RetryN)
		if step.Text != "" {
			statusText = step.Text
		}
	case StepDone:
		dotColor = splashColorDone
		if step.Duration > 0 {
			statusText = fmt.Sprintf("已就绪 · %.1fs", step.Duration.Seconds())
		} else {
			statusText = "已就绪"
		}
		if step.Text != "" {
			statusText = step.Text
		}
	case StepFailed:
		dotColor = splashColorFail
		statusText = step.Text
		if statusText == "" {
			statusText = "启动失败"
		}
	}

	// 画圆形指示灯
	hBrush, _, _ := splashProcCreateBrush.Call(dotColor)
	hOldB, _, _ := splashProcSelectObj.Call(uintptr(hdc), hBrush)
	hPen, _, _ := splashProcCreatePen.Call(0, 1, dotColor)
	hOldP, _, _ := splashProcSelectObj.Call(uintptr(hdc), hPen)

	if step.Status == StepWaiting {
		// 空心圆：背景色填充 + 彩色边框
		splashProcDeleteObj.Call(hBrush)
		hBrush, _, _ = splashProcCreateBrush.Call(splashColorBodyBG)
		splashProcSelectObj.Call(uintptr(hdc), hBrush)
		splashProcDeleteObj.Call(hPen)
		hPen, _, _ = splashProcCreatePen.Call(0, 2, dotColor)
		splashProcSelectObj.Call(uintptr(hdc), hPen)
	}

	splashProcEllipse.Call(
		uintptr(hdc),
		uintptr(dotCx-sDotR), uintptr(dotCy-sDotR),
		uintptr(dotCx+sDotR), uintptr(dotCy+sDotR),
	)

	// 勾号（已完成）
	if step.Status == StepDone {
		hWhitePen, _, _ := splashProcCreatePen.Call(0, 2, splashColorWhite)
		splashProcSelectObj.Call(uintptr(hdc), hWhitePen)
		ckScale := dpi / 96
		splashProcMoveToEx.Call(uintptr(hdc), uintptr(dotCx-5*ckScale), uintptr(dotCy), 0)
		splashProcLineTo.Call(uintptr(hdc), uintptr(dotCx-1*ckScale), uintptr(dotCy+5*ckScale))
		splashProcMoveToEx.Call(uintptr(hdc), uintptr(dotCx-1*ckScale), uintptr(dotCy+5*ckScale), 0)
		splashProcLineTo.Call(uintptr(hdc), uintptr(dotCx+6*ckScale), uintptr(dotCy-5*ckScale))
		splashProcDeleteObj.Call(hWhitePen)
	}

	splashProcSelectObj.Call(uintptr(hdc), hOldB)
	splashProcSelectObj.Call(uintptr(hdc), hOldP)
	splashProcDeleteObj.Call(hBrush)
	splashProcDeleteObj.Call(hPen)

	// 步骤名
	labelFontSize := 14 * dpi / 96
	splashDrawTextEx(hdc, stepLabel, labelFontSize, 76*dpi/96, rowY-2*dpi/96, 200*dpi/96, labelFontSize+6*dpi/96, splashColorTitleBG, false)
	// 状态文字
	statusFontSize := 11 * dpi / 96
	splashDrawTextEx(hdc, statusText, statusFontSize, 76*dpi/96, rowY+16*dpi/96, 300*dpi/96, statusFontSize+4*dpi/96, dotColor, false)
}

// splashDrawRingProgress 画方案 B：环形进度 + 阶段名 + 子状态 + 流水指示器
// 布局（在 SplashState 中间区域）：
//   ┌──────────────────────────────┐
//   │      ┌──────┐                │
//   │      │ 60%  │  加载知识库模型 │   ← 大圆环(全局进度) + 阶段名
//   │      │ ring │  正在加载 bge-m3│   ← 子状态
//   │      └──────┘                │
//   │   ●●●○○                       │   ← 流水指示器（5个小条）
//   └──────────────────────────────┘
func splashDrawRingProgress(hdc syscall.Handle, ss *SplashState) {
	sc := func(v int32) int32 { return v * dpi / 96 }

	// 区域参数（Patch5 调整：圆环放上方居中，跟阶段名上下排列）
	centerX := sW / 2
	ringR := sc(40) // 环形半径（略缩小避免溢出）
	ringThickness := sc(7)
	ringCY := sStepStartY + sc(10) // 圆环垂直中心：靠近 Logo 下方

	// === 1. 画环形进度（背景环 + 前景环） ===
	// 用裁剪矩形的方式画弧（GDI 不直接支持 stroke arc，用两个椭圆做"环"）
	// 背景：完整浅色圆环
	bgR := ringR
	bgBrush, _, _ := splashProcCreateBrush.Call(splashColorBodyBG)
	bgPen, _, _ := splashProcCreatePen.Call(0, uintptr(ringThickness), splashColorProgBG)
	oldBgB, _, _ := splashProcSelectObj.Call(uintptr(hdc), bgBrush)
	oldBgP, _, _ := splashProcSelectObj.Call(uintptr(hdc), bgPen)
	splashProcEllipse.Call(uintptr(hdc),
		uintptr(centerX-bgR), uintptr(ringCY-bgR),
		uintptr(centerX+bgR), uintptr(ringCY+bgR))
	splashProcSelectObj.Call(uintptr(hdc), oldBgB)
	splashProcSelectObj.Call(uintptr(hdc), oldBgP)
	splashProcDeleteObj.Call(bgBrush)
	splashProcDeleteObj.Call(bgPen)

	// 前景：按 progress 画扇形覆盖（从顶部顺时针）
	// 简化实现：用 Pie 函数画扇形，再用背景色挖洞模拟环
	progress := ss.progress
	if progress < 0 {
		progress = 0
	}
	if progress > 100 {
		progress = 100
	}
	if progress > 0 {
		// GDI Pie：画饼图扇形（从 12 点钟方向顺时针 progress%）
		// 角度换算：0% = -90°（12点钟），100% = 270°（回到 12 点钟）
		startAngle := -90.0
		endAngle := -90.0 + 360.0*float64(progress)/100.0
		// 转换为 GDI Pie 需要的"起点和终点的 xy 坐标"（不是角度）
		startRad := startAngle * 3.14159265 / 180.0
		endRad := endAngle * 3.14159265 / 180.0
		startX := float64(centerX) + float64(bgR)*math.Cos(startRad)
		startY := float64(ringCY) + float64(bgR)*math.Sin(startRad)
		endX := float64(centerX) + float64(bgR)*math.Cos(endRad)
		endY := float64(ringCY) + float64(bgR)*math.Sin(endRad)

		fgBrush, _, _ := splashProcCreateBrush.Call(splashColorRun)
		fgPen, _, _ := splashProcCreatePen.Call(0, 1, splashColorRun)
		oldFgB, _, _ := splashProcSelectObj.Call(uintptr(hdc), fgBrush)
		oldFgP, _, _ := splashProcSelectObj.Call(uintptr(hdc), fgPen)
		splashPie.Call(uintptr(hdc),
			uintptr(centerX-bgR), uintptr(ringCY-bgR),
			uintptr(centerX+bgR), uintptr(ringCY+bgR),
			intptr(startX), intptr(startY),
			intptr(endX), intptr(endY))
		splashProcSelectObj.Call(uintptr(hdc), oldFgB)
		splashProcSelectObj.Call(uintptr(hdc), oldFgP)
		splashProcDeleteObj.Call(fgBrush)
		splashProcDeleteObj.Call(fgPen)

		// 中间挖洞（用背景色画小圆，把扇形变成环）
		innerR := bgR - ringThickness
		innerBrush, _, _ := splashProcCreateBrush.Call(splashColorBodyBG)
		innerPen, _, _ := splashProcCreatePen.Call(0, 1, splashColorBodyBG)
		oldIB, _, _ := splashProcSelectObj.Call(uintptr(hdc), innerBrush)
		oldIP, _, _ := splashProcSelectObj.Call(uintptr(hdc), innerPen)
		splashProcEllipse.Call(uintptr(hdc),
			uintptr(centerX-innerR), uintptr(ringCY-innerR),
			uintptr(centerX+innerR), uintptr(ringCY+innerR))
		splashProcSelectObj.Call(uintptr(hdc), oldIB)
		splashProcSelectObj.Call(uintptr(hdc), oldIP)
		splashProcDeleteObj.Call(innerBrush)
		splashProcDeleteObj.Call(innerPen)
	}

	// 圆环中心：百分比文字
	pctText := fmt.Sprintf("%d%%", progress)
	pctFontSize := 20 * dpi / 96
	splashDrawTextEx(hdc, pctText, pctFontSize,
		centerX-sc(40), ringCY-sc(12), sc(80), sc(24),
		splashColorRun, true)

	// === 2. 阶段名（圆环下方居中，独立一行）===
	text := ss.currentStepText
	if text == "" {
		text = "准备中..."
	}
	// Patch5：Done 状态不显示对勾符号，直接显示文案
	stageFontSize := 16 * dpi / 96
	stageText := text
	// 居中显示，宽度撑满
	splashDrawTextEx(hdc, stageText, stageFontSize,
		sc(20), ringCY+ringR+sc(14), sW-sc(40), stageFontSize+sc(6),
		splashColorTitleBG, true)

	// === 3. 子状态文字（阶段名下方居中）===
	// Patch5：Done 状态下不显示子状态
	if ss.stageSubText != "" && ss.currentStepStatus != StepDone {
		subFontSize := 11 * dpi / 96
		var subColor uintptr = splashColorSubtitle
		if ss.currentStepStatus == StepRunning {
			subColor = splashColorRun
		}
		splashDrawTextEx(hdc, ss.stageSubText, subFontSize,
			sc(20), ringCY+ringR+sc(14)+stageFontSize+sc(6), sW-sc(40), subFontSize+sc(4),
			subColor, true)
	}

	// === 4. 流水指示器（5 个小条，水平居中，底部） ===
	totalStages := ss.totalStages
	if totalStages <= 0 {
		totalStages = 5 // 默认 5 个阶段（防止除零）
	}
	currentIdx := ss.currentStageIdx
	indicatorY := sProgressY - sc(20)
	indicatorH := sc(6)
	indicatorW := sc(80)
	indicatorGap := sc(10)
	totalW := int32(totalStages)*indicatorW + int32(totalStages-1)*indicatorGap
	indicatorStartX := (sW - totalW) / 2

	for i := 0; i < totalStages; i++ {
		x := indicatorStartX + int32(i)*(indicatorW+indicatorGap)
		var segColor uintptr
		if i < currentIdx {
			segColor = splashColorDone // 已完成 = 绿
		} else if i == currentIdx {
			if ss.currentStepStatus == StepDone {
				segColor = splashColorDone
			} else {
				segColor = splashColorRun // 当前 = 蓝
			}
		} else {
			segColor = splashColorProgBG // 未开始 = 浅灰
		}
		splashFillRoundRect(hdc, x, indicatorY, x+indicatorW, indicatorY+indicatorH, sc(3), segColor)
	}
}

// splashPie 是 Pie GDI 函数的封装（避免反复 syscall）
var splashPie = splashGdi32.NewProc("Pie")

// intptr 把 float64 转 uintptr（用于 GDI Pie 坐标）
func intptr(v float64) uintptr {
	return uintptr(int32(v))
}

func splashDrawErrorCard(hdc syscall.Handle, ss *SplashState) {
	// 卡片背景
	hBrush, _, _ := splashProcCreateBrush.Call(0x00f0f0f0) // 浅灰
	hOldB, _, _ := splashProcSelectObj.Call(uintptr(hdc), hBrush)
	hPen, _, _ := splashProcCreatePen.Call(0, 1, 0x00f0f0f0)
	hOldP, _, _ := splashProcSelectObj.Call(uintptr(hdc), hPen)
	splashProcRectangle.Call(
		uintptr(hdc),
		uintptr(sErrCardX), uintptr(sErrCardY),
		uintptr(sErrCardX+sErrCardW), uintptr(sErrCardY+sErrCardH),
	)
	splashProcSelectObj.Call(uintptr(hdc), hOldB)
	splashProcSelectObj.Call(uintptr(hdc), hOldP)
	splashProcDeleteObj.Call(hBrush)
	splashProcDeleteObj.Call(hPen)

	// 错误文字
	errFontSize := 13 * dpi / 96
	splashDrawTextEx(hdc, ss.failMsg, errFontSize, sErrCardX, sErrCardY+6*dpi/96, sErrCardW, errFontSize+6*dpi/96, splashColorFail, true)

	// "打开日志" 按钮
	splashDrawButton(hdc, "打开日志", ss.openLogBtnRect, splashColorRun, splashColorWhite)
	// "强制退出" 按钮
	splashDrawButton(hdc, "强制退出", ss.forceExitRect, splashColorFail, splashColorWhite)
}

func splashDrawButton(hdc syscall.Handle, text string, r splashRect, bgColor, textColor uintptr) {
	hBrush, _, _ := splashProcCreateBrush.Call(bgColor)
	hOldB, _, _ := splashProcSelectObj.Call(uintptr(hdc), hBrush)
	hPen, _, _ := splashProcCreatePen.Call(0, 1, bgColor)
	hOldP, _, _ := splashProcSelectObj.Call(uintptr(hdc), hPen)
	splashProcRectangle.Call(uintptr(hdc), uintptr(r.Left), uintptr(r.Top), uintptr(r.Right), uintptr(r.Bottom))
	splashProcSelectObj.Call(uintptr(hdc), hOldB)
	splashProcSelectObj.Call(uintptr(hdc), hOldP)
	splashProcDeleteObj.Call(hBrush)
	splashProcDeleteObj.Call(hPen)
	btnFontSize := 12 * dpi / 96
	splashDrawTextEx(hdc, text, btnFontSize, r.Left, r.Top, r.Right-r.Left, r.Bottom-r.Top, textColor, true)
}

// ===== 辅助绘制函数 =====

func splashFillRect(hdc syscall.Handle, x1, y1, x2, y2 int32, color uintptr) {
	var rc splashRect
	rc.Left = x1
	rc.Top = y1
	rc.Right = x2
	rc.Bottom = y2
	hBrush, _, _ := splashProcCreateBrush.Call(color)
	splashProcFillRect.Call(uintptr(hdc), uintptr(unsafe.Pointer(&rc)), hBrush)
	splashProcDeleteObj.Call(hBrush)
}

// splashFillRoundRect — 绘制填充圆角矩形
func splashFillRoundRect(hdc syscall.Handle, x1, y1, x2, y2, r int32, color uintptr) {
	hBrush, _, _ := splashProcCreateBrush.Call(color)
	hOldB, _, _ := splashProcSelectObj.Call(uintptr(hdc), hBrush)
	hPen, _, _ := splashProcCreatePen.Call(0, 1, color)
	hOldP, _, _ := splashProcSelectObj.Call(uintptr(hdc), hPen)
	// RoundRect 的椭圆尺寸 = 2*r
	splashGdi32.NewProc("RoundRect").Call(
		uintptr(hdc),
		uintptr(x1), uintptr(y1), uintptr(x2), uintptr(y2),
		uintptr(r*2), uintptr(r*2),
	)
	splashProcSelectObj.Call(uintptr(hdc), hOldB)
	splashProcSelectObj.Call(uintptr(hdc), hOldP)
	splashProcDeleteObj.Call(hBrush)
	splashProcDeleteObj.Call(hPen)
}

// splashDrawTextEx — 绘制文字（指定字号，DPI 缩放后）
func splashDrawTextEx(hdc syscall.Handle, text string, fontSize, x, y, w, h int32, color uintptr, center bool) {
	textPtr, _ := syscall.UTF16PtrFromString(text)
	splashProcSetBkMode.Call(uintptr(hdc), splashTRANSPARENT)
	splashProcSetTextColor.Call(uintptr(hdc), color)

	// 创建指定大小的字体
	hFont, _, _ := splashGdi32.NewProc("CreateFontW").Call(
		uintptr(-fontSize), // 高度（负值=字符高度，非单元格高度）
		0,                  // 宽度（0=自动）
		0,                  // 文字倾斜
		0,                  // 基线倾斜
		400,                // FW_NORMAL
		0,                  // 斜体
		0,                  // 下划线
		0,                  // 删除线
		0x86,               // DEFAULT_CHARSET
		0,                  // OUT_DEFAULT_PRECIS
		3,                  // CLEARTYPE_QUALITY
		0,                  // CLIP_DEFAULT_PRECIS
		0x22,               // FF_SWISS + VARIABLE_PITCH
		0,                  // face name = NULL (系统默认)
	)
	if hFont != 0 {
		hOldFont, _, _ := splashProcSelectObj.Call(uintptr(hdc), hFont)
		defer func() {
			splashProcSelectObj.Call(uintptr(hdc), hOldFont)
			splashProcDeleteObj.Call(hFont)
		}()
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
		uintptr(0xFFFFFFFF), // -1
		uintptr(unsafe.Pointer(&rc)),
		flags,
	)
}

func splashPtInRect(x, y int32, r splashRect) bool {
	return x >= r.Left && x <= r.Right && y >= r.Top && y <= r.Bottom
}

// ===== 公共 API =====

// UpdateSplash 更新步骤状态并触发重绘
func UpdateSplash(ss *SplashState, stepIdx int, status StepStatus, text string) {
	if ss == nil {
		return
	}
	ss.steps[stepIdx].Status = status
	if text != "" {
		ss.steps[stepIdx].Text = text
	}
	// 更新目标进度（定时器会渐进逼近）
	// Running/Retry 的进度由等待循环中的渐进逻辑控制，这里只设最终状态
	switch stepIdx {
	case 0:
		switch status {
		case StepDone:
			ss.targetProgress = 30 // Ollama 完成
		case StepFailed:
			ss.targetProgress = 30
		}
	case 1:
		switch status {
		case StepDone:
			// FastAPI 完成：跳到 95%（留 5% 给浏览器打开的视觉反馈）
			ss.targetProgress = 95
		case StepFailed:
			ss.targetProgress = 95
		}
	case 2:
		if status == StepDone {
			ss.targetProgress = 100
		}
	}
	splashProcInvalidateRect.Call(uintptr(ss.hWnd), 0, 0)
}

// UpdateSplashStage 更新单行动态步骤（Patch5 启动重构）
// 参数：
//   - ss: SplashState
//   - status: 步骤状态（StepRunning/StepDone/StepFailed）
//   - text: 显示文案（如"检查环境依赖..."）
//   - targetProgress: 该步骤的目标进度百分比（0-100）
func UpdateSplashStage(ss *SplashState, status StepStatus, text string, targetProgress int) {
	if ss == nil {
		return
	}
	ss.currentStepStatus = status
	if text != "" {
		ss.currentStepText = text
	}
	if targetProgress > 0 {
		ss.targetProgress = targetProgress
	}
	if status == StepRunning && ss.stageStartTime.IsZero() {
		ss.stageStartTime = time.Now()
	} else if status != StepRunning {
		ss.stageStartTime = time.Time{} // 重置
	}
	splashProcInvalidateRect.Call(uintptr(ss.hWnd), 0, 0)
}

// UpdateSplashStageProgress 仅更新进度（不切换文案/状态）
func UpdateSplashStageProgress(ss *SplashState, progress int) {
	if ss == nil {
		return
	}
	if progress >= 0 && progress <= 100 {
		ss.targetProgress = progress
		splashProcInvalidateRect.Call(uintptr(ss.hWnd), 0, 0)
	}
}

// UpdateSplashStageInfo 更新阶段索引和总数（用于流水指示器）
// totalStages: 总阶段数（动态计算）
// currentIdx: 当前阶段索引（0-based）
func UpdateSplashStageInfo(ss *SplashState, totalStages int, currentIdx int) {
	if ss == nil {
		return
	}
	ss.totalStages = totalStages
	ss.currentStageIdx = currentIdx
	splashProcInvalidateRect.Call(uintptr(ss.hWnd), 0, 0)
}

// UpdateSplashStageSubText 更新阶段子状态文字（如"正在加载 bge-m3"）
func UpdateSplashStageSubText(ss *SplashState, subText string) {
	if ss == nil {
		return
	}
	ss.stageSubText = subText
	splashProcInvalidateRect.Call(uintptr(ss.hWnd), 0, 0)
}

// UpdateSplashDuration 更新步骤耗时
func UpdateSplashDuration(ss *SplashState, stepIdx int, d time.Duration) {
	if ss == nil {
		return
	}
	ss.steps[stepIdx].Duration = d
	splashProcInvalidateRect.Call(uintptr(ss.hWnd), 0, 0)
}

// SetSplashFailed 设置失败状态并显示错误卡片
func SetSplashFailed(ss *SplashState, msg string) {
	if ss == nil {
		return
	}
	ss.failed = true
	ss.failMsg = msg
	splashProcInvalidateRect.Call(uintptr(ss.hWnd), 0, 0)
}

// CloseSplash 关闭并销毁 splash 窗口
func CloseSplash(ss *SplashState) {
	if ss == nil {
		return
	}
	splashProcShowWindow.Call(uintptr(ss.hWnd), 0) // SW_HIDE
	splashProcKillTimer.Call(uintptr(ss.hWnd), splashTimerID, 0, 0)
	procDestroyWindow.Call(uintptr(ss.hWnd))
	// 从列表移除
	for i, s := range splashStateList {
		if s == ss {
			splashStateList = append(splashStateList[:i], splashStateList[i+1:]...)
			break
		}
	}
	if ss.hIcon != 0 {
		splashProcDeleteObj.Call(uintptr(ss.hIcon))
	}
	log.Println("[Splash] 启动画面已关闭")
}

// SplashPumpMessages 非阻塞式消息泵，保持 splash 窗口响应
// 调用方在等待循环中定期调用
func SplashPumpMessages() {
	var msg MSG
	// PeekMessageW PM_REMOVE = 1
	for {
		ret, _, _ := splashProcPeekMsgW.Call(
			uintptr(unsafe.Pointer(&msg)), 0, 0, 0, 1, // PM_REMOVE
		)
		if ret == 0 {
			break
		}
		procTranslateMessage.Call(uintptr(unsafe.Pointer(&msg)))
		procDispatchMessageW.Call(uintptr(unsafe.Pointer(&msg)))
	}
}

// splashOpenLog 用 ShellExecuteW 打开日志文件
func splashOpenLog(path string) {
	pathPtr, _ := syscall.UTF16PtrFromString(path)
	openPtr, _ := syscall.UTF16PtrFromString("open")
	splashProcShellExecW.Call(0, uintptr(unsafe.Pointer(openPtr)), uintptr(unsafe.Pointer(pathPtr)), 0, 0, 1)
}
