# Security Policy — 安全政策

## 报告漏洞 / Reporting a Vulnerability

请勿通过公开 Issue 报告安全漏洞。请发送至：**zwq871482439@vip.qq.com**

Please do **not** report security vulnerabilities via public GitHub issues.
Email: **zwq871482439@vip.qq.com**

请在报告中包含：问题描述、复现步骤、影响范围。我们会在收到后尽快回复。

## 支持版本 / Supported Versions

仅最新版本获得安全更新。请始终保持最新。

Only the latest release receives security fixes.

## 安全设计要点 / Security Notes

- Sidemate 是本地优先应用：对话、文档、知识库数据全部存储在用户本机（安装目录 `data/`）
- 用户配置的在线 API Key 仅保存在本机配置文件中，不会上传到任何第三方（除了用户自己选择的 API 服务商）
- 应用默认仅监听 `127.0.0.1`，不对外暴露网络服务
