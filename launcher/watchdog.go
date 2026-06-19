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
	wdCheckInterval = 30 * time.Second // 健康检查间隔
	wdHTTPTimeout   = 15 * time.Second // HTTP 健康检查超时
	wdFailThreshold = 3                // 连续失败次数阈值（达到后才重启）
	wdMaxRestarts   = 3                // 每小时最大重启次数
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
	logPath := filepath.Join(appDir, "server", "data", "logs", "launcher.log")

	wd := &Watchdog{
		cfg:           cfg,
		pythonProc:    pythonProc,
		ollamaProc:    ollamaProc,
		logFile:       logPath,
		restartTimes:  make([]time.Time, 0),
		newPythonCmd:  pythonRebuilder,
		newOllamaCmd:  ollamaRebuilder,
	}

	wd.log("INFO", "WATCHDOG", "看门狗已启动（间隔30s, 阈值3次, 上限3次/小时）")

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
	pythonOK := wd.healthCheck(pythonURL)

	if pythonOK {
		if wd.pythonFailCnt > 0 {
			wd.log("INFO", "WATCHDOG", fmt.Sprintf("Python 健康恢复（清除 %d 次失败计数）", wd.pythonFailCnt))
		}
		wd.pythonFailCnt = 0
	} else {
		wd.pythonFailCnt++
		wd.log("WARN", "WATCHDOG", fmt.Sprintf("Python 健康检查失败 %d/%d", wd.pythonFailCnt, wdFailThreshold))

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

	// ---- 检查 Ollama ----
	ollamaURL := fmt.Sprintf("http://%s:%d/api/tags", wd.cfg.OllamaHost, wd.cfg.OllamaPort)
	ollamaOK := wd.healthCheck(ollamaURL)

	if ollamaOK {
		if wd.ollamaFailCnt > 0 {
			wd.log("INFO", "WATCHDOG", fmt.Sprintf("Ollama 健康恢复（清除 %d 次失败计数）", wd.ollamaFailCnt))
		}
		wd.ollamaFailCnt = 0
	} else {
		wd.ollamaFailCnt++
		wd.log("WARN", "WATCHDOG", fmt.Sprintf("Ollama 健康检查失败 %d/%d", wd.ollamaFailCnt, wdFailThreshold))

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

// healthCheck HTTP 健康检查
// 返回 true 表示健康（HTTP 200），false 表示不健康
func (wd *Watchdog) healthCheck(url string) bool {
	client := &http.Client{Timeout: wdHTTPTimeout}
	resp, err := client.Get(url)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	// 读取并丢弃 body，释放连接
	io.ReadAll(resp.Body)
	return resp.StatusCode == http.StatusOK
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
