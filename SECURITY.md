# 安全问题报告 / Security policy

## 怎么报告

发现安全问题（比如本机文件被别的程序读到、API key 出现在日志或界面上、拖进来的材料被发到别的地方），**请不要开公开 issue**。请发邮件到 **hello@deskware.cn**，写清楚：

- 用的版本（安装包里的版本号，比如 0.2.0）和运行方式（安装的 exe / 从源码运行）；
- 怎么复现；
- 你认为会造成什么影响。

我们会在 7 天内回复，修好后在更新说明里致谢（你不想署名就不写）。

## 支持的版本

只修最新发布的版本。

## 设计上的边界

- 桌伴没有账号和服务器，也不监听任何端口。
- `~/桌伴/key.bin` 里的 key 用系统加密存着（Windows 上是 DPAPI），别的用户、别的程序读不到。程序只在起任务时把它放进后台进程的环境变量，不写进日志（见 [PRIVACY.md](PRIVACY.md)）。
- 能在这台电脑上跑程序的人，本来就能读你的 `~/桌伴/` 和 `%APPDATA%\sidemate\` 目录，所以「本机另一个程序读你的工作区」不算漏洞。
- 干活时把任务内容发给 DeepSeek 是产品本身的用途，见 [PRIVACY.md](PRIVACY.md) 的「什么时候会联网」一节。

---

Please **do not open a public issue** for security problems. Report them by email to **hello@deskware.cn** instead, with the version, the steps to reproduce and the impact you expect. We reply within 7 days and credit you in the release notes unless you prefer to stay anonymous.

Only the latest release is supported. Sidemate has no accounts and no server and listens on no port. The API key in `~/桌伴/key.bin` is encrypted with the system key store (DPAPI on Windows) and is only placed in the background process's environment when a task starts; it is never logged. Anyone who can run programs on this computer can already read your `~/桌伴/` and `%APPDATA%\sidemate\` folders, so "another local program can read the workspace" is not treated as a vulnerability. Sending task content to DeepSeek while working is the product's documented behaviour; see [PRIVACY.md](PRIVACY.md).
