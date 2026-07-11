patch8b
bug清单

1
结束录音失败: NetworkError when attempting to fetch resource.

2

🔄 转写中 0%

一直卡在这里不转写



3 

实时预览不到转写效果



4

播放录音时候

![image-20260521221220910](C:\Users\slow\AppData\Roaming\Typora\typora-user-images\image-20260521221220910.png)

00:00                Infinity:NaN



5转写页面时候点击生成纪要提示，加载模型后也是这样

⚠ 请先在「设置」页面加载 AI 模型，才能生成纪要

6

点击录音下面的纠错

请先在设置中加载 AI 模型，才能使用纠错润色功能
加载了模型也是这样

7

设置tab

展开高级设置后，滚动条不能继续向下滚动，导致下面内容掉出窗口

8模型队列机制还有问题，输入不进去了

2026-05-21 22:15:38,745 [INFO] [CHAT] stream request: chat=2026-05-21_001.json model=qwen3-8b scene=chat msg_len=20
2026-05-21 22:15:38,749 [INFO] [a7c7a527] === 新请求 === scene=chat override=None msg=你好，请简单介绍一下你自己，用两三句话。
2026-05-21 22:15:38,750 [INFO] [a7c7a527] 分类器结果: text (scene=chat)


[TIMEOUT: 30s无响应]

快速 `qwen3-8b` `17字` `30.0s` `1字/s` 

9

对话tab的右下角停止按钮没有效果

按了也不能真正停止

![image-20260521221653473](C:\Users\slow\AppData\Roaming\Typora\typora-user-images\image-20260521221653473.png)

10

知识库tab

点击加载按钮后，应该是正在加载中，然后就进入页面了，不是那个激活提示

11

摘要依旧有问题

![image-20260521221805050](C:\Users\slow\AppData\Roaming\Typora\typora-user-images\image-20260521221805050.png)

没办法完成摘要



