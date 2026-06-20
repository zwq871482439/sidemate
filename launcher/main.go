// sidemate-launcher — 桌伴 Sidemate Go Launcher MVP
// 职责：启动 Ollama + Python FastAPI + 打开浏览器 + 系统托盘
package main

import (
	"archive/zip"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

// ===== 配置 =====

// 版本号（编译时通过 -ldflags 注入，默认值兜底）
var AppVersion = "v0.9.5"

type Config struct {
	AppDir       string // 应用根目录
	OllamaExe    string // ollama.exe 路径
	OllamaHost   string // Ollama 监听地址
	OllamaPort   int    // Ollama 监听端口
	OllamaModels string // OLLAMA_MODELS 环境变量
	PythonExe    string // Embedded Python 路径
	ServerScript string // FastAPI 入口脚本
	ServerPort   int    // FastAPI 监听端口
	BrowserURL   string // 浏览器打开的 URL
	Version      string // 版本标识
}

func loadConfig() *Config {
	exePath, _ := os.Executable()
	appDir := filepath.Dir(exePath)

	// 尝试读取 config.json（可选）
	cfg := &Config{
		AppDir:       appDir,
		OllamaExe:    filepath.Join(appDir, "ollama.exe"),
		OllamaHost:   "127.0.0.1",
		OllamaPort:   11434,
		OllamaModels: filepath.Join(appDir, "server", "models"),
		PythonExe:    filepath.Join(appDir, "python", "python.exe"),
		ServerScript: filepath.Join(appDir, "server", "server.py"),
		ServerPort:   8976,
		Version:      AppVersion,
	}

	configFile := filepath.Join(appDir, "launcher.json")
	if data, err := os.ReadFile(configFile); err == nil {
		var overrides map[string]interface{}
		if json.Unmarshal(data, &overrides) == nil {
			if v, ok := overrides["ollama_port"].(float64); ok {
				cfg.OllamaPort = int(v)
			}
			if v, ok := overrides["server_port"].(float64); ok {
				cfg.ServerPort = int(v)
			}
			if v, ok := overrides["ollama_host"].(string); ok {
				cfg.OllamaHost = v
			}
			if v, ok := overrides["version"].(string); ok {
				cfg.Version = v
			}
		}
	}

	cfg.BrowserURL = fmt.Sprintf("http://127.0.0.1:%d", cfg.ServerPort)
	return cfg
}

// ===== 进程管理 =====

type ManagedProcess struct {
	Name    string
	Cmd     *exec.Cmd
	Cancel  context.CancelFunc
	running bool
}

// Windows Job Object：所有子进程绑定到同一个 Job，主进程退出时自动杀掉所有子进程
// 关键设计：
//   1. 主进程自己也加入 Job → 任务管理器杀 Sidemate.exe 时，Job Handle 引用归零 → 内核杀所有成员
//   2. 禁用 Breakaway → ollama spawn 的 ollama_llama_server 孙进程也被强制留在 Job 内
//   3. SetConsoleCtrlHandler 捕获 Ctrl+C / 关闭控制台 → 调用 TerminateJobObject 全杀
var (
	jobObject      syscall.Handle
	watchdogCtx    context.Context
	watchdogCancel context.CancelFunc // Patch5: shutdown 时显式调用
	k32            = syscall.NewLazyDLL("kernel32.dll")
	procCreateJobObjectW        = k32.NewProc("CreateJobObjectW")
	procSetInformationJobObject = k32.NewProc("SetInformationJobObject")
	procAssignProcessToJobObject = k32.NewProc("AssignProcessToJobObject")
	procOpenProcess             = k32.NewProc("OpenProcess")
	procGetCurrentProcessId     = k32.NewProc("GetCurrentProcessId")
	procTerminateJobObject      = k32.NewProc("TerminateJobObject")
	procSetConsoleCtrlHandler   = k32.NewProc("SetConsoleCtrlHandler")
	// 单实例互斥体
	procCreateMutexW = k32.NewProc("CreateMutexW")
	procOpenMutexW   = k32.NewProc("OpenMutexW")
	singleInstanceH  syscall.Handle
)

const (
	JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE    = 0x2000
	JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED     = 0x0400
	JobObjectExtendedLimitInformation      = 9
	PROCESS_ALL_ACCESS                     = 0x001F0FFF
	CTRL_C_EVENT        uintptr = 0
	CTRL_BREAK_EVENT    uintptr = 1
	CTRL_CLOSE_EVENT    uintptr = 2
	CTRL_LOGOFF_EVENT   uintptr = 5
	CTRL_SHUTDOWN_EVENT uintptr = 6
)

type JOBOBJECT_BASIC_LIMIT_INFORMATION struct {
	PerProcessUserTimeLimit int64
	PerJobUserTimeLimit     int64
	LimitFlags              uint32
	MinimumWorkingSetSize   uintptr
	MaximumWorkingSetSize   uintptr
	ActiveProcessLimit      uint32
	Affinity                uintptr
	PriorityClass           uint32
	SchedulingClass         uint32
}

type IO_COUNTERS struct {
	ReadOperationCount  uint64
	WriteOperationCount uint64
	OtherOperationCount uint64
	ReadTransferCount   uint64
	WriteTransferCount  uint64
	OtherTransferCount  uint64
}

type JOBOBJECT_EXTENDED_LIMIT_INFORMATION struct {
	BasicLimitInformation JOBOBJECT_BASIC_LIMIT_INFORMATION
	IoInfo                IO_COUNTERS
	ProcessMemoryLimit    uintptr
	JobMemoryLimit        uintptr
	PeakProcessMemoryUsed uintptr
	PeakJobMemoryUsed     uintptr
}

// ensureSingleInstance 用 Windows 命名互斥体防止多实例启动
// 如果已有实例在运行，返回 false（第二次启动打开浏览器后退出）
// 互斥体在进程退出时由内核自动释放，无需手动清理
//
// 检测策略：先 OpenMutex 检测 → 检测不到再 CreateMutex 创建
// 不依赖 GetLastError（Go runtime 的内部 syscall 会覆盖 last-error code）
const mutexName = "Sidemate_SingleInstance_Mutex_v0.9p4"

func ensureSingleInstance() bool {
	namePtr, _ := syscall.UTF16PtrFromString(mutexName)
	// SYNCHRONIZE = 0x100000，OpenMutex 需要的访问权限
	existing, _, _ := procOpenMutexW.Call(0x100000, 0, uintptr(unsafe.Pointer(namePtr)))
	if existing != 0 {
		// 互斥体已存在 → 有另一个实例在运行
		log.Println("[Launcher] ⚠ 检测到已有 Sidemate 实例（互斥体已存在）")
		return false
	}
	// 不存在 → 创建
	h, _, _ := procCreateMutexW.Call(0, 0, uintptr(unsafe.Pointer(namePtr)))
	if h == 0 {
		log.Println("[Launcher] ⚠ CreateMutex 失败，跳过单实例检测")
		return true
	}
	singleInstanceH = syscall.Handle(h)
	log.Println("[Launcher] ✅ 单实例互斥体已创建")
	return true
}

// initJobObject 创建一个 Job Object，设置 JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
// 核心机制：
//   1. KillOnClose — Job 最后一个 Handle 关闭时，内核自动杀所有成员进程
//   2. 主进程自己加入 Job — 任务管理器杀 Sidemate.exe 时，
//      内核关闭进程句柄 → Job Handle 引用归零 → 触发 KillOnClose → 全杀
//   3. 子进程 spawn 的孙进程（如 ollama_llama_server）默认也在 Job 内
//      （除非子进程显式创建新 Job 并设 Breakaway，Ollama 不会这么做）
func initJobObject() error {
	hJob, _, err := procCreateJobObjectW.Call(0, 0, 0)
	if hJob == 0 {
		return fmt.Errorf("CreateJobObject failed: %v", err)
	}

	info := JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE

	ret, _, err := procSetInformationJobObject.Call(
		hJob,
		JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&info)),
		unsafe.Sizeof(info),
	)
	if ret == 0 {
		return fmt.Errorf("SetInformationJobObject failed: %v", err)
	}

	jobObject = syscall.Handle(hJob)
	log.Printf("[Launcher] Job Object 已创建 (KillOnClose)")

	// 主进程自己也加入 Job
	pid, _, _ := procGetCurrentProcessId.Call()
	if err := assignToJob(int(pid)); err != nil {
		log.Printf("[Launcher] ⚠ 主进程加入 Job 失败: %v（部分保护可能不生效）", err)
	} else {
		log.Printf("[Launcher] 主进程 (PID %d) 已加入 Job Object", int(pid))
	}

	return nil
}

// assignToJob 将进程 PID 绑定到 Job Object
func assignToJob(pid int) error {
	if jobObject == 0 {
		return nil
	}
	hProc, _, err := procOpenProcess.Call(PROCESS_ALL_ACCESS, 0, uintptr(pid))
	if hProc == 0 {
		return fmt.Errorf("OpenProcess(%d) failed: %v", pid, err)
	}
	ret, _, err := procAssignProcessToJobObject.Call(uintptr(jobObject), hProc, 0)
	if ret == 0 {
		return fmt.Errorf("AssignProcessToJobObject(%d) failed: %v", pid, err)
	}
	log.Printf("[Launcher] PID %d 已绑定到 Job Object", pid)
	return nil
}

func (mp *ManagedProcess) Start() error {
	if err := mp.Cmd.Start(); err != nil {
		return fmt.Errorf("启动 %s 失败: %w", mp.Name, err)
	}
	mp.running = true
	log.Printf("[Launcher] %s 已启动 (PID=%d)", mp.Name, mp.Cmd.Process.Pid)
	// 绑定到 Job Object（主进程退出时自动杀掉）
	if err := assignToJob(mp.Cmd.Process.Pid); err != nil {
		log.Printf("[Launcher] ⚠ Job 绑定失败: %v（不影响运行）", err)
	}
	return nil
}

func (mp *ManagedProcess) Stop() {
	if !mp.running || mp.Cmd == nil || mp.Cmd.Process == nil {
		return
	}
	pid := mp.Cmd.Process.Pid
	log.Printf("[Launcher] 停止 %s (PID=%d)...", mp.Name, pid)

	// Windows: 用 taskkill /T /F 杀整个进程树（包括子进程）
	if runtime.GOOS == "windows" {
		killCmd := exec.Command("taskkill", "/PID", fmt.Sprintf("%d", pid), "/T", "/F")
		killCmd.SysProcAttr = &syscall.SysProcAttr{
			HideWindow:    true,
			CreationFlags: 0x08000000, // CREATE_NO_WINDOW
		}
		if err := killCmd.Run(); err != nil {
			log.Printf("[Launcher] taskkill %s 失败: %v，尝试 Process.Kill", mp.Name, err)
			_ = mp.Cmd.Process.Kill()
		}
	} else {
		_ = mp.Cmd.Process.Kill()
	}

	// 等待进程退出
	done := make(chan error, 1)
	go func() {
		done <- mp.Cmd.Wait()
	}()

	select {
	case <-done:
		log.Printf("[Launcher] %s 已退出", mp.Name)
	case <-time.After(5 * time.Second):
		log.Printf("[Launcher] %s 退出超时，强制结束", mp.Name)
	}

	mp.running = false
	mp.Cancel()
}

// cleanupOllama 按名称杀所有 ollama 相关进程
// ollama serve 会 spawn ollama_llama_server 等子进程，taskkill /T 可能杀不到
func cleanupOllama() {
	for _, name := range []string{"ollama.exe", "ollama_llama_server.exe", "llama-server.exe"} {
		killCmd := exec.Command("taskkill", "/IM", name, "/F")
		killCmd.SysProcAttr = &syscall.SysProcAttr{
			HideWindow:    true,
			CreationFlags: 0x08000000,
		}
		_ = killCmd.Run() // 忽略错误（进程可能已退出）
	}
	log.Println("[Launcher] Ollama 清理完成")
}

// watchOllamaChildren 后台监控：将 ollama_llama_server.exe 绑定到 Job Object
// Ollama serve 首次推理时会 spawn ollama_llama_server.exe 子进程，
// 这些进程不在 Launcher 直接管理下，需要 Job Object 统一管理才能在退出时正确清理
func watchOllamaChildren() {
	// 用已绑定 PID 集合避免重复绑定
	bound := make(map[int]bool)

	// 第一阶段：前 60 秒内每 2 秒扫描一次（覆盖模型预热前的启动窗口）
	for i := 0; i < 30; i++ {
		pids := findPidsByName("llama-server.exe")
		for _, pid := range pids {
			if !bound[pid] {
				if err := assignToJob(pid); err == nil {
					bound[pid] = true
					log.Printf("[Launcher] llama-server (PID %d) 已绑定 Job Object", pid)
				}
			}
		}
		if len(pids) > 0 {
			// 找到了，但继续扫描看有没有新的
		}
		time.Sleep(2 * time.Second)
	}

	// 第二阶段：降低频率，每 30 秒扫描一次（模型切换/重装可能产生新进程）
	for {
		pids := findPidsByName("llama-server.exe")
		for _, pid := range pids {
			if !bound[pid] {
				if err := assignToJob(pid); err == nil {
					bound[pid] = true
					log.Printf("[Launcher] ollama_llama_server (PID %d) 已绑定 Job Object（后续扫描）", pid)
				}
			}
		}
		time.Sleep(30 * time.Second)
	}
}

// findPidsByName 用 tasklist 按进程名查找所有 PID
func findPidsByName(name string) []int {
	tasklistCmd := exec.Command("tasklist", "/FI", fmt.Sprintf("IMAGENAME eq %s", name), "/FO", "CSV", "/NH")
	tasklistCmd.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: 0x08000000,
	}
	output, err := tasklistCmd.Output()
	if err != nil || len(output) == 0 {
		return nil
	}

	var pids []int
	lines := splitLines(string(output))
	for _, line := range lines {
		pid := extractPIDFromCSV(line)
		if pid > 0 {
			pids = append(pids, pid)
		}
	}
	return pids
}

// splitLines 按换行符分割字符串
func splitLines(s string) []string {
	var lines []string
	start := 0
	for i := 0; i < len(s); i++ {
		if s[i] == '\n' {
			line := s[start:i]
			if len(line) > 0 && line[len(line)-1] == '\r' {
				line = line[:len(line)-1]
			}
			if len(line) > 0 {
				lines = append(lines, line)
			}
			start = i + 1
		}
	}
	if start < len(s) {
		lines = append(lines, s[start:])
	}
	return lines
}

// extractPIDFromCSV 从 tasklist CSV 行提取 PID
// 格式: "ollama_llama_server.exe","12345","Console","1","4,567 K"
func extractPIDFromCSV(line string) int {
	// 找第二个引号对
	count := 0
	start := -1
	for i := 0; i < len(line); i++ {
		if line[i] == '"' {
			count++
			if count == 3 {
				start = i + 1
			} else if count == 4 && start >= 0 {
				pidStr := line[start:i]
				pid := 0
				for _, c := range pidStr {
					if c >= '0' && c <= '9' {
						pid = pid*10 + int(c-'0')
					} else {
						break
					}
				}
				return pid
			}
		}
	}
	return 0
}

// terminateJob 兜底：直接调用 TerminateJobObject 杀 Job 内所有进程
// 在崩溃/异常退出场景下作为最后一道防线
func terminateJob() {
	if jobObject != 0 {
		procTerminateJobObject.Call(uintptr(jobObject), 1)
		log.Println("[Launcher] TerminateJobObject 已调用")
	}
}

// consoleCtrlHandler Windows 控制台事件回调（Ctrl+C / 关闭 / 关机）
// 在这些事件中调用 TerminateJobObject 确保所有子进程被杀
var consoleCtrlHandler = syscall.NewCallback(func(ctrlType uintptr) uintptr {
	switch ctrlType {
	case CTRL_C_EVENT, CTRL_BREAK_EVENT, CTRL_CLOSE_EVENT, CTRL_LOGOFF_EVENT, CTRL_SHUTDOWN_EVENT:
		log.Printf("[Launcher] 收到控制台事件 %d，正在清理...", ctrlType)
		terminateJob()
		return 1 // 已处理
	}
	return 0 // 未处理
})

// installCtrlHandler 安装控制台事件处理器
func installCtrlHandler() {
	procSetConsoleCtrlHandler.Call(consoleCtrlHandler, 1)
	log.Println("[Launcher] 控制台事件处理器已安装")
}

// ===== 健康检查 =====

// isServiceAlive HTTP 深度健康检查（Patch5 P0：替代 isPortOpen 用于面板状态显示）
// 不仅检查 TCP 端口，还发 HTTP 请求并校验响应体字段，避免端口残留误判。
// 注意：超时设为 2s（面板每 2s 刷新一次，超时过长会拖慢刷新）
func isServiceAlive(url string, kind string) bool {
	client := &http.Client{Timeout: 2 * time.Second}
	resp, err := client.Get(url)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return false
	}
	// 读 body 校验关键字段（最多 8KB，足够判断）
	body, err := io.ReadAll(io.LimitReader(resp.Body, 8192))
	if err != nil {
		return false
	}
	bodyStr := string(body)
	switch kind {
	case "ollama":
		return strings.Contains(bodyStr, "models")
	case "python":
		return strings.Contains(bodyStr, "version")
	}
	return true
}

func isPortOpen(host string, port int) bool {
	addr := fmt.Sprintf("%s:%d", host, port)
	conn, err := net.DialTimeout("tcp", addr, 2*time.Second)
	if err != nil {
		return false
	}
	conn.Close()
	return true
}

// checkLLMAvailable 检查 Ollama 是否有可用 LLM 模型（用于决定是否预热）
// 通过 HTTP /api/tags 查询，超时 3s
func checkLLMAvailable(host string, port int) bool {
	url := fmt.Sprintf("http://%s:%d/api/tags", host, port)
	client := &http.Client{Timeout: 3 * time.Second}
	resp, err := client.Get(url)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return false
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 8192))
	if err != nil {
		return false
	}
	// 响应体含 "models" 且至少有一个模型（models 数组非空）
	bodyStr := string(body)
	if !strings.Contains(bodyStr, "models") {
		return false
	}
	// 简单判断：含 "name" 字段表示有模型
	return strings.Contains(bodyStr, `"name"`)
}

// stageMinDelay 强制阶段最少停留（避免秒过的阶段闪过看不清）
func stageMinDelay(start time.Time, min time.Duration) {
	elapsed := time.Since(start)
	if elapsed < min {
		time.Sleep(min - elapsed)
	}
}

// messageBox 弹出 Windows 消息框
// uType: 0x40 = MB_ICONINFORMATION, 0x30 = MB_ICONWARNING, 0x10 = MB_ICONERROR
func messageBox(title, text string, uType uintptr) int {
	titlePtr, _ := syscall.UTF16PtrFromString(title)
	textPtr, _ := syscall.UTF16PtrFromString(text)
	ret, _, _ := user32.NewProc("MessageBoxW").Call(
		0,
		uintptr(unsafe.Pointer(textPtr)),
		uintptr(unsafe.Pointer(titlePtr)),
		uType,
	)
	return int(ret)
}

// saveGpuInfoToLauncherJson 把 GPU 信息写入 data/launcher.json 供诊断面板读取
func saveGpuInfoToLauncherJson(appDir string, gpuInfo GPUInfo, backend string) {
	jsonPath := filepath.Join(appDir, "data", "launcher.json")

	// 先读现有内容（保留其他字段）
	existing := map[string]interface{}{}
	if data, err := os.ReadFile(jsonPath); err == nil {
		_ = json.Unmarshal(data, &existing)
	}

	existing["last_gpu_info"] = map[string]interface{}{
		"device":  gpuInfo.Name,
		"vendor":  gpuInfo.Vendor,
		"backend": backend,
		"cuda":    gpuInfo.HasCUDA,
		"vulkan":  gpuInfo.HasVulkan,
	}

	if data, err := json.MarshalIndent(existing, "", "  "); err == nil {
		_ = os.WriteFile(jsonPath, data, 0644)
	}
}

// indexOfStr 字符串包含查找
func indexOfStr(s, sub string) int {
	return strings.Index(s, sub)
}

// trimRightSpace 去掉右侧空格和点
func trimRightSpace(s string) string {
	return strings.TrimRight(s, " .")
}

func waitForOllama(host string, port int, timeout time.Duration) bool {
	url := fmt.Sprintf("http://%s:%d/api/tags", host, port)
	deadline := time.Now().Add(timeout)

	for time.Now().Before(deadline) {
		resp, err := http.Get(url)
		if err == nil && resp.StatusCode == 200 {
			io.ReadAll(resp.Body)
			resp.Body.Close()
			return true
		}
		if resp != nil {
			resp.Body.Close()
		}
		time.Sleep(1 * time.Second)
	}
	return false
}

func waitForServer(host string, port int, timeout time.Duration) bool {
	url := fmt.Sprintf("http://%s:%d/api/status", host, port)
	deadline := time.Now().Add(timeout)

	for time.Now().Before(deadline) {
		resp, err := http.Get(url)
		if err == nil && resp.StatusCode == 200 {
			io.ReadAll(resp.Body)
			resp.Body.Close()
			return true
		}
		if resp != nil {
			resp.Body.Close()
		}
		time.Sleep(500 * time.Millisecond)
	}
	return false
}

// ===== 浏览器 =====

func openBrowser(url string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
		cmd.SysProcAttr = &syscall.SysProcAttr{
			HideWindow:    true,
			CreationFlags: 0x08000000, // CREATE_NO_WINDOW
		}
	case "darwin":
		cmd = exec.Command("open", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	if err := cmd.Start(); err != nil {
		log.Printf("[Launcher] 打开浏览器失败: %v", err)
	} else {
		log.Printf("[Launcher] 浏览器已打开: %s", url)
	}
}

// ===== 主流程 =====

func main() {
	// CRITICAL: Windows 窗口消息循环必须在同一线程上运行
	// Go runtime 的 M:N 调度可能在 syscall 阻塞时迁移 goroutine 到另一个 OS 线程
	// 导致 GetMessageW/DispatchMessageW 窗口过程在不同线程执行 → 托盘事件丢失
	// LockOSThread() 锁定当前 goroutine 到物理线程，防止迁移
	runtime.LockOSThread()

	// DPI 感知：让 Windows 不做虚拟化缩放，我们自己在 GDI 里按 DPI 缩放
	user32.NewProc("SetProcessDPIAware").Call()

	log.SetFlags(log.Ltime | log.Lmicroseconds)

	// Windows GUI 模式下无控制台，将 launcher 日志写到文件
	exePath, _ := os.Executable()
	appDir := filepath.Dir(exePath)
	launcherLogFile := filepath.Join(appDir, "data", "logs", "launcher.log")
	os.MkdirAll(filepath.Dir(launcherLogFile), 0755)
	if lf, err := os.OpenFile(launcherLogFile, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644); err == nil {
		log.SetOutput(lf)
	}

	log.Println("[Launcher] 桌伴 Sidemate " + AppVersion + " — Launcher")
	log.Println("========================================")

	cfg := loadConfig()
	log.Printf("[Launcher] 应用目录: %s", cfg.AppDir)

	// 验证关键文件
	if _, err := os.Stat(cfg.OllamaExe); err != nil {
		log.Fatalf("[Launcher] 找不到 ollama.exe: %s", cfg.OllamaExe)
	}
	if _, err := os.Stat(cfg.PythonExe); err != nil {
		log.Fatalf("[Launcher] 找不到 python.exe: %s", cfg.PythonExe)
	}
	if _, err := os.Stat(cfg.ServerScript); err != nil {
		log.Fatalf("[Launcher] 找不到 server.py: %s", cfg.ServerScript)
	}

	var processes []*ManagedProcess

	// 单实例检测（Windows 命名互斥体）
	if runtime.GOOS == "windows" {
		if !ensureSingleInstance() {
			// Patch5 修复：已有实例在运行时，弹窗提示用户，不再静默打开浏览器
			// （静默行为会让用户误以为"重启了"，实际老进程一个没动）
			log.Println("[Launcher] ⚠ 已有 Sidemate 实例在运行")
			messageBox("桌伴 Sidemate", "桌伴 Sidemate 已经在运行中。\n\n如需重启：\n1. 右键托盘图标 → 退出\n2. 再重新双击 Sidemate.exe", 0x40)
			openBrowser(cfg.BrowserURL)
			return
		}
	}

	// 初始化 Job Object（主进程退出时自动杀掉所有子进程）
	if runtime.GOOS == "windows" {
		if err := initJobObject(); err != nil {
			log.Printf("[Launcher] ⚠ Job Object 创建失败: %v（不影响运行）", err)
		}
		// 安装控制台事件处理器（Ctrl+C / 关闭 / 关机 → TerminateJobObject）
		installCtrlHandler()
	}

	// ---- Splash 启动画面 ----
	var splash *SplashState
	if runtime.GOOS == "windows" {
		splash = CreateSplashWindow(appDir, cfg.Version, launcherLogFile)
		if splash != nil {
			defer CloseSplash(splash)
		}
	}

	// Patch5 新方案：托盘提前到启动期（启动期间也能退出）
	// 启动期菜单：取消启动
	// 启动完成后切换为：打开浏览器 / 退出
	cancelStartup := func() {
		log.Println("[Launcher] 用户取消启动")
		terminateJob()
		os.Exit(0)
	}
	openBrowserFn := func() { openBrowser(cfg.BrowserURL) }
	showPanelFn := func() {
		ShowStatusPanel(cfg.Version, cfg.BrowserURL, cfg.OllamaPort, cfg.ServerPort, trayHIcon, openBrowserFn)
	}
	if runtime.GOOS == "windows" && splash != nil {
		_ = InitTray("SidemateTrayClass", "桌伴 Sidemate（启动中）", openBrowserFn, cancelStartup, showPanelFn, cfg.Version, cfg.BrowserURL)
		log.Println("[Launcher] 启动期托盘已创建（右键可取消启动）")
	}

	// ---- 0. GPU 检测 + 三档分流（Patch5 T04）----
	// ===== Patch5 4 段环形启动流程 =====
	// 段 0: 正在初始化环境检查
	// 段 1: 正在加载基础服务
	// 段 2: 正在加载模型引擎
	// 段 3: 正在加载守护进程

	// ---- 段 0：正在初始化环境检查（至少 3s）----
	SetSplashSegment(splash, 0, 1) // state=1 加载中
	SetSplashSegmentText(splash, "正在初始化环境检查")
	stageStart := time.Now()
	log.Println("[Launcher] 检测 GPU 后端...")
	gpuInfo := detectGPU()
	ollamaBackend := setOllamaBackend(gpuInfo)
	log.Printf("[Launcher] GPU 检测结果: %s", gpuBackendSummary(gpuInfo))
	log.Printf("[Launcher] OLLAMA_LLM_LIBRARY = %s", ollamaBackend)
	os.Setenv("OLLAMA_LLM_LIBRARY", ollamaBackend)
	saveGpuInfoToLauncherJson(appDir, gpuInfo, ollamaBackend)
	// 段 0 完成检查通过后变绿，但至少停留 3s
	stageMinDelay(stageStart, 3*time.Second)
	SetSplashSegment(splash, 0, 2) // state=2 完成（变绿）

	// ---- 段 1：正在加载基础服务（至少 3s）----
	SetSplashSegment(splash, 1, 1)
	SetSplashSegmentText(splash, "正在加载基础服务")
	stageStart = time.Now()
	// ---- 1. 启动 Ollama ----
	// Patch5 启动重构：基础服务阶段（10→30%）
	UpdateSplashStageInfo(splash, 5, 1) // 当前在第 1 阶段（基础服务）
	UpdateSplashStage(splash, StepRunning, "启动基础服务", 15)
	log.Println("[Launcher] 启动 Ollama...")

	// 辅助：构建 ollama 命令（启动和重试共用）
	newOllamaCmd := func() (*exec.Cmd, context.CancelFunc) {
		ctx, cancel := context.WithCancel(context.Background())
		cmd := exec.CommandContext(ctx, cfg.OllamaExe, "serve")
		cmd.Env = append(os.Environ(),
			fmt.Sprintf("OLLAMA_HOST=%s:%d", cfg.OllamaHost, cfg.OllamaPort),
			fmt.Sprintf("OLLAMA_MODELS=%s", cfg.OllamaModels),
			fmt.Sprintf("OLLAMA_LLM_LIBRARY=%s", ollamaBackend), // Patch5: GPU 三档分流
			"OLLAMA_ORIGINS=*",
			"OLLAMA_NOAUTOLOAD=true",
			"OLLAMA_NOPRUNE=true",
			"OLLAMA_NUM_PARALLEL=1",
			"OLLAMA_KEEP_ALIVE=24h",
			"OLLAMA_VULKAN=1",
			"OLLAMA_IGPU_ENABLE=1",
			"OLLAMA_GPU_LAYERS=99",
			"OLLAMA_GPU_OVERHEAD=2147483648",
		)
		ollamaLogPath := filepath.Join(appDir, "data", "logs", "ollama-stdout.log")
		if of, err := os.OpenFile(ollamaLogPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644); err == nil {
			cmd.Stdout = of
			cmd.Stderr = of
		} else {
			cmd.Stdout = os.Stdout
			cmd.Stderr = os.Stderr
		}
		if runtime.GOOS == "windows" {
			cmd.SysProcAttr = &syscall.SysProcAttr{
				HideWindow:    true,
				CreationFlags: 0x08000000,
			}
		}
		return cmd, cancel
	}

	UpdateSplash(splash, 0, StepRunning, "正在启动...")
	ollamaCmd, cancel1 := newOllamaCmd()
	ollamaProc := &ManagedProcess{Name: "Ollama", Cmd: ollamaCmd, Cancel: cancel1}
	if err := ollamaProc.Start(); err != nil {
		log.Fatalf("[Launcher] %v", err)
	}
	processes = append(processes, ollamaProc)

	// 等待 Ollama 就绪（含自修复重试 + 进度提示）
	log.Println("[Launcher] 等待 Ollama 就绪...")
	UpdateSplashStage(splash, StepRunning, "启动 Ollama 引擎", 18)
	ollamaReady := false
	ollamaStart := time.Now()

	waitForOllamaWithProgress := func(host string, port int, timeout time.Duration) bool {
		url := fmt.Sprintf("http://%s:%d/api/tags", host, port)
		deadline := time.Now().Add(timeout)
		lastPhase := ""
		phases := []struct {
			after time.Duration
			text  string
		}{
			{2 * time.Second, "加载 GPU 驱动..."},
			{5 * time.Second, "初始化推理引擎..."},
			{10 * time.Second, "等待响应..."},
		}
		// 进度范围：5%（已启动）→ 28%（即将超时），Done 时跳到 30%
		const progStart int = 5
		const progEnd int = 28
		// 预期合理时间：Ollama 通常 8-15 秒就绪，以此作为进度分母
		// 超过 expected 后进度趋近 progEnd 但不立即到顶
		const expected time.Duration = 12 * time.Second
		for time.Now().Before(deadline) {
			elapsed := time.Since(ollamaStart)
			// 用预期时间做分母，超过后用 sqrt 压缩
			ratio := float64(elapsed) / float64(expected)
			if ratio > 1.0 {
				// 超过预期后，用 sqrt 压缩让进度缓慢增长（1→1.41→1.73...）
				ratio = 1.0 + math.Sqrt(ratio-1.0)*0.5
			}
			if ratio > 2.0 {
				ratio = 2.0 // 上限：不管等多久，进度不超过 progEnd
			}
			// 映射到 [progStart, progEnd]
			prog := progStart + int(float64(progEnd-progStart)*ratio/2.0)
			if prog > progEnd {
				prog = progEnd
			}
			if splash != nil {
				splash.targetProgress = prog
			}
			for _, p := range phases {
				if elapsed >= p.after && lastPhase != p.text {
					lastPhase = p.text
					UpdateSplash(splash, 0, StepRunning, p.text)
					log.Printf("[Launcher] Ollama 阶段: %s (%.1fs)", p.text, elapsed.Seconds())
				}
			}
			SplashPumpMessages()
			resp, err := http.Get(url)
			if err == nil && resp.StatusCode == 200 {
				io.ReadAll(resp.Body)
				resp.Body.Close()
				return true
			}
			if resp != nil {
				resp.Body.Close()
			}
			time.Sleep(500 * time.Millisecond)
		}
		return false
	}

	for retry := 0; retry < 3; retry++ {
		SplashPumpMessages()
		if waitForOllamaWithProgress(cfg.OllamaHost, cfg.OllamaPort, 60*time.Second) {
			elapsed := time.Since(ollamaStart)
			log.Printf("[Launcher] ✅ Ollama 就绪 (%.1fs)", elapsed.Seconds())
			ollamaReady = true
			break
		}
		if retry < 2 {
			UpdateSplash(splash, 0, StepRetry, fmt.Sprintf("自修复中 · 第 %d/3 次", retry+2))
			// 重试时进度回落到阶段起始
			if splash != nil {
				splash.targetProgress = 5
			}
			log.Printf("[Launcher] ⚠ Ollama 启动超时，自修复第 %d/3 次...", retry+2)
			cleanupOllama()
			time.Sleep(3 * time.Second)
			// 重新创建并启动
			ollamaProc.Stop()
			processes = processes[:len(processes)-1]
			ollamaCmd, cancel1 = newOllamaCmd()
			ollamaProc = &ManagedProcess{Name: "Ollama", Cmd: ollamaCmd, Cancel: cancel1}
			if err := ollamaProc.Start(); err != nil {
				log.Printf("[Launcher] ⚠ Ollama 重启失败: %v", err)
			} else {
				processes = append(processes, ollamaProc)
			}
		} else {
			UpdateSplash(splash, 0, StepFailed, "Ollama 启动失败")
			log.Println("[Launcher] ⚠ Ollama 3次尝试均失败")
		}
	}

	if ollamaReady {
		// 后台监控 ollama 子进程
		if runtime.GOOS == "windows" {
			go watchOllamaChildren()
		}
	} else {
		SetSplashFailed(splash, "Ollama 引擎启动失败，请检查日志")
		// 阻塞等待用户操作（点击按钮退出）
		if splash != nil {
			for {
				SplashPumpMessages()
				time.Sleep(100 * time.Millisecond)
			}
		}
		os.Exit(1)
	}

	// ---- 1.5 环境指纹校验（启动 FastAPI 之前）----
	UpdateSplashStage(splash, StepRunning, "检查环境完整性", 22)
	SplashPumpMessages()
	checkAndRepairEnv(appDir, splash)

	// ---- 1.6 硬链接备份初始化（Patch5 T04：首次启动创建依赖双副本）----
	sitePackagesDir := filepath.Join(appDir, "python", "Lib", "site-packages")
	if _, err := os.Stat(sitePackagesDir); err == nil {
		log.Println("[Launcher] 初始化依赖硬链接备份...")
		if err := setupHardlinkBackup(sitePackagesDir); err != nil {
			log.Printf("[Launcher] ⚠ 硬链接备份初始化失败: %v（不影响运行）", err)
		}
	}

	// ---- 2. 启动 FastAPI ----
	log.Println("[Launcher] 启动 FastAPI 服务...")

	newPythonCmd := func() (*exec.Cmd, context.CancelFunc) {
		ctx, cancel := context.WithCancel(context.Background())
		serverDir := filepath.Dir(cfg.ServerScript)
		cmd := exec.CommandContext(ctx, cfg.PythonExe, "-u", cfg.ServerScript, "--serve")
		cmd.Dir = serverDir
		cmd.Env = append(os.Environ(),
			"PYTHONNOUSERSITE=1",
			fmt.Sprintf("PYTHONPATH=%s", serverDir),
			fmt.Sprintf("OLLAMA_HOST=%s", cfg.OllamaHost),
			fmt.Sprintf("OLLAMA_PORT=%d", cfg.OllamaPort),
			"LOCAL_AI_HOST=127.0.0.1",
			fmt.Sprintf("LOCAL_AI_PORT=%d", cfg.ServerPort),
		)
		pythonLogPath := filepath.Join(appDir, "data", "logs", "python-stdout.log")
		if pf, err := os.OpenFile(pythonLogPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644); err == nil {
			cmd.Stdout = pf
			cmd.Stderr = pf
		} else {
			cmd.Stdout = os.Stdout
			cmd.Stderr = os.Stderr
		}
		if runtime.GOOS == "windows" {
			cmd.SysProcAttr = &syscall.SysProcAttr{
				HideWindow:    true,
				CreationFlags: 0x08000000,
			}
		}
		return cmd, cancel
	}

	UpdateSplashStage(splash, StepRunning, "启动 FastAPI 服务", 25)
	pythonCmd, cancel2 := newPythonCmd()
	serverProc := &ManagedProcess{Name: "FastAPI", Cmd: pythonCmd, Cancel: cancel2}
	if err := serverProc.Start(); err != nil {
		log.Fatalf("[Launcher] %v", err)
	}
	processes = append(processes, serverProc)

	// 等待 FastAPI 就绪（含自修复重试 + 真实进度同步）
	log.Println("[Launcher] 等待 FastAPI 就绪...")
	// 清理上次残留的进度文件
	_ = os.Remove(filepath.Join(appDir, "data", "startup_progress.json"))
	serverReady := false
	serverStart := time.Now()

	waitForServerWithProgress := func(host string, port int, timeout time.Duration) bool {
		url := fmt.Sprintf("http://%s:%d/api/status", host, port)
		deadline := time.Now().Add(timeout)
		// 进度文件路径：data/startup_progress.json
		progressFile := filepath.Join(appDir, "data", "startup_progress.json")
		lastReportedText := ""

		for time.Now().Before(deadline) {
			// 1. 优先读进度文件（真实进度）
			fileProgress := -1
			fileText := ""
			if data, err := os.ReadFile(progressFile); err == nil {
				var sp struct {
					Phase    string  `json:"phase"`
					Progress int     `json:"progress"`
					Text     string  `json:"text"`
					Ts       float64 `json:"ts"`
				}
				if json.Unmarshal(data, &sp) == nil && sp.Progress > 0 {
					fileProgress = sp.Progress
					fileText = sp.Text
				}
			}

			// 2. 映射到 Splash 进度范围 [35, 93]
			//    Python 端进度 0-85 映射到 Splash 35-93
			//    StepDone 时跳到 95，浏览器打开到 100
			var prog int
			if fileProgress >= 0 {
				if fileProgress >= 85 {
					prog = 93
				} else {
					prog = 35 + int(float64(fileProgress)*float64(93-35)/85.0)
				}
			} else {
				// 无进度文件时 fallback：按时间线性（兼容旧版）
				elapsed := time.Since(serverStart)
				ratio := float64(elapsed) / float64(timeout)
				if ratio > 1.0 {
					ratio = 1.0
				}
				prog = 35 + int(float64(93-35)*ratio)
			}
			if prog > 93 {
				prog = 93
			}
			if splash != nil {
				splash.targetProgress = prog
			}

			// 3. 更新阶段文字（Patch5：单行动态步骤）
			if fileText != "" && fileText != lastReportedText {
				lastReportedText = fileText
				UpdateSplashStage(splash, StepRunning, fileText, prog)
				log.Printf("[Launcher] FastAPI 阶段: %s (progress=%d%%)", fileText, fileProgress)
			} else {
				UpdateSplashStageProgress(splash, prog)
			}

			// 4. 检测 HTTP 就绪
			SplashPumpMessages()
			resp, err := http.Get(url)
			if err == nil && resp.StatusCode == 200 {
				io.ReadAll(resp.Body)
				resp.Body.Close()
				return true
			}
			if resp != nil {
				resp.Body.Close()
			}
			time.Sleep(300 * time.Millisecond)
		}
		return false
	}

	for retry := 0; retry < 3; retry++ {
		SplashPumpMessages()
		if waitForServerWithProgress("127.0.0.1", cfg.ServerPort, 60*time.Second) {
			elapsed := time.Since(serverStart)
			serverReady = true
			_ = os.Remove(filepath.Join(appDir, "data", "startup_progress.json"))
			log.Printf("[Launcher] ✅ FastAPI 就绪 (%.1fs)", elapsed.Seconds())
			// 段 1 完成，至少停留 3s
			stageMinDelay(stageStart, 3*time.Second)
			SetSplashSegment(splash, 1, 2) // 基础服务段变绿
			break
		}
		if retry < 2 {
			UpdateSplashStage(splash, StepRetry, fmt.Sprintf("自修复中 · 第 %d/3 次", retry+2), 25)
			log.Printf("[Launcher] ⚠ FastAPI 启动超时，自修复第 %d/3 次...", retry+2)
			serverProc.Stop()
			// 检测端口占用并释放
			if isPortOpen("127.0.0.1", cfg.ServerPort) {
				pids := findPidsByName("python.exe")
				for _, pid := range pids {
					killCmd := exec.Command("taskkill", "/PID", fmt.Sprintf("%d", pid), "/F")
					killCmd.SysProcAttr = &syscall.SysProcAttr{
						HideWindow:    true,
						CreationFlags: 0x08000000,
					}
					_ = killCmd.Run()
				}
			}
			time.Sleep(3 * time.Second)
			// 重新创建并启动
			processes = processes[:len(processes)-1]
			pythonCmd, cancel2 = newPythonCmd()
			serverProc = &ManagedProcess{Name: "FastAPI", Cmd: pythonCmd, Cancel: cancel2}
			if err := serverProc.Start(); err != nil {
				log.Printf("[Launcher] ⚠ FastAPI 重启失败: %v", err)
			} else {
				processes = append(processes, serverProc)
			}
		} else {
			UpdateSplashStage(splash, StepFailed, "FastAPI 启动失败", 0)
			log.Println("[Launcher] ⚠ FastAPI 3次尝试均失败")
		}
	}

	if !serverReady {
		SetSplashFailed(splash, "FastAPI 服务启动失败，请检查日志")
		if splash != nil {
			for {
				SplashPumpMessages()
				time.Sleep(100 * time.Millisecond)
			}
		}
		os.Exit(1)
	}

	// ===== Patch5 新方案：段 2 + 段 3 =====
	// HTTP 就绪意味着 _lifespan 已完成所有初始化（KB/纪要/Ollama/预热）
	// 不再需要轮询 startup_progress.json

	// ---- 段 2：正在加载模型引擎（至少 3s）----
	// 注：实际上 _lifespan 已经在 HTTP 监听前做完了这些
	// 但用户视觉上需要看到这个阶段（3s 最低停留）
	SetSplashSegment(splash, 2, 1)
	SetSplashSegmentText(splash, "正在加载模型引擎")
	stageStart = time.Now()
	stageMinDelay(stageStart, 3*time.Second)
	SetSplashSegment(splash, 2, 2) // 模型引擎段变绿

	// ---- 段 3：正在加载守护进程（至少 3s）----
	SetSplashSegment(splash, 3, 1)
	SetSplashSegmentText(splash, "正在加载守护进程")
	stageStart = time.Now()

	// 实际启动看门狗
	watchdogCtx, watchdogCancel = context.WithCancel(context.Background())
	go startWatchdog(cfg, serverProc, ollamaProc, newPythonCmd, newOllamaCmd, watchdogCtx)
	log.Println("[Launcher] 看门狗已启动（健康监测 + 自动重启）")

	// 至少停留 3s
	stageMinDelay(stageStart, 3*time.Second)
	SetSplashSegment(splash, 3, 2) // 守护进程段变绿

	// ---- 全部就绪 ----
	SetSplashSegmentText(splash, "全部就绪")
	SplashPumpMessages()
	time.Sleep(500 * time.Millisecond)

	// ---- 打开浏览器 ----
	log.Println("[Launcher] 打开浏览器...")
	openBrowser(cfg.BrowserURL)

	// 启动完成 → 等进度条走满再关闭 splash
	if splash != nil {
		// 等进度到 100%（最多 2s）
		for i := 0; i < 20 && splash.progress < 100; i++ {
			SplashPumpMessages()
			time.Sleep(100 * time.Millisecond)
		}
		// 确保最终显示 100%
		splash.progress = 100
		splashProcInvalidateRect.Call(uintptr(splash.hWnd), 0, 0)
		SplashPumpMessages()
		time.Sleep(800 * time.Millisecond)
		SplashPumpMessages()
	}
	CloseSplash(splash)
	splash = nil // 防止 defer 重复关闭

	// ---- 4. 系统托盘 ----
	log.Println("[Launcher] 初始化系统托盘...")

	// 托盘退出回调
	shutdown := func() {
		log.Println("[Launcher] 托盘退出，正在关闭...")
		RemoveTrayIcon()
		// Patch5 关键修复：先停 Watchdog，再停 server，避免 watchdog 在 server 死后拉起新进程
		// （这是"重启后老 Python 还在跑"的根因）
		if watchdogCancel != nil {
			log.Println("[Launcher] 停止看门狗...")
			watchdogCancel()
			time.Sleep(500 * time.Millisecond) // 给 watchdog 一点时间退出
		}
		// 反向停止：先停 Python，再停 Ollama
		for i := len(processes) - 1; i >= 0; i-- {
			processes[i].Stop()
		}
		// 兜底：按名称杀所有 ollama 相关进程（ollama serve 会 spawn ollama_llama_server）
		if runtime.GOOS == "windows" {
			cleanupOllama()
			// 终极兜底：TerminateJobObject 杀 Job 内所有剩余进程
			terminateJob()
		}
		log.Println("[Launcher] 桌伴 Sidemate 已关闭")
		os.Exit(0)
	}

	// 托盘打开浏览器回调
	openUrl := func() {
		openBrowser(cfg.BrowserURL)
	}

	// 托盘左键 → 状态面板
	showPanel := func() {
		ShowStatusPanel(cfg.Version, cfg.BrowserURL, cfg.OllamaPort, cfg.ServerPort, trayHIcon, openUrl)
	}

	// Patch5：启动期已创建托盘（cancelStartup），现在切换退出回调为正式 shutdown
	// 通过修改全局回调变量实现（tray_windows.go 里 trayOnExit = onExit）
	if runtime.GOOS == "windows" {
		// 更新托盘提示文字和退出回调
		UpdateTrayCallbacks("桌伴 Sidemate", openUrl, shutdown, showPanel)
	}

	log.Println("========================================")
	log.Println("[Launcher] 桌伴 Sidemate 运行中")
	log.Println("[Launcher] 左键托盘 → 状态面板，右键 → 菜单")
	log.Println("========================================")

	// Windows: 运行托盘消息循环（阻塞直到退出）
	if runtime.GOOS == "windows" && trayHWnd != 0 {
		TrayMessageLoop()
	} else {
		// 非 Windows 或托盘失败：使用 signal 等待
		sigChan := make(chan os.Signal, 1)
		signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
		<-sigChan
		shutdown()
	}
}

// ===== 环境指纹校验 + 恢复 =====

// fingerprintJSON 对应 python/.fingerprint 文件结构
type fingerprintJSON struct {
	TotalFiles  int               `json:"total_files"`
	TotalBytes  int64             `json:"total_bytes"`
	CoreHashes  map[string]string `json:"core_hashes"`
	GeneratedAt string            `json:"generated_at"`
}

// checkAndRepairEnv 检查 site-packages 环境指纹，不匹配则从 backup 恢复
func checkAndRepairEnv(appDir string, splash *SplashState) {
	pythonDir := filepath.Join(appDir, "python")
	sitePackagesDir := filepath.Join(pythonDir, "Lib", "site-packages")
	fpPath := filepath.Join(pythonDir, ".fingerprint")
	snapshotPath := filepath.Join(appDir, "backup", "site_packages.zip")

	// 1. 检查 .fingerprint 文件是否存在
	fpData, err := os.ReadFile(fpPath)
	if err != nil {
		// 首次启动（ISS 安装后首次运行会由 Python 侧生成指纹）
		// 跳过校验，让 Python 侧生成
		log.Printf("[ENV-CHECK] .fingerprint 不存在，跳过校验（首次启动）")
		return
	}

	// 2. 解析指纹
	var fp fingerprintJSON
	if err := json.Unmarshal(fpData, &fp); err != nil {
		log.Printf("[ENV-CHECK] .fingerprint 解析失败: %v，跳过", err)
		return
	}

	// 3. 快速校验：核心包 SHA256（P5 优化：跳过全量文件遍历，39043 文件太慢）
	// 之前用 countSitePackages 遍历全部文件做数量/大小比对，启动卡 10+ 秒
	// 现在直接走核心包 SHA256 校验（5 个包，前 1MB，毫秒级）
	// 如果核心包校验通过，说明环境基本完整；失败才走 restoreFromSnapshot
	log.Printf("[ENV-CHECK] 跳过全量遍历，直接核心包 SHA256 校验（期望: %d 文件, %d 字节）...",
		fp.TotalFiles, fp.TotalBytes)
	allMatch := true
	for pkg, expectedHash := range fp.CoreHashes {
		if expectedHash == "" {
			continue
		}
		initFile := filepath.Join(sitePackagesDir, pkg, "__init__.py")
		actualHash := sha256FileGo(initFile)
		if actualHash != expectedHash {
			log.Printf("[ENV-CHECK] ⚠ 核心包 %s SHA256 不匹配 (期望: %s, 实际: %s)", pkg, expectedHash[:12], actualHash[:12])
			allMatch = false
			break
		}
	}

	if !allMatch {
		restoreFromSnapshot(appDir, splash, snapshotPath, sitePackagesDir, pythonDir)
		return
	}

	log.Printf("[ENV-CHECK] ✅ 环境指纹校验通过")
}

// restoreFromSnapshot 从 backup/site_packages.zip 恢复 site-packages
func restoreFromSnapshot(appDir string, splash *SplashState, snapshotPath, sitePackagesDir, pythonDir string) {
	if _, err := os.Stat(snapshotPath); err != nil {
		log.Printf("[ENV-CHECK] ⚠ snapshot 不存在: %s，无法自动恢复", snapshotPath)
		UpdateSplash(splash, 1, StepRunning, "环境异常，建议重新安装")
		return
	}

	UpdateSplash(splash, 1, StepRunning, "正在恢复依赖环境...")
	SplashPumpMessages()
	log.Printf("[ENV-CHECK] 从 snapshot 恢复: %s", snapshotPath)

	// 1. 删除当前 site-packages
	os.RemoveAll(sitePackagesDir)
	os.MkdirAll(sitePackagesDir, 0755)

	// 2. 解压 snapshot
	err := unzipToDir(snapshotPath, sitePackagesDir)
	if err != nil {
		log.Printf("[ENV-CHECK] ⚠ 解压 snapshot 失败: %v", err)
		UpdateSplash(splash, 1, StepRunning, "恢复失败，建议重新安装")
		return
	}

	// 3. 重新生成 .fingerprint（调用 Python）
	regenScript := `
import json, hashlib, os, sys
from datetime import datetime

sp = os.path.join(sys.argv[1], "Lib", "site-packages")
total_files, total_bytes = 0, 0
for root, dirs, files in os.walk(sp):
    for f in files:
        try:
            total_bytes += os.path.getsize(os.path.join(root, f))
            total_files += 1
        except: pass

core_pkgs = ["torch", "transformers", "sentence_transformers", "numpy", "faiss"]
core_hashes = {}
for pkg in core_pkgs:
    init = os.path.join(sp, pkg, "__init__.py")
    if os.path.isfile(init):
        h = hashlib.sha256(open(init,"rb").read()).hexdigest()
        core_hashes[pkg] = h
    else:
        core_hashes[pkg] = ""

fp = {"total_files": total_files, "total_bytes": total_bytes, "core_hashes": core_hashes, "generated_at": datetime.now().isoformat()}
out = os.path.join(sys.argv[1], ".fingerprint")
json.dump(fp, open(out, "w"), indent=2)
print(f"OK: {total_files} files, {total_bytes} bytes")
`
	pythonExe := filepath.Join(appDir, "python", "python.exe")
	cmd := exec.Command(pythonExe, "-c", regenScript, pythonDir)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
	if out, err := cmd.CombinedOutput(); err != nil {
		log.Printf("[ENV-CHECK] ⚠ 重新生成指纹失败: %v (%s)", err, string(out))
	} else {
		log.Printf("[ENV-CHECK] 指纹已重新生成: %s", strings.TrimSpace(string(out)))
	}

	log.Printf("[ENV-CHECK] ✅ 环境已从备份恢复")
	UpdateSplash(splash, 1, StepRunning, "环境已恢复，正在启动...")
	SplashPumpMessages()
}

// countSitePackages 统计 site-packages 目录的文件数和总大小
func countSitePackages(dir string) (int, int64) {
	count := 0
	var totalSize int64
	filepath.Walk(dir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return nil
		}
		if !info.IsDir() {
			count++
			totalSize += info.Size()
		}
		return nil
	})
	return count, totalSize
}

// sha256FileGo 计算文件的 SHA256 哈希（前 1MB，加速启动）
func sha256FileGo(path string) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()

	h := sha256.New()
	// 只读前 1MB（__init__.py 通常很小，加速校验）
	buf := make([]byte, 1024*1024)
	n, _ := f.Read(buf)
	if n > 0 {
		h.Write(buf[:n])
	}
	return fmt.Sprintf("%x", h.Sum(nil))
}

// unzipToDir 解压 zip 文件到指定目录
func unzipToDir(zipPath, destDir string) error {
	r, err := zip.OpenReader(zipPath)
	if err != nil {
		return fmt.Errorf("打开 zip 失败: %w", err)
	}
	defer r.Close()

	for _, f := range r.File {
		fpath := filepath.Join(destDir, f.Name)

		// 安全检查：防止 zip slip
		if !strings.HasPrefix(filepath.Clean(fpath), filepath.Clean(destDir)+string(os.PathSeparator)) {
			continue
		}

		if f.FileInfo().IsDir() {
			os.MkdirAll(fpath, 0755)
			continue
		}

		os.MkdirAll(filepath.Dir(fpath), 0755)

		outFile, err := os.OpenFile(fpath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, f.Mode())
		if err != nil {
			continue // 跳过无法创建的文件
		}

		rc, err := f.Open()
		if err != nil {
			outFile.Close()
			continue
		}

		_, err = io.Copy(outFile, rc)
		outFile.Close()
		rc.Close()
		if err != nil {
			continue
		}
	}
	return nil
}
