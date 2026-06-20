# Sidemate Launcher 开发规范

> ⚠️ 本文档是 Launcher 开发的铁律，修改 Go 代码前必读

## 1. 主进程隐藏窗口（CREATE_NO_WINDOW）

**铁律**：所有 `exec.Cmd` 创建处**必须**配置 SysProcAttr 隐藏窗口

```go
cmd.SysProcAttr = &syscall.SysProcAttr{
    HideWindow:    true,
    CreationFlags: 0x08000000, // CREATE_NO_WINDOW
}
```

**适用范围**：
- 主进程：python.exe / ollama.exe（用户不应该看到 cmd 窗口）
- 后台调用：wmic / PowerShell / mklink / kill 命令
- **所有** exec.Cmd 创建处（无一例外）

**用户视角**：只能看到 Splash 启动画面 + 浏览器，不能看到任何 cmd 窗口

---

## 2. 版本号注入 + GUI 子系统（ldflags）

**编译命令**必须用 ldflags 注入版本号 + windowsgui 子系统：

```bash
go build -ldflags "-H windowsgui -X main.AppVersion=v0.9.5" -o Sidemate.exe .
```

**两个 ldflags 都必须**：
- `-H windowsgui`：**铁律！不加会弹 cmd 窗口**（Sidemate.exe 本身是 GUI 应用，不是 console 应用）
- `-X main.AppVersion=v0.9.5`：版本号注入

**不要硬编码版本号到 main.go**（虽然 `var AppVersion = "v0.9.5"` 是默认兜底）

**版本来源**：`server/config.py` 的 `version` 字段是权威

---

## 3. 环境完整性检查（checkAndRepairEnv）

**性能要求**：必须 < 1 秒（启动期间不能卡）

**当前策略**：
- ❌ 不做全量文件遍历（countSitePackages，39043 文件太慢）
- ✅ 只做核心包 SHA256 校验（5 个包，前 1MB，毫秒级）
- ✅ 失败才走 restoreFromSnapshot

**如果未来需要更严格的校验**：用异步方式，不阻塞主启动流程

---

## 4. 启动流程顺序

1. Splash 启动画面
2. GPU 检测 + OLLAMA_LLM_LIBRARY 设置
3. 环境指纹校验（< 1 秒）
4. 硬链接备份初始化（首次启动）
5. Ollama 启动（隐藏窗口）
6. FastAPI（python.exe）启动（隐藏窗口）
7. 看门狗 goroutine 启动
8. 浏览器打开

---

## 5. 重新编译命令

每次改 Launcher Go 代码后，必须重新编译：

```bash
cd C:\Sidemate\launcher
go build -ldflags "-X main.AppVersion=v0.9.5" -o Sidemate.exe .
```

验证编译成功 + Sidemate.exe 大小 ~9.6MB
