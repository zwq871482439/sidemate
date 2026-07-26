// watchdog.go — 进程健康监测 + 自动重启
// 功能：
//   - 每 30s 对 Python FastAPI 和 Ollama 做 HTTP 健康检查
//   - 连续 3 次失败才重启（避免偶发卡顿误判）
//   - 重启上限：3 次/小时（滑动窗口计数）
//   - 日志写入 server/data/logs/launcher.log
//   - 独立 goroutine 运行，不阻塞主进程
package main

import (
	"context"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"time"
)

// cmdRebuilder 重建进程命令的闭包类型（重启时使用）
type cmdRebuilder func() (*exec.Cmd, context.CancelFunc)

// 看门狗常量
const (
	wdCheckInterval = 30 * time.Second // 健康检查间隔（P7-4：10s→30s，减少推理期间的误报）
	wdHTTPTimeout   = 10 * time.Second // HTTP 健康检查超时（P7-4：5s→10s，给模型推理留余量）
	wdFailThreshold = 2                // 连续失败次数阈值
	wdMaxRestarts   = 3                // 每小时最大重启次数（仅 Python 后端，模型服务由 Python 自管）
	wdRestartWindow = 1 * time.Hour    // 滑动窗口大小
	wdRestartDelay  = 2 * time.Second  // 重启前等待（让端口释放）
)

// Watchdog 看门狗状态
type Watchdog struct {
	mu            sync.Mutex      // 互斥锁，保护并发重启
	cfg           *Config         // 应用配置
	pythonProc    *ManagedProcess // Python FastAPI 进程
	ollamaProc    *ManagedProcess // Ollama 进程
	logFile       string          // 日志文件路径
	pythonFailCnt int             // Python 连续失败计数
	ollamaFailCnt int             // Ollama 连续失败计数
	modelDown     bool            // 模型服务处于不可用状态（已记录日志，避免刷屏）
	restartTimes  []time.Time     // 重启时间戳列表（滑动窗口计数）
	newPythonCmd  cmdRebuilder    // 重建 Python 命令的闭包
	newOllamaCmd  cmdRebuilder    // 重建 Ollama 命令的闭包
}

// startWatchdog 启动看门狗 goroutine
// 参数：
//   - cfg：应用配置
//   - pythonProc：Python FastAPI 进程（ManagedProcess 包装）
//   - ollamaProc：Ollama 进程
//   - pythonRebuilder：重建 Python 命令的闭包（重启时用）
//   - ollamaRebuilder：重建 Ollama 命令的闭包（重启时用）
//   - ctx：上下文，监听 ctx.Done() 优雅退出
func startWatchdog(
	cfg *Config,
	pythonProc *ManagedProcess,
	ollamaProc *ManagedProcess,
	pythonRebuilder cmdRebuilder,
	ollamaRebuilder cmdRebuilder,
	ctx context.Context,
) {
	exePath, _ := os.Executable()
	appDir := filepath.Dir(exePath)
	logPath := filepath.Join(appDir, "data", "logs", "launcher.log")

	wd := &Watchdog{
		cfg:           cfg,
		pythonProc:    pythonProc,
		ollamaProc:    ollamaProc,
		logFile:       logPath,
		restartTimes:  make([]time.Time, 0),
		newPythonCmd:  pythonRebuilder,
		newOllamaCmd:  ollamaRebuilder,
	}

	wd.log("INFO", "WATCHDOG", fmt.Sprintf("看门狗已启动（间隔%v, 阈值%d次, 上限%d次/小时）", wdCheckInterval, wdFailThreshold, wdMaxRestarts))

	ticker := time.NewTicker(wdCheckInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			wd.log("INFO", "WATCHDOG", "收到退出信号，看门狗停止")
			return
		case <-ticker.C:
			wd.runCheckCycle()
		}
	}
}

// runCheckCycle 执行一轮健康检查
func (wd *Watchdog) runCheckCycle() {
	wd.mu.Lock()
	defer wd.mu.Unlock()

	// ---- 检查 Python ----
	pythonURL := fmt.Sprintf("http://127.0.0.1:%d/api/status", wd.cfg.ServerPort)
	pythonOK, pythonDetail := wd.healthCheckDeep(pythonURL, "python")

	if pythonOK {
		if wd.pythonFailCnt > 0 {
			wd.log("INFO", "WATCHDOG", fmt.Sprintf("Python 健康恢复（清除 %d 次失败计数）", wd.pythonFailCnt))
		}
		wd.pythonFailCnt = 0
		// 周期性心跳日志（每 6 轮 = 60s 输出一次，避免日志爆炸）
		if time.Now().Unix()%60 < 10 {
			wd.log("INFO", "WATCHDOG", fmt.Sprintf("[心跳] Python=OK(%s) Ollama 检查中...", pythonDetail))
		}
	} else {
		wd.pythonFailCnt++
		wd.log("WARN", "WATCHDOG", fmt.Sprintf("Python 健康检查失败 %d/%d (%s)", wd.pythonFailCnt, wdFailThreshold, pythonDetail))

		if wd.pythonFailCnt >= wdFailThreshold {
			if wd.canRestart() {
				wd.log("ERROR", "WATCHDOG", fmt.Sprintf("Python 连续失败 %d 次，触发重启", wd.pythonFailCnt))
				err := wd.restartProcess("Python", wd.pythonProc, wd.newPythonCmd)
				if err != nil {
					wd.log("ERROR", "WATCHDOG", fmt.Sprintf("Python 重启失败: %v", err))
				} else {
					wd.log("INFO", "WATCHDOG", "Python 重启成功")
					wd.recordRestart()
				}
			} else {
				wd.log("WARN", "WATCHDOG", fmt.Sprintf("Python 重启次数已达上限 %d 次/小时，跳过重启", wdMaxRestarts))
			}
			wd.pythonFailCnt = 0
		}
	}

	// ---- 检查 llama-server（P7-4: /api/tags → /v1/models）----
	// P7-4 架构：llama-server 由 Python 后端管理（ollamaProc=nil），
	// Go watchdog 只做被动健康监测——不重启、不计数、不刷屏。
	// 模型服务的自动恢复由 Python 侧 LlamaCppManager.watchdog 负责。
	ollamaURL := fmt.Sprintf("http://%s:%d/v1/models", wd.cfg.OllamaHost, wd.cfg.OllamaPort)
	ollamaOK, ollamaDetail := wd.healthCheckDeep(ollamaURL, "llama-server")

	if ollamaOK {
		if wd.modelDown {
			// 状态变化：不可用 → 恢复，记一条
			wd.log("INFO", "WATCHDOG", "模型服务已恢复")
			wd.modelDown = false
		}
		wd.ollamaFailCnt = 0
	} else {
		if wd.ollamaProc == nil {
			// P7-4：模型服务由 Python 管理，Go 只记录不处理。
			// 只在状态变化（可用 → 不可用）时记一条，持续不可用不重复刷日志。
			wd.ollamaFailCnt++
			if wd.ollamaFailCnt >= wdFailThreshold {
				if !wd.modelDown {
					wd.log("INFO", "WATCHDOG", "模型服务暂时不可用（Python 后端管理，等待自动恢复）")
					wd.modelDown = true
				}
				wd.ollamaFailCnt = 0
			}
		} else {
			// 非 P7-4 架构（ollamaProc 不为空）：原有的重启逻辑
			wd.ollamaFailCnt++
			wd.log("WARN", "WATCHDOG", fmt.Sprintf("Ollama 健康检查失败 %d/%d (%s)", wd.ollamaFailCnt, wdFailThreshold, ollamaDetail))
			if wd.ollamaFailCnt >= wdFailThreshold {
				if wd.canRestart() {
					wd.log("ERROR", "WATCHDOG", fmt.Sprintf("Ollama 连续失败 %d 次，触发重启", wd.ollamaFailCnt))
					err := wd.restartProcess("Ollama", wd.ollamaProc, wd.newOllamaCmd)
					if err != nil {
						wd.log("ERROR", "WATCHDOG", fmt.Sprintf("Ollama 重启失败: %v", err))
					} else {
						wd.log("INFO", "WATCHDOG", "Ollama 重启成功")
						wd.recordRestart()
					}
				} else {
					wd.log("WARN", "WATCHDOG", fmt.Sprintf("Ollama 重启次数已达上限 %d 次/小时，跳过重启", wdMaxRestarts))
				}
				wd.ollamaFailCnt = 0
			}
		}
	}
}

// healthCheckDeep 深度健康检查（Patch5 P0）
// 不仅检查 HTTP 200，还校验响应体关键字段，避免端口残留导致的误判。
// 返回：(是否健康, 详细信息字符串)
func (wd *Watchdog) healthCheckDeep(url string, kind string) (bool, string) {
	client := &http.Client{Timeout: wdHTTPTimeout}
	resp, err := client.Get(url)
	if err != nil {
		return false, "连接失败: " + err.Error()
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 8192)) // 最多读 8KB
	if err != nil {
		return false, fmt.Sprintf("HTTP %d，读 body 失败: %v", resp.StatusCode, err)
	}
	bodyStr := string(body)

	if resp.StatusCode != http.StatusOK {
		return false, fmt.Sprintf("HTTP %d", resp.StatusCode)
	}

	// 深度校验响应体（避免端口残留 + 服务实际已死的情况）
	switch kind {
	case "ollama":
		// /api/tags 健康响应必须含 "models" 字段（即使是空数组也行）
		if !contains(bodyStr, "models") {
			return false, "HTTP 200 但响应体异常（无 models 字段）"
		}
	case "llama-server":
		// P7-4: /v1/models 响应含 "data" 字段
		if !contains(bodyStr, "data") {
			return false, "HTTP 200 但响应体异常（无 data 字段）"
		}
	case "python":
		// /api/status 健康响应必须含 "version" 字段
		if !contains(bodyStr, "version") {
			return false, "HTTP 200 但响应体异常（无 version 字段）"
		}
	}

	return true, fmt.Sprintf("HTTP %d, body=%dB", resp.StatusCode, len(body))
}

// contains 字符串包含检查（避免引入 strings 包）
func contains(s, substr string) bool {
	return len(s) >= len(substr) && (s == substr || indexOf(s, substr) >= 0)
}

func indexOf(s, substr string) int {
	for i := 0; i <= len(s)-len(substr); i++ {
		if s[i:i+len(substr)] == substr {
			return i
		}
	}
	return -1
}

// canRestart 检查是否还可以重启（滑动窗口计数）
// 在最近 1 小时内的重启次数不超过 wdMaxRestarts
func (wd *Watchdog) canRestart() bool {
	now := time.Now()
	cutoff := now.Add(-wdRestartWindow)

	// 清理过期记录
	valid := wd.restartTimes[:0]
	for _, t := range wd.restartTimes {
		if t.After(cutoff) {
			valid = append(valid, t)
		}
	}
	wd.restartTimes = valid

	return len(wd.restartTimes) < wdMaxRestarts
}

// recordRestart 记录一次重启时间戳
func (wd *Watchdog) recordRestart() {
	wd.restartTimes = append(wd.restartTimes, time.Now())
}

// restartProcess 重启指定进程
// 步骤：Stop 旧进程 → 等待端口释放 → 创建新命令 → Start
func (wd *Watchdog) restartProcess(name string, proc *ManagedProcess, rebuilder cmdRebuilder) error {
	wd.log("INFO", "WATCHDOG", fmt.Sprintf("正在停止 %s...", name))
	proc.Stop()

	wd.log("INFO", "WATCHDOG", fmt.Sprintf("等待 %s 端口释放...", name))
	time.Sleep(wdRestartDelay)

	newCmd, newCancel := rebuilder()
	proc.Cmd = newCmd
	proc.Cancel = newCancel

	wd.log("INFO", "WATCHDOG", fmt.Sprintf("正在启动 %s...", name))
	if err := proc.Start(); err != nil {
		return fmt.Errorf("启动 %s 失败: %w", name, err)
	}
	return nil
}

// log 写入看门狗日志
// 格式：[2026-06-19 23:00:00] [INFO] [WATCHDOG] 消息
func (wd *Watchdog) log(level, module, msg string) {
	logLine := fmt.Sprintf("[%s] [%s] [%s] %s\n",
		time.Now().Format("2006-01-02 15:04:05"), level, module, msg)

	// 确保日志目录存在
	logDir := filepath.Dir(wd.logFile)
	os.MkdirAll(logDir, 0755)

	// 以追加模式写入
	f, err := os.OpenFile(wd.logFile, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
	if err != nil {
		// 日志写入失败不致命，用标准 log 输出
		log.Printf("[WATCHDOG] %s (日志写入失败: %v)", msg, err)
		return
	}
	defer f.Close()
	f.WriteString(logLine)

	// 同时输出到标准 log（launcher.log 已被 main.go 重定向到此文件）
	log.Printf("[WATCHDOG] %s", msg)
}
