// hardlink.go — 依赖硬链接恢复（双副本 + mklink /H）
// 功能：
//   - setupHardlinkBackup：创建 site_packages_bak/ 硬链接副本（首次启动/安装时）
//   - verifyAndRepair：从 _bak 恢复损坏包到原目录
//
// 硬链接特性：
//   - 同一 inode，零额外磁盘空间（两个目录项指向同一文件数据）
//   - NTFS 原生支持，用户级操作（无需管理员权限）
//   - 删除其中一个硬链接不影响另一个
package main

import (
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
)

// mklinkRetries mklink 失败时的重试次数
const mklinkRetries = 2

// setupHardlinkBackup 创建 site-packages 的硬链接备份副本
// 参数：
//   - sitePackagesDir：原 site-packages 目录路径（如 python/Lib/site-packages）
//
// 行为：
//  1. 创建 <parent>/site_packages_bak/ 目录（与原目录同级）
//  2. 如果 _bak 已存在且非空，跳过（避免重复创建）
//  3. 遍历原目录所有文件，用 mklink /H 创建硬链接到 _bak
//  4. 硬链接保持相对子目录结构
//
// 返回 error 表示失败
func setupHardlinkBackup(sitePackagesDir string) error {
	parentDir := filepath.Dir(sitePackagesDir)
	dirName := filepath.Base(sitePackagesDir)
	bakDir := filepath.Join(parentDir, dirName+"_bak")

	// 检查 _bak 是否已存在且非空（避免重复创建）
	if info, err := os.Stat(bakDir); err == nil && info.IsDir() {
		// 检查是否非空
		entries, err := os.ReadDir(bakDir)
		if err == nil && len(entries) > 0 {
			log.Printf("[HARDLINK] _bak 目录已存在且非空，跳过备份创建: %s", bakDir)
			return nil
		}
	}

	log.Printf("[HARDLINK] 开始创建硬链接备份: %s → %s", sitePackagesDir, bakDir)

	// 创建 _bak 目录
	if err := os.MkdirAll(bakDir, 0755); err != nil {
		return fmt.Errorf("创建备份目录失败: %w", err)
	}

	// 统计
	totalFiles := 0
	linkedFiles := 0
	failedFiles := 0

	// 遍历原目录，创建硬链接
	err := filepath.Walk(sitePackagesDir, func(srcPath string, info os.FileInfo, err error) error {
		if err != nil {
			return nil // 跳过无法访问的文件
		}

		relPath, err := filepath.Rel(sitePackagesDir, srcPath)
		if err != nil {
			return nil
		}

		if relPath == "." {
			return nil // 跳过根目录本身
		}

		dstPath := filepath.Join(bakDir, relPath)

		if info.IsDir() {
			// 创建对应子目录
			if err := os.MkdirAll(dstPath, 0755); err != nil {
				log.Printf("[HARDLINK] ⚠ 创建目录失败: %s (%v)", dstPath, err)
			}
			return nil
		}

		// 跳过符号链接（避免循环）
		if info.Mode()&os.ModeSymlink != 0 {
			return nil
		}

		totalFiles++

		// 创建硬链接：mklink /H <dst> <src>
		if err := createHardlink(srcPath, dstPath); err != nil {
			failedFiles++
			// 硬链接失败不致命（可能是跨卷、权限等），记录警告
			log.Printf("[HARDLINK] ⚠ 硬链接失败: %s → %s (%v)", srcPath, dstPath, err)
		} else {
			linkedFiles++
		}

		return nil
	})

	if err != nil {
		return fmt.Errorf("遍历目录失败: %w", err)
	}

	log.Printf("[HARDLINK] ✅ 硬链接备份完成: %d 文件链接成功, %d 失败 (共 %d)", linkedFiles, failedFiles, totalFiles)
	return nil
}

// verifyAndRepair 从 _bak 恢复损坏的包到原 site-packages 目录
// 参数：
//   - sitePackagesDir：原 site-packages 目录路径
//   - brokenPkgs：损坏的包名列表（如 ["torch", "numpy"]）
//
// 返回 (成功数, 失败数, error)
func verifyAndRepair(sitePackagesDir string, brokenPkgs []string) error {
	parentDir := filepath.Dir(sitePackagesDir)
	dirName := filepath.Base(sitePackagesDir)
	bakDir := filepath.Join(parentDir, dirName+"_bak")

	// 检查 _bak 是否存在
	if _, err := os.Stat(bakDir); err != nil {
		return fmt.Errorf("备份目录不存在: %s", bakDir)
	}

	repairedCount := 0
	failedCount := 0

	for _, pkg := range brokenPkgs {
		pkg = strings.TrimSpace(pkg)
		if pkg == "" {
			continue
		}

		// 损坏包的源路径（_bak 中）和目标路径（原目录）
		bakPkgDir := filepath.Join(bakDir, pkg)
		origPkgDir := filepath.Join(sitePackagesDir, pkg)

		log.Printf("[HARDLINK] 恢复包: %s", pkg)

		// 检查 _bak 中是否有该包
		if _, err := os.Stat(bakPkgDir); err != nil {
			log.Printf("[HARDLINK] ⚠ _bak 中不存在包: %s", pkg)
			failedCount++
			continue
		}

		// 删除原目录中损坏的包
		_ = os.RemoveAll(origPkgDir)

		// 从 _bak 恢复（遍历 _bak/pkg 创建硬链接到原目录）
		ok, fail := repairPackage(bakPkgDir, origPkgDir)
		repairedCount += ok
		failedCount += fail

		if fail > 0 {
			log.Printf("[HARDLINK] ⚠ 包 %s 部分恢复失败 (%d/%d)", pkg, ok, ok+fail)
		} else {
			log.Printf("[HARDLINK] ✅ 包 %s 已恢复 (%d 文件)", pkg, ok)
		}
	}

	log.Printf("[HARDLINK] 恢复完成: %d 包成功, %d 包失败", repairedCount, failedCount)
	return nil
}

// repairPackage 从备份路径恢复单个包（创建硬链接）
// 返回 (成功数, 失败数)
func repairPackage(bakPkgDir, origPkgDir string) (int, int) {
	okCount := 0
	failCount := 0

	filepath.Walk(bakPkgDir, func(bakPath string, info os.FileInfo, err error) error {
		if err != nil {
			failCount++
			return nil
		}

		relPath, err := filepath.Rel(bakPkgDir, bakPath)
		if err != nil {
			return nil
		}

		if relPath == "." {
			return nil
		}

		dstPath := filepath.Join(origPkgDir, relPath)

		if info.IsDir() {
			os.MkdirAll(dstPath, 0755)
			return nil
		}

		// 跳过符号链接
		if info.Mode()&os.ModeSymlink != 0 {
			return nil
		}

		if err := createHardlink(bakPath, dstPath); err != nil {
			failCount++
			log.Printf("[HARDLINK] ⚠ 恢复硬链接失败: %s → %s (%v)", bakPath, dstPath, err)
		} else {
			okCount++
		}
		return nil
	})

	return okCount, failCount
}

// createHardlink 使用 Windows mklink /H 创建硬链接
// 命令：cmd /c mklink /H <link> <target>
//
// 注意：
//   - mklink /H 中，<link> 是新建的硬链接路径，<target> 是已存在的源文件
//   - 硬链接必须在同一卷（NTFS），跨卷会失败
//   - 不需要管理员权限（硬链接是用户级操作）
func createHardlink(target, link string) error {
	var lastErr error

	for attempt := 0; attempt < mklinkRetries; attempt++ {
		// 确保目标目录存在
		os.MkdirAll(filepath.Dir(link), 0755)

		// 如果 link 已存在，先删除（覆盖）
		if _, err := os.Stat(link); err == nil {
			_ = os.Remove(link)
		}

		cmd := exec.Command("cmd", "/c", "mklink", "/H", link, target)
		cmd.SysProcAttr = &syscall.SysProcAttr{
			HideWindow:    true,
			CreationFlags: 0x08000000, // CREATE_NO_WINDOW
		}
		output, err := cmd.CombinedOutput()
		if err == nil {
			return nil
		}
		lastErr = fmt.Errorf("mklink 失败 (尝试 %d): %w (%s)", attempt+1, err, strings.TrimSpace(string(output)))
	}

	return lastErr
}
