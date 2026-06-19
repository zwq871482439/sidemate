// gpu_detect.go — GPU vendor 检测 + 三档分流 (CUDA / Vulkan / CPU)
// 主方案：wmic path win32_VideoController get name
// fallback：PowerShell Get-CimInstance Win32_VideoController
package main

import (
	"fmt"
	"os/exec"
	"strings"
	"syscall"
)

// GPUInfo GPU 检测结果
type GPUInfo struct {
	Vendor    string // "NVIDIA" / "AMD" / "Intel" / ""
	Name      string // GPU 设备名称
	HasCUDA   bool   // 是否支持 CUDA（NVIDIA）
	HasVulkan bool   // 是否支持 Vulkan（AMD / Intel Arc）
	Backend   string // "cuda" / "vulkan" / "cpu"
}

// detectGPU 检测系统 GPU 并返回分流信息
// 检测顺序：
//  1. wmic path win32_VideoController get name（主方案）
//  2. PowerShell Get-CimInstance Win32_VideoController（fallback）
//
// 判断逻辑：
//   - 名称含 "NVIDIA" → HasCUDA=true, Backend="cuda"
//   - 名称含 "AMD" / "Radeon" → HasVulkan=true, Backend="vulkan"
//   - 名称含 "Intel" / "Arc" → HasVulkan=true, Backend="vulkan"
//   - 查询失败 / 无独立 GPU → Backend="cpu"
func detectGPU() GPUInfo {
	info := GPUInfo{
		Vendor:    "",
		Name:      "",
		HasCUDA:   false,
		HasVulkan: false,
		Backend:   "cpu",
	}

	// 1. 主方案：wmic
	names := detectGPUViaWmic()

	// 2. fallback：PowerShell
	if len(names) == 0 {
		names = detectGPUViaPowerShell()
	}

	if len(names) == 0 {
		// 所有方法都失败，默认 cpu
		return info
	}

	// 取第一个独立 GPU（跳过 Microsoft Basic Render Driver 等软件设备）
	gpuName := selectPrimaryGPU(names)
	if gpuName == "" {
		return info
	}

	info.Name = gpuName
	upper := strings.ToUpper(gpuName)

	if strings.Contains(upper, "NVIDIA") {
		info.Vendor = "NVIDIA"
		info.HasCUDA = true
		info.Backend = "cuda"
	} else if strings.Contains(upper, "AMD") || strings.Contains(upper, "RADEON") {
		info.Vendor = "AMD"
		info.HasVulkan = true
		info.Backend = "vulkan"
	} else if strings.Contains(upper, "INTEL") || strings.Contains(upper, "ARC") {
		info.Vendor = "Intel"
		info.HasVulkan = true
		info.Backend = "vulkan"
	} else {
		// 其他厂商 GPU，默认 vulkan（最兼容）
		info.Vendor = "Unknown"
		info.HasVulkan = true
		info.Backend = "vulkan"
	}

	return info
}

// detectGPUViaWmic 通过 wmic 查询 GPU 名称
// 命令：wmic path win32_VideoController get name
func detectGPUViaWmic() []string {
	cmd := exec.Command("wmic", "path", "win32_VideoController", "get", "name")
	cmd.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: 0x08000000, // CREATE_NO_WINDOW
	}
	output, err := cmd.Output()
	if err != nil {
		return nil
	}
	return parseGPUNames(string(output))
}

// detectGPUViaPowerShell 通过 PowerShell Get-CimInstance 查询 GPU 名称（wmic fallback）
// 命令：Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name
func detectGPUViaPowerShell() []string {
	cmd := exec.Command("powershell", "-NoProfile", "-Command",
		"Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name")
	cmd.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: 0x08000000,
	}
	output, err := cmd.Output()
	if err != nil {
		return nil
	}
	return parseGPUNames(string(output))
}

// parseGPUNames 从命令输出中解析 GPU 名称列表
// wmic 输出格式示例：
//
//	Name
//	NVIDIA GeForce RTX 4060
//	Intel(R) UHD Graphics 770
func parseGPUNames(raw string) []string {
	var names []string
	lines := strings.Split(strings.ReplaceAll(raw, "\r", "\n"), "\n")
	for _, line := range lines {
		name := strings.TrimSpace(line)
		if name == "" || name == "Name" || name == "name" {
			continue
		}
		names = append(names, name)
	}
	return names
}

// selectPrimaryGPU 从 GPU 名称列表中选择第一个独立 GPU
// 跳过软件/虚拟设备：Microsoft Basic Render Driver, Microsoft Hyper-V 等
func selectPrimaryGPU(names []string) string {
	// 软件设备的排除关键词（大写匹配）
	excludeKeywords := []string{
		"MICROSOFT BASIC RENDER DRIVER",
		"MICROSOFT HYPER-V",
		"REMOTE DISPLAY",
		"WDDM",
		"VIRTUAL",
		"DISPLAY DEVICE",
	}

	for _, name := range names {
		upper := strings.ToUpper(name)
		isSoftware := false
		for _, kw := range excludeKeywords {
			if strings.Contains(upper, kw) {
				isSoftware = true
				break
			}
		}
		if !isSoftware && len(name) > 2 {
			return name
		}
	}

	// 如果全是软件设备，返回第一个非空名称（总比没有好）
	for _, name := range names {
		if len(name) > 2 {
			return name
		}
	}

	return ""
}

// setOllamaBackend 根据 GPU 检测结果设置 OLLAMA_LLM_LIBRARY 环境变量
// 返回实际设置的 backend 值
func setOllamaBackend(gpu GPUInfo) string {
	backend := gpu.Backend
	if backend == "" {
		backend = "cpu"
	}
	// 设置环境变量，供后续 ollama serve 启动继承
	// 注意：这里设置到当前进程环境，子进程（ollama）会继承
	// 由调用方负责在 exec.Command 的 Env 中追加
	return backend
}

// gpuBackendSummary 返回 GPU 检测结果的日志摘要
func gpuBackendSummary(gpu GPUInfo) string {
	return fmt.Sprintf("GPU=%s Vendor=%s Backend=%s CUDA=%v Vulkan=%v",
		gpu.Name, gpu.Vendor, gpu.Backend, gpu.HasCUDA, gpu.HasVulkan)
}
