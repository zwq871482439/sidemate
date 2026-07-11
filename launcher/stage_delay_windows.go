//go:build windows

package main

import "time"

// stageMinDelay 保证阶段至少停留 min 时长，同时泵送消息让 splash 窗口刷新
func stageMinDelay(start time.Time, min time.Duration) {
	elapsed := time.Since(start)
	if elapsed >= min {
		return
	}
	remaining := min - elapsed
	deadline := time.Now().Add(remaining)
	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()
	for time.Now().Before(deadline) {
		<-ticker.C
		SplashPumpMessages()
	}
}
