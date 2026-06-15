# 桌伴 Sidemate — 源码仓库

## 仓库结构

```
C:\Sidemate\           ← git 仓库 = 工作区 = 测试环境
├── .git/               ← 版本管理（只管源码，~4MB）
├── .gitignore          ← 排除运行时资产 + 用户数据
│
│   ====== 以下进 git（源码） ======
├── server/             ← FastAPI 后端（75 个 .py + static + extensions）
├── launcher/           ← Go Launcher 源码（main.go + splash + tray）
├── installer/          ← 安装辅助脚本（make_snapshot.py）
├── docs/               ← 架构文档 + 计划文档
├── setup.iss           ← Inno Setup 脚本（精简包）
├── setup_full.iss      ← Inno Setup 脚本（全量包）
├── assemble.bat        ← 一键组装打包工作区
├── build_full.py       ← 全量包构建脚本
├── LICENSE             ← 闭源 EULA
├── THIRD-PARTY-NOTICES ← 第三方许可声明
├── requirements_gen.txt← 依赖生成脚本
├── logo.ico            ← 应用图标
│
│   ====== 以下不进 git（运行时资产，真身在本目录） ======
├── python/             ← 嵌入式 Python + site-packages（~1.3GB）
├── models/             ← 模型文件（LLM+Embedding+Reranker，~4.4GB）
├── lib/                ← Ollama 运行时 DLL（Vulkan/CPU，~133MB）
├── server/models → Junction → models/（代码路径兼容）
├── ollama.exe          ← Ollama 引擎（~35MB）
├── Sidemate.exe        ← Go 编译产物（~6.5MB）
├── backup/             ← site_packages.zip 等环境快照
└── server/data/        ← 用户数据（chats/kb/logs，运行时生成）
```

## 日常开发

```bash
# 改 server/*.py 后，重启 Sidemate.exe 即可生效
# 改 launcher/*.go 后，需要重新编译：
cd launcher && go build -o ..\Sidemate.exe .

# 提交代码
git add -A && git commit -m "描述改了什么"
```

## 打包发版

```bash
# 方法一：直接在仓库目录跑 ISS
# （适合快速验证，运行时资产都在）
ISCC.exe setup.iss

# 方法二：组装干净的工作区再打包
# （适合正式发版，确保不含脏数据）
assemble.bat
# → 会在 C:\tmp\_Sidemate_build\ 创建干净副本
# → 然后用 ISCC 编译该目录下的 setup.iss
```

## 版本历史

| 版本 | 说明 |
|------|------|
| v0.9.4 | Patch4 基线：依赖安全网 + ISS 安装脚本 + 环境自恢复 + 商业合规 |
