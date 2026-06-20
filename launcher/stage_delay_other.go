//go:build !windows

package main

import "time"

// stageMinDelay non-Windows 版本（无 splash，仅延迟）
func stageMinDelay(start time.Time, min time.Duration) {
	elapsed := time.Since(start)
	if elapsed < min {
		time.Sleep(min - elapsed)
	}
}
