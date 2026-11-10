# 桌伴 Sidemate

桌伴是 Windows 桌面上的一个小帮手：把几份材料拖给它，它照你给的范本写一份文件，并在 Word 批注里标出处。

它贴在屏幕顶边，平时只露一双眼睛。没有账号，没有服务器，也不收集使用数据；你的 DeepSeek key 加密存在这台电脑上。

## 能做什么

- **照范本写新文件**：给一份旧的周报、总结或汇报当范本，再给几份材料，它按范本的字体、层级、段距写出一份新的 Word。
- **每句标出处**：从材料里写进来的话，在 Word 批注里标出是哪个文件第几页。
- **写得像样**：自带「写作」和「写 Word」两个技能。材料里没有的承诺不会悄悄写进正文，会在回话里单列出来请你确认。
- **原件不动**：它先把文件拷一份到自己的工作区再干活，产出放进「桌伴输出」文件夹。

## 安装

1. 从 [Releases](https://github.com/zwq871482439/sidemate/releases) 下载 `sidemate-setup-0.2.0.exe`，双击安装。安装包没有签名，Windows 弹出提示时，点「更多信息」，再点「仍要运行」。
2. 第一次打开时贴上你的 DeepSeek API key，点「测一下」，显示「通了」就可以用了。

需要自己的 DeepSeek API key：在 [DeepSeek 开放平台](https://platform.deepseek.com/) 申请。

## 隐私

桌伴没有账号和服务器，不收集使用数据。任务内容只发给你指定的 DeepSeek 接口。你的 key 用系统加密（Windows 上是 DPAPI）存在本机，只在起任务时放进后台程序的环境变量。详见 [PRIVACY.md](PRIVACY.md)。

## 许可

本仓库的代码用 MIT 许可，见 [LICENSE](LICENSE)。随包分发的第三方组件及其许可见 [THIRD-PARTY-NOTICES.txt](THIRD-PARTY-NOTICES.txt)。

## 安全问题

发现安全问题请发邮件 hello@deskware.cn，不要开公开 issue。详见 [SECURITY.md](SECURITY.md)。

---

Sidemate is a small helper on the Windows desktop: drop a few files on it, and it writes a document that follows your template, with sources noted as Word comments.

See [README.en.md](README.en.md) for the English version.
