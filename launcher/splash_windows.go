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
	// Patch5 方案 B：紧凑布局，高度从 560 缩到 440
	baseW          = 440
	baseH          = 440
	baseTitleH     = 42
	baseCornerR    = 14
	baseLogoSz     = 56    // 从 72 缩到 56
	baseLogoBox    = 68    // 从 84 缩到 68
	baseStepStartY = 230   // 从 290 上移到 230
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
	// Patch5 新方案：4 段环形
	currentSegment int    // 当前段（0-3）
	segmentStates  [4]int // 段状态：0=未到 1=加载中 2=完成
	animTick       int32  // 动画 tick（用于呼吸闪烁）

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
			// Patch5：X 按钮改为"最小化到托盘"（不再杀进程）
			// 原行为 os.Exit(0) 会让用户误以为"关掉窗口=正常"，实际杀掉所有子进程
			log.Println("[Splash] 用户点击最小化，启动继续在后台进行")
			splashProcShowWindow.Call(uintptr(ss.hWnd), 0) // SW_HIDE = 0
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

	// 最小化按钮（Patch5：从 ✕ 改为 —，语义改为"最小化到托盘"）
	closeSize := 16 * dpi / 96
	splashDrawTextEx(hdc, "—", closeSize, sW-42*dpi/96, 6*dpi/96, 36*dpi/96, sTitleH-6*dpi/96, splashColorWhite, true)

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
// splashDrawRingProgress 画 4 段环形（Patch5 新方案）
// 4 段，每段 90°，从顶部开始顺时针：
//   段 0: 0-90°    (右上)
//   段 1: 90-180°  (右下)
//   段 2: 180-270° (左下)
//   段 3: 270-360° (左上)
//
// 颜色规则：
//   已完成段 = 绿色（splashColorDone）
//   加载中段 = 蓝色呼吸闪烁（splashColorRun，alpha 受 animTick 调制）
//   未到段   = 灰色（splashColorProgBG）
//
// 不显示百分比，只在中央显示阶段名
func splashDrawRingProgress(hdc syscall.Handle, ss *SplashState) {
	sc := func(v int32) int32 { return v * dpi / 96 }

	centerX := sW / 2
	ringR := sc(50) // 半径略大（4 段需要更清晰）
	ringThickness := sc(10)
	ringCY := sStepStartY + sc(40)

	// 计算呼吸闪烁 alpha（加载中段）
	// sin 波，周期 1.2 秒，alpha 范围 0.5-1.0
	animPhase := float64(ss.animTick%60) / 60.0 * 2 * math.Pi
	breathAlpha := 0.6 + 0.4*math.Sin(animPhase) // 0.2-1.0

	// 4 段，每段 90°
	for seg := 0; seg < 4; seg++ {
		// 每段起止角度（从 -90° 即 12 点钟方向开始顺时针）
		segStart := -90.0 + float64(seg)*90.0
		segEnd := segStart + 90.0

		state := ss.segmentStates[seg]

		var segColor uintptr
		switch state {
		case 2: // 完成
			segColor = splashColorDone
		case 1: // 加载中（蓝色呼吸）
			// 简化：直接用蓝色，靠 animTick 触发 invalidate 让定时器重绘
			// 颜色亮度由 breathAlpha 调制
			segColor = modulateColor(splashColorRun, breathAlpha)
		default: // 0 未到
			segColor = splashColorProgBG
		}

		// 画这一段的弧（用 Pie 画扇形再挖洞模拟环段）
		drawRingArc(hdc, centerX, ringCY, ringR, ringThickness,
			segStart, segEnd, segColor, splashColorBodyBG)
	}

	// 中央：阶段名（不显示百分比）
	text := ss.currentStepText
	if text == "" {
		text = "准备中"
	}
	stageFontSize := 16 * dpi / 96
	splashDrawTextEx(hdc, text, stageFontSize,
		sc(20), ringCY-sc(10), sW-sc(40), stageFontSize+sc(6),
		splashColorTitleBG, true)
}

// drawRingArc 画环形的一段弧
// startAngle/endAngle 单位度（数学坐标系，-90=12点钟）
// outerColor: 弧的颜色
// holeColor: 中心挖洞的颜色（背景色）
func drawRingArc(hdc syscall.Handle, centerX, centerY, radius, thickness int32,
	startAngle, endAngle float64, outerColor, holeColor uintptr) {

	innerR := radius - thickness

	// Pie 需要圆心矩形容器 + 起止点坐标
	// 整圆 bbox
	left := centerX - radius
	top := centerY - radius
	right := centerX + radius
	bottom := centerY + radius

	// 起止点（外圆上）
	startRad := startAngle * math.Pi / 180.0
	endRad := endAngle * math.Pi / 180.0
	sx := float64(centerX) + float64(radius)*math.Cos(startRad)
	sy := float64(centerY) + float64(radius)*math.Sin(startRad)
	ex := float64(centerX) + float64(radius)*math.Cos(endRad)
	ey := float64(centerY) + float64(radius)*math.Sin(endRad)

	// 画扇形
	brush, _, _ := splashProcCreateBrush.Call(outerColor)
	pen, _, _ := splashProcCreatePen.Call(0, 1, outerColor)
	oldB, _, _ := splashProcSelectObj.Call(uintptr(hdc), brush)
	oldP, _, _ := splashProcSelectObj.Call(uintptr(hdc), pen)
	// GDI Pie：从 (sx,sy) 到 (ex,ey)，按逆时针方向扫描（交换坐标修复方向）
	splashPie.Call(uintptr(hdc),
		uintptr(left), uintptr(top), uintptr(right), uintptr(bottom),
		uintptr(int32(ex)), uintptr(int32(ey)),
		uintptr(int32(sx)), uintptr(int32(sy)))
	splashProcSelectObj.Call(uintptr(hdc), oldB)
	splashProcSelectObj.Call(uintptr(hdc), oldP)
	splashProcDeleteObj.Call(brush)
	splashProcDeleteObj.Call(pen)

	// 挖洞：用背景色画内圆
	hBrush, _, _ := splashProcCreateBrush.Call(holeColor)
	hPen, _, _ := splashProcCreatePen.Call(0, 1, holeColor)
	oldHB, _, _ := splashProcSelectObj.Call(uintptr(hdc), hBrush)
	oldHP, _, _ := splashProcSelectObj.Call(uintptr(hdc), hPen)
	splashProcEllipse.Call(uintptr(hdc),
		uintptr(centerX-innerR), uintptr(centerY-innerR),
		uintptr(centerX+innerR), uintptr(centerY+innerR))
	splashProcSelectObj.Call(uintptr(hdc), oldHB)
	splashProcSelectObj.Call(uintptr(hdc), oldHP)
	splashProcDeleteObj.Call(hBrush)
	splashProcDeleteObj.Call(hPen)
}

// modulateColor 把 COLORREF 的亮度按 alpha 调制（0-1）
// alpha=1 原色，alpha=0 黑色
func modulateColor(color uintptr, alpha float64) uintptr {
	r := float64(color & 0xFF)
	g := float64((color >> 8) & 0xFF)
	b := float64((color >> 16) & 0xFF)
	r = math.Max(0, math.Min(255, r*alpha+255*(1-alpha)*0.3)) // 跟灰色背景混合
	g = math.Max(0, math.Min(255, g*alpha+255*(1-alpha)*0.3))
	b = math.Max(0, math.Min(255, b*alpha+255*(1-alpha)*0.3))
	return uintptr(int32(r)) | (uintptr(int32(g)) << 8) | (uintptr(int32(b)) << 16)
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

// Patch5 新方案：4 段环形 API
// SetSplashSegment 设置当前段状态
// segment: 0-3
// state: 0=未到 1=加载中 2=完成
func SetSplashSegment(ss *SplashState, segment int, state int) {
	if ss == nil {
		return
	}
	if segment < 0 || segment > 3 {
		return
	}
	ss.segmentStates[segment] = state
	if state == 1 {
		ss.currentSegment = segment
	}
	ss.animTick++
	splashProcInvalidateRect.Call(uintptr(ss.hWnd), 0, 0)
}

// SetSplashSegmentText 设置当前段对应的阶段名（如"正在加载模型引擎"）
func SetSplashSegmentText(ss *SplashState, text string) {
	if ss == nil {
		return
	}
	ss.currentStepText = text
	splashProcInvalidateRect.Call(uintptr(ss.hWnd), 0, 0)
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
