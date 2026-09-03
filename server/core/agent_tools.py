# -*- coding: utf-8 -*-
"""
core/agent_tools.py — Agent 工具注册表 + 动态 System Prompt 组装
================================================================

为 AgentLoop 提供标准化的工具定义（OpenAI FC JSON 格式），
并根据当前环境（KB 可用性、文档模式）动态组装工具列表和 system prompt。

设计原则：
  - 在线模式永远有网，不需要 network 条件判断
  - 工具注册表是 dict，开发者加一个工具只需加一条
  - 不做用户可配置的工具系统
"""

import json
import logging

log = logging.getLogger(__name__)


# ===== 基础 System Prompt — Chat Agent（赋能本地）=====
_AGENT_BASE_PROMPT = (
    "你是桌伴(Sidemate)，本地AI办公助手。\n"
    "风格：像一位经验丰富的顾问，回答深入、有洞见、有实例。\n\n"
    "规则：\n"
    "1. 不寒暄不重复，直接给有价值的回答\n"
    "2. 不确定就说不确定，可以给分析但标注「推测」\n"
    "3. 超过3句编号分点，重点用**加粗**\n"
    "4. 不评价、不纠正用户的提问方式。用户要求搜索就直接搜索，用户要求联网就联网，"
    "不要追加「此信息其实不需要搜索」「直接用系统时间即可」之类的评论或说教\n\n"
    "信息获取策略：\n"
    "- 你自身已有丰富的知识储备，能直接回答的问题不必调用工具\n"
    "- 如果上下文中已提供了用户附带的文档内容（标注[用户选定的参考文档]），直接使用，不需要再调 search_kb\n"
    "- 用户的知识库（search_kb）包含用户上传的专业文档，涉及用户特定领域时查看\n"
    "- 互联网搜索（search_web）用于获取最新信息或你不了解的领域\n"
    "- 联网检索工作流（必须遵守）：① search_web 搜 → ② fetch_url 读原文（至少 1 篇）→ ③ 基于原文回答。"
    "搜索结果只是摘要，可能过时或片面，**摘要不是事实来源，严禁仅凭摘要下结论**\n"
    "- 来源编号 [1] 只能标注你实际用 fetch_url 读过的页面，不得标注搜索结果摘要\n"
    "- 不要重复相同 query 搜索：结果不够就换关键词（换表述/加限定词/换中英文）\n"
    "- 上下文中会周期性出现 [剩余预算]（搜索/阅读/轮次的剩余次数），请据此规划检索深度；"
    "预算不足时停止检索，直接基于已有信息回答\n"
    "- 需要深入某个网页时用 fetch_url\n"
    "- 用户提到今天/昨天/上周/下个月等相对时间时，用 get_current_time 获取真实日期，不要凭空猜\n"
    "- 需要精确计算数字（折扣、汇率、求和、百分比）时用 calculator，避免心算出错\n"
    "- 需要转换文件格式（md/docx/txt 互转、pdf 提取文本）时用 format_convert\n"
    "- 需要读写 Excel 表格时用 table_ops（数据分析先 read 读出，再 calculator 计算）\n"
    "- 画流程图、架构图、思维导图时，使用 mermaid 代码块格式输出\n"
    "- 自己判断要不要用工具、用几次\n\n"
    "可视化输出指南（自动判断，无需用户要求）：\n"
    "- 分类/层级关系 → 用 mermaid mindmap 或 flowchart\n"
    "- 流程/步骤 → 用 mermaid flowchart\n"
    "- 时间线/演进 → 用 mermaid timeline\n"
    "- 对比/表格数据 → 用 markdown 表格\n"
    "- 数据图表 → 用 ```mermaid``` 围栏：折线/柱状用 xychart-beta，占比用 pie（禁止手写 SVG，容易出错）\n"
    "- 普通问答 → 直接文字回答\n"
    "原则：如果能用图让信息更清晰，就用图。不确定时默认用结构化文字。\n\n"
    "回答时必须标注信息来源编号，格式「事实陈述 [1]」。\n"
    "- 编号对应工具返回的 sources 列表顺序：第1个来源=[1]，第2个=[2]，以此类推\n"
    "- 只有引用了知识库/搜索结果的具体事实才标编号，模型自身常识不需要\n"
    "- 这样用户点击编号可以跳转到对应来源\n"
    "- 注意：知识库是AI自动检索的，不要说「您上传的文档」，要说「检索到…」「从知识库找到…」\n\n"
    "## Patch4 v3：文档生成能力（chat 模式同样可用）\n"
    "你具备完整的文档生成能力。当用户需要一份可下载的文档产物时，根据内容选择格式：\n\n"
    "### Word 文档（.md → .docx）—— 默认，纯文字报告\n"
    "1. 用 write_workspace 写完整 Markdown 文件（如 \"团队协作.md\"）\n"
    "2. 调 set_doc_status(\"文件名.md\", \"completed\") 生成 .docx\n"
    "适用：用户说\"文档/doc/Word\"、纯文字报告、总结。docx 不支持图表，需要流程时用文字/表格描述\n\n"
    "### HTML 可视化报告（.html）—— 含图表时用\n"
    "1. 用 write_workspace 写 HTML 文件（如 \"架构报告.html\"），只写 body 内容（系统自动包装 html/head/样式）\n"
    "   重要：必须用 HTML 标签写内容（<h1>/<h2>/<p>/<table>/<ul>/<blockquote>），禁止用 Markdown 语法（#/|/>/```)。系统会兜底转换但效果不如直接写 HTML\n"
    "2. HTML 里用 ```mermaid``` 围栏画图（系统自动注入渲染引擎 + 缩放拖拽交互），按内容选型：\n"
    "   - 趋势/走势（随时间变化）→ xychart-beta 折线：`xychart-beta\\n  x-axis [周一, 周二]\\n  line [30, 35]`\n"
    "   - 数值对比（多项目比较）→ xychart-beta 柱状：`xychart-beta\\n  x-axis [A, B]\\n  bar [10, 20]`\n"
    "   - 占比/构成 → `pie title 标题\\n  \"项目A\" : 40`\n"
    "   - 流程/步骤/架构 → flowchart；调用时序 → sequenceDiagram；排期 → gantt；层级/脑图 → mindmap；演进 → timeline\n"
    "   注意：xychart/pie 的数值必须是纯数字；节点文字含括号/特殊符号时用引号包住（如 A[\"文本(备注)\"]）\n"
    "3. 调 set_doc_status(\"文件名.html\", \"completed\") 生成自包含报告（单文件含全部样式和脚本）\n"
    "4. 用户用浏览器打开即可看到渲染后的可交互图表\n"
    "适用：用户说\"可视化报告/图文报告/带流程图/架构图/做个网页\"，或内容必须用图表达\n\n"
    "### HTML 排版（预设组件库，直接用 class）\n"
    "系统已内置一套专业报告 CSS 组件，写 HTML 时直接用这些 class 即可获得精美排版：\n"
    "- 导读块：`<div class=\"lead\">核心结论，含 <strong>关键数字</strong></div>`\n"
    "- 大数字：`<span class=\"highlight-num\">+58%</span>`（衬线大号，视觉焦点）\n"
    "- 提示框：`<div class=\"callout\">` `<div class=\"callout warn\">` `<div class=\"callout danger\">` `<div class=\"callout tip\">`\n"
    "- 概念解释：`<div class=\"concept\"><strong>📐 怎么算的?</strong> 解释...</div>`\n"
    "- 卡片：`<div class=\"card\">`（含可选 `<div class=\"card-title\">`）\n"
    "- 网格：`<div class=\"grid-2\">` `<div class=\"grid-3\">`（响应式）\n"
    "- 统计：`<div class=\"stats\"><div class=\"stat card\"><div class=\"stat-num pos\">99%</div><div class=\"stat-label\">完成率</div></div></div>`（pos=绿/neg=红/accent=橙）\n"
    "- 标签：`<span class=\"badge\">` `<span class=\"badge green/orange/red/gray\">`\n"
    "- 进度条/时间线/高亮/页脚：`progress` `timeline` `highlight` `footer`\n"
    "- 现代风格：内容最外层加 `<div class=\"vibrant\">`（渐变背景）；默认是商务暖灰风格\n"
    "标准标签 h1/h2/h3/p/table/blockquote/code/pre/ul/ol/img 都已美化（标题用衬线字体，专业感）\n"
    "用户提风格要求时用 vibrant 风格或自己加 <style> 自定义\n\n"
    "### PPT 演示文稿（.ppt.html）—— 演示场景\n"
    "1. 用 write_workspace 写 .ppt.html 文件（如 \"季度汇报.ppt.html\"），内容是多个 `<section>`\n"
    "2. 每个 `<section>` 是一张幻灯片，可嵌套 `<section>` 做纵向子页\n"
    "3. 幻灯片内可用 ```mermaid``` 画图、表格、列表，系统自动注入演示引擎\n"
    "4. 调 set_doc_status(\"文件名.ppt.html\", \"completed\") 生成自包含 PPT\n"
    "5. 用户浏览器打开 → 方向键翻页 → 按 F 全屏演示\n"
    "适用：用户说\"演示/ppt/幻灯片/presentation/做个PPT\"\n\n"
    "### PPT 内容设计原则（让每页既美观又信息充实）\n"
    "- 标题页：大标题 + 副标题 + 简洁视觉元素（图标行/分隔线）\n"
    "- 内容页：一个核心观点 + 支撑材料（数据/对比/图表），信息密度适中\n"
    "- 数据页：用大数字+小标签展示关键指标（如 stat-num=\"58%↓\" 而非整段描述）\n"
    "- 对比页：用表格或 grid-2 双栏卡片做对比，比纯文字清晰\n"
    "- 流程页：用 ```mermaid``` 画流程/架构/关系图，一图胜千言\n"
    "- 善用组件：card 网格做要点罗列、badge 标注重要级别、stats 展示数据\n"
    "- 每页内容不要溢出——宁可拆成两页，不要挤一页\n"
    "- 深色背景，亮色文字，数据用 #64ffda 点缀色\n\n"
    "PPT 结构示例（直接写 section，系统自动包装 reveal.js）：\n"
    "  <section><h1>标题</h1><p>副标题</p></section>\n"
    "  <section><h2>对比分析</h2><div class=\"grid-2\"><div class=\"card\">...A...</div><div class=\"card\">...B...</div></div></section>\n"
    "  <section><div class=\"stats\"><div class=\"stat\"><div class=\"stat-num\">58%</div><div class=\"stat-label\">提升</div></div></div></section>\n"
    "  <section>```mermaid\\nflowchart TD\\n  A --> B\\n```</section>\n\n"
    "### 格式判断规则\n"
    "- 用户说\"doc/Word/文档\" → docx（即使需要图，用文字/表格代替）\n"
    "- 用户说\"html/网页/可视化/图文\" 或 内容需要图表表达 → HTML\n"
    "- 用户说\"演示/ppt/幻灯片/presentation\" → PPT（.ppt.html）\n"
    "- 用户说\"报告\"未指定格式 → 看内容：需要图→HTML，纯文字→docx\n\n"
    "关键：write_workspace 只是写文件，必须再调 set_doc_status 标记 completed 才会生成可下载产物。\n"
    "写完文件后请立即调 set_doc_status，不要等用户确认。\n\n"
    "重要：工作区管理\n"
    "- 你之前写的文档/报告存在工作区，不会自动出现在对话上下文里\n"
    "- 需要回顾或修改之前的文档时，用 list_workspace 看有哪些文件，用 read_workspace_chunk 分段读取\n"
    "- 不要假设之前的文档内容在记忆里，用工具去读才准确\n\n"
    "注意：纯文本回复不会生成文档。如果用户只是问问题，用正常回答即可；\n"
    "只有用户明确要\"文档/报告/总结一份\"时才用 write_workspace 写文件。\n"
)

_DOC_BASE_PROMPT = (
    "你是桌伴的智能文档助手。用户选择了\"文档生成\"模式，明确想要一份文档产物。\n\n"
    "## 产物格式选择\n"
    "根据用户意图和内容，选择 docx（纯文字）、html（含图表报告）或 ppt.html（演示文稿）：\n"
    "- 用户说\"doc/Word/文档\" → 写 .md，set_doc_status 生成 docx\n"
    "- 用户说\"可视化/图文/带流程图\" 或 内容需要图表 → 写 .html（用 ```mermaid``` 画图），set_doc_status 生成自包含 HTML 报告\n"
    "- 用户说\"演示/ppt/幻灯片\" → 写 .ppt.html（多个 <section>，每页一个主题），set_doc_status 生成演示文稿\n"
    "- \"报告\"未指定 → 看内容：需要图→html，纯文字→md\n\n"
    "## 工作流\n"
    "1. 【检索】先 search_kb 查知识库，再 search_web 补充（每个最多 2-3 次）\n"
    "2. 【阅读】对最相关的 1-2 条结果用 fetch_url 读正文\n"
    "3. 【大纲】可以 write_workspace 写个 outline.md 理清结构\n"
    "4. 【写作】用 write_workspace 写完整文档（.md 用 Markdown，.html 用 HTML body 内容）\n"
    "5. 【完成】所有内容写完后调 set_doc_status(\"文件名.md或.html\", \"completed\") 生成可下载产物\n\n"
    "## 工具调用预算\n"
    "- 总计最多 20 轮工具调用\n"
    "- 搜索类（search_kb + search_web）：建议 3-5 轮\n"
    "- 阅读类（fetch_url）：建议 1-3 轮\n"
    "- 写作类（write_workspace）：剩余轮次全部用于写作\n"
    "- 剩 5 轮时必须开始收尾\n\n"
    "## 注意事项\n"
    "- 文件名用主题命名（如\"团队协作.md\"或\"架构报告.html\"）\n"
    "- 不要分多次调用——直接写完整篇到一个文件\n"
    "- 写完后立即调 set_doc_status 生成产物\n"
    "- 续写策略（按场景选最省 token 的）：\n"
    "  * 加新章节：用 append_workspace（不用 read 回原文）\n"
    "  * 改某段内容：用 edit_workspace（精准替换，不重写全文）\n"
    "  * 大改或重写：用 read_workspace 读回，再 write_workspace 覆盖\n"
    "- 续写后也要再调一次 set_doc_status 重新生成产物\n"
    "- 你能看到[会话上下文]，包括之前搜过的关键词——不要重复搜索\n"
    "- 禁止只搜索不阅读（fetch_url）就开始写作\n"
    "- 用户上传的文件也在 workspace 里，可以用 read_workspace 读取参考\n"
)


# ===== 工具注册表 =====

TOOL_REGISTRY = {
    "search_kb": {
        "schema": {
            "type": "function",
            "function": {
                "name": "search_kb",
                "description": "【优先使用】搜索本地知识库。知识库包含用户上传的专业文档，信息质量通常高于互联网搜索。回答用户问题时应先查知识库，找不到再搜互联网。注意：私密文档不会出现在搜索结果中。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "搜索关键词"
                        }
                    },
                    "required": ["query"]
                }
            }
        },
        "handler": "kb.search",
        "status_map": {
            "start": "kb_searching",
            "done": "kb_done",
        },
        "stat_key": "kb_hits",
        "condition": "kb_available",
    },
    "search_web": {
        "schema": {
            "type": "function",
            "function": {
                "name": "search_web",
                "description": "搜索互联网，返回相关网页结果。用于查找最新信息、事实核查、或知识库中找不到的话题。如果第一次结果不够，可以换关键词再搜。搜索结果只是摘要，要获取完整内容必须接着调用 fetch_url。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "搜索关键词"
                        }
                    },
                    "required": ["query"]
                }
            }
        },
        "handler": "search_engine.search",
        "status_map": {
            "start": "searching",
            "done": "search_done",
        },
        "stat_key": "searches",
    },
    "fetch_url": {
        "schema": {
            "type": "function",
            "function": {
                "name": "fetch_url",
                "description": "抓取指定 URL 的网页正文内容。用于深入阅读搜索结果中的某个网页，获取详细信息。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "url": {
                            "type": "string",
                            "description": "要抓取的网页 URL"
                        }
                    },
                    "required": ["url"]
                }
            }
        },
        "handler": "search_engine.fetch",
        "status_map": {
            "start": "fetching",
            "done": "fetch_done",
        },
        "stat_key": "fetches",
    },
    # Patch5 G.一致性：上下文压缩工具（云端 Agent 用）
    "summarize_history": {
        "schema": {
            "type": "function",
            "function": {
                "name": "summarize_history",
                "description": "当对话历史很长、上下文空间紧张时调用此工具。系统会把之前的对话总结成简洁摘要，节省 token 同时保留关键信息。返回压缩后的历史摘要，可以直接基于此继续对话。建议在对话超过 30 轮或感觉自己重复阅读相同信息时调用。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "focus": {
                            "type": "string",
                            "description": "压缩时优先保留的主题/关键词（可选，不填则做通用摘要）"
                        }
                    },
                    "required": []
                }
            }
        },
        "handler": None,
        "status_map": {
            "start": "summarizing",
            "done": "summarize_done",
        },
        "stat_key": "summarizes",
    },
    # 时间感知工具：返回当前日期时间，解决模型不知道"今天"的盲区
    "get_current_time": {
        "schema": {
            "type": "function",
            "function": {
                "name": "get_current_time",
                "description": "获取当前的真实日期和时间。当用户提到「今天/昨天/上周/下个月」等相对时间，或需要知道当前日期时调用。返回：完整日期时间 + 星期 + 农历（如可解析）。基于此推算相对日期，不要凭空猜测当前日期。",
                "parameters": {
                    "type": "object",
                    "properties": {},
                    "required": []
                }
            }
        },
        "handler": None,
        "status_map": {
            "start": "time_querying",
            "done": "time_querying_done",
        },
        "stat_key": "time_queries",
        "condition": None,
    },
    # 计算器工具：安全算术，替代有风险的代码执行
    "calculator": {
        "schema": {
            "type": "function",
            "function": {
                "name": "calculator",
                "description": "精确计算数学表达式。用于加减乘除、百分比、括号运算等，避免心算出错。支持运算符：+ - * / % 和括号 ()，以及 min/max/round/abs。例如：计算折扣价、换算汇率、统计求和。注意：只能算数学表达式，不能执行任何代码或函数调用。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "expression": {
                            "type": "string",
                            "description": "数学表达式，如 '2345 * 1.13 + 678' 或 '(100-30)/2'"
                        }
                    },
                    "required": ["expression"]
                }
            }
        },
        "handler": None,
        "status_map": {
            "start": "calculating",
            "done": "calculating_done",
        },
        "stat_key": "calculations",
        "condition": None,
    },
    # 格式转换：工作区内文件互转（md/docx/txt + pdf提取），绝不碰知识库
    "format_convert": {
        "schema": {
            "type": "function",
            "function": {
                "name": "format_convert",
                "description": "转换工作区文件的格式。支持：md↔docx、md↔txt、docx→txt、pdf→txt（提取文本）。用于把文档转成用户需要的格式。注意：只在工作区内操作，不能转成 pdf。docx→pdf 不支持。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "source": {
                            "type": "string",
                            "description": "源文件名（工作区内相对路径，如 '报告.docx'）"
                        },
                        "target": {
                            "type": "string",
                            "description": "目标文件名（工作区内相对路径，如 '报告.md'）。扩展名决定输出格式"
                        }
                    },
                    "required": ["source", "target"]
                }
            }
        },
        "handler": None,
        "status_map": {
            "start": "format_converting",
            "done": "format_converting_done",
        },
        "stat_key": "conversions",
        "condition": None,
    },
    # 表格处理：读写 xlsx + markdown 表格互转
    "table_ops": {
        "schema": {
            "type": "function",
            "function": {
                "name": "table_ops",
                "description": "读写工作区内的 Excel 表格。read：读取 .xlsx 返回 markdown 表格（用于理解数据）。write：把 markdown 表格或 CSV 写成 .xlsx。数据分析（求和/统计）请用 calculator 配合：先 read 读数据，再 calculator 算结果。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "action": {
                            "type": "string",
                            "enum": ["read", "write"],
                            "description": "read=读取表格，write=生成表格"
                        },
                        "filename": {
                            "type": "string",
                            "description": "工作区内文件名（如 'data.xlsx'）"
                        },
                        "data": {
                            "type": "string",
                            "description": "write 模式必填：markdown 表格或 CSV 文本"
                        }
                    },
                    "required": ["action", "filename"]
                }
            }
        },
        "handler": None,
        "status_map": {
            "start": "table_operating",
            "done": "table_operating_done",
        },
        "stat_key": "table_ops_count",
        "condition": None,
    },
    # P6: 深度阅读工具——对上传文档做逐章/逐段深度分析
    "deep_read": {
        "schema": {
            "type": "function",
            "function": {
                "name": "deep_read",
                "description": "深度阅读工作区中的文档，返回结构化分析（核心观点、章节脉络、关键概念、实用要点）。适用于用户要求总结、分析、提炼长文档时。比 read_workspace 更深入，会按章节拆解并提炼要点。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "filename": {
                            "type": "string",
                            "description": "工作区中的文件名"
                        },
                        "focus": {
                            "type": "string",
                            "description": "分析重点（可选），如'流派关系'、'时间线'、'方法论'"
                        }
                    },
                    "required": ["filename"]
                }
            }
        },
        "handler": None,
        "status_map": {
            "start": "deep_reading",
            "done": "deep_read_done",
        },
        "condition": None,
    },
    # ===== Patch4 v3：set_doc_status（接收 filename）+ list_docs + workspace 工具集 =====
    "set_doc_status": {
        "schema": {
            "type": "function",
            "function": {
                "name": "set_doc_status",
                "description": "标记 workspace 里的 .md 文档状态。当用户明确说\"写完了\"时，调用 status='completed' 触发生成可下载的 .docx 文件。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "filename": {
                            "type": "string",
                            "description": "workspace 里的 .md 文件名（如 \"团队协作.md\"）"
                        },
                        "status": {
                            "type": "string",
                            "enum": ["completed"],
                            "description": "目标状态。目前只支持 \"completed\"（标记文档完成并生成 docx）"
                        }
                    },
                    "required": ["filename", "status"]
                }
            }
        },
        "handler": None,
        "status_map": {
            "start": "doc_status_updating",
            "done": "doc_status_done",
        },
        "condition": None,
    },
    "list_docs": {
        "schema": {
            "type": "function",
            "function": {
                "name": "list_docs",
                "description": "列出当前会话 workspace 里的所有 .md 文档（含已完成和写作中），便于你选择续写目标。",
                "parameters": {
                    "type": "object",
                    "properties": {},
                    "required": []
                }
            }
        },
        "handler": None,
        "status_map": {
            "start": "docs_listing",
            "done": "docs_listed",
        },
        "condition": None,
    },
    "list_workspace": {
        "schema": {
            "type": "function",
            "function": {
                "name": "list_workspace",
                "description": "列出你的工作区（workspace）中的所有文件（大纲、草稿、笔记、参考资料等）。返回文件名和大小，不含内容。",
                "parameters": {
                    "type": "object",
                    "properties": {},
                    "required": []
                }
            }
        },
        "handler": None,
        "status_map": {
            "start": "workspace_listing",
            "done": "workspace_listed",
        },
        "condition": None,
    },
    "read_workspace": {
        "schema": {
            "type": "function",
            "function": {
                "name": "read_workspace",
                "description": "读取你工作区的某个文件内容。path 是相对工作区根目录的相对路径（如 'outline.md'）。注意：文件较长时会占用大量上下文，建议优先用 read_workspace_chunk 分段读。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "相对工作区根目录的文件路径（禁止绝对路径和 ../）"
                        }
                    },
                    "required": ["path"]
                }
            }
        },
        "handler": None,
        "status_map": {
            "start": "workspace_reading",
            "done": "workspace_read_done",
        },
        "condition": None,
    },
    "read_workspace_chunk": {
        "schema": {
            "type": "function",
            "function": {
                "name": "read_workspace_chunk",
                "description": "分段读取工作区长文件，每次返回一段（默认3000字符）。适合读取之前写的长文档/报告，避免一次性占用过多上下文。返回包含 has_more 和 next_offset，需要继续读时用 next_offset 作为新的 offset。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "相对工作区根目录的文件路径"
                        },
                        "offset": {
                            "type": "integer",
                            "description": "开始读取的字符位置（默认0，续读时用上次的 next_offset）"
                        },
                        "chunk_size": {
                            "type": "integer",
                            "description": "每段字符数（默认3000，最大10000）"
                        }
                    },
                    "required": ["path"]
                }
            }
        },
        "handler": None,
        "status_map": {
            "start": "workspace_reading",
            "done": "workspace_read_done",
        },
        "condition": None,
    },
    "write_workspace": {
        "schema": {
            "type": "function",
            "function": {
                "name": "write_workspace",
                "description": "写入文件到你的工作区（大纲、草稿、笔记、参考资料等）。可用于规划写作大纲、保存中间草稿。path 是相对工作区根目录的相对路径。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "相对工作区根目录的文件路径（禁止绝对路径和 ../）"
                        },
                        "content": {
                            "type": "string",
                            "description": "文件内容（文本）"
                        }
                    },
                    "required": ["path", "content"]
                }
            }
        },
        "handler": None,
        "status_map": {
            "start": "workspace_writing",
            "done": "workspace_write_done",
        },
        "condition": None,
    },
    "delete_workspace": {
        "schema": {
            "type": "function",
            "function": {
                "name": "delete_workspace",
                "description": "删除你工作区的某个文件。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "相对工作区根目录的文件路径（禁止绝对路径和 ../）"
                        }
                    },
                    "required": ["path"]
                }
            }
        },
        "handler": None,
        "status_map": {
            "start": "workspace_deleting",
            "done": "workspace_deleted",
        },
        "condition": None,
    },
    "append_workspace": {
        "schema": {
            "type": "function",
            "function": {
                "name": "append_workspace",
                "description": "向已有文件追加内容（不覆盖原文）。续写长文档时用这个，不用 read+write 整文件。文件不存在时自动创建。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "相对工作区根目录的文件路径"
                        },
                        "content": {
                            "type": "string",
                            "description": "要追加的内容"
                        }
                    },
                    "required": ["path", "content"]
                }
            }
        },
        "handler": None,
        "status_map": {
            "start": "workspace_appending",
            "done": "workspace_appended",
        },
        "condition": None,
    },
    "edit_workspace": {
        "schema": {
            "type": "function",
            "function": {
                "name": "edit_workspace",
                "description": "对已有文件做精准文本替换（不重写全文）。适合修改文档的某一段，old_text 必须在文件中精确匹配。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "相对工作区根目录的文件路径"
                        },
                        "old_text": {
                            "type": "string",
                            "description": "要替换的原文（必须在文件中精确存在）"
                        },
                        "new_text": {
                            "type": "string",
                            "description": "替换后的新内容"
                        }
                    },
                    "required": ["path", "old_text", "new_text"]
                }
            }
        },
        "handler": None,
        "status_map": {
            "start": "workspace_editing",
            "done": "workspace_edited",
        },
        "condition": None,
    },
}

# 工具级权限映射：工具名 → config_key。不在映射里的工具（内部工具）始终启用。
# 用户可在设置中通过预设或工具开关控制这些工具的启用状态。
_TOOL_PERM_MAP = {
    "search_kb": "tool_enabled_kb_search",
    "search_web": "tool_enabled_web_search",
    "fetch_url": "tool_enabled_web_search",      # 抓取网页归入联网搜索
    "read_workspace": "tool_enabled_file_rw",
    "read_workspace_chunk": "tool_enabled_file_rw",
    "write_workspace": "tool_enabled_file_rw",
    "list_workspace": "tool_enabled_file_rw",
    "delete_workspace": "tool_enabled_file_rw",
    "append_workspace": "tool_enabled_file_rw",
    "edit_workspace": "tool_enabled_file_rw",
}


def get_tools_and_prompt(mode="chat", kb=None, template=None, kb_permission="full", chat_id=None, history=None):
    """根据当前环境动态组装工具列表 + system prompt

    Args:
        mode: "chat" 或 "doc"
        kb: KB 管理器实例（如果可用）
        template: 模板 dict（parse_template() 的返回值，可选）
        kb_permission: "full" | "search-only" | "disabled" — 知识库权限控制
        chat_id: 会话 ID（文件夹名）—— Patch4 修复 2：用于会话上下文注入
        history: 对话历史（list[dict]）—— Patch4 修复 2：用于提取工具调用历史

    Returns:
        (tools, system_prompt):
            tools: OpenAI FC 格式的工具列表（传给 cloud_engine.run_with_tools()）
            system_prompt: 动态组装的 system prompt 字符串
    """
    tools = []

    # 判断环境
    # P8-2 修复：KB 空库（模型已装但无文档）时不注入 search_kb——
    # 否则模型被"知识库优先"引导反复空调用，白烧轮次
    _kb_doc_count = len(getattr(kb, "documents", None) or {}) if kb else 0
    kb_available = (kb is not None and kb_permission != "disabled" and _kb_doc_count > 0)
    doc_mode = mode == "doc"

    # 读取工具级权限配置（_TOOL_PERM_MAP 定义在模块级）
    from config import get as _cfg

    for name, tool_def in TOOL_REGISTRY.items():
        # 条件检查
        condition = tool_def.get("condition")
        if condition == "kb_available" and not kb_available:
            continue
        if condition == "doc_mode" and not doc_mode:
            continue
        # 工具级权限检查（用户可在设置里禁用）
        perm_key = _TOOL_PERM_MAP.get(name)
        if perm_key and not _cfg(perm_key, True):
            continue

        tools.append(tool_def["schema"])

    # 组装 system prompt
    if doc_mode:
        base = _DOC_BASE_PROMPT
    else:
        base = _AGENT_BASE_PROMPT

    # P8-2：KB 不可用（未安装/空库/权限禁用）时裁剪 KB 引导——
    # 否则模型会寻找并未注入的 search_kb 工具，或对着空库白搜
    if not kb_available:
        base = base.replace("- 用户的知识库（search_kb）包含用户上传的专业文档，涉及用户特定领域时查看\n", "")
        base = base.replace("1. 【检索】先 search_kb 查知识库，再 search_web 补充（每个最多 2-3 次）",
                            "1. 【检索】用 search_web 联网搜索补充（最多 2-3 次）")

    # KB 标签注入（full 权限时）—— 保留现有逻辑，作为 [KB 标签概览] 的一部分
    tag_str = ""
    if kb_available and kb_permission == "full":
        try:
            tag_counts = kb.get_all_tags()
            if tag_counts:
                tag_str = " ".join("%s(%d)" % (tag, count) for tag, count in list(tag_counts.items())[:50])
        except Exception:
            pass

    # 注入模板（如果有）
    if template and doc_mode:
        from core.template_parser import template_to_prompt
        template_prompt = template_to_prompt(template)
        if template_prompt:
            base += template_prompt

    # 可视化卡片协议（在线 LLM 用卡片，PLAN ②+；agent 路径注入）
    try:
        from prompts import CARD_PROTOCOL_PROMPT
        base += CARD_PROTOCOL_PROMPT
    except Exception:
        pass

    # ===== Patch4 修复 2：会话上下文注入（token 预算 5000）=====
    base = _inject_session_context(
        chat_id=chat_id,
        kb=kb if kb_available else None,
        base_prompt=base,
        kb_tag_str=tag_str,
        history=history,
    )

    log.info("[AGENT_TOOLS] mode=%s, tools=%s, kb=%s, kb_perm=%s, template=%s, chat_id=%s",
             mode, [t["function"]["name"] for t in tools], kb_available,
             kb_permission, bool(template), chat_id)

    return tools, base


# ============================================================
#  会话上下文注入（Patch4 修复 2）
# ============================================================

# ️ 注入云端的 system prompt 只能包含：
#   1. 用户主动上传的文件清单（文件名+类型，不含内容）
#   2. 云端自己生成的产物（文档列表）
#   3. 云端自己的工具调用历史
#   4. KB 标签概览（粗粒度，帮模型判断要不要检索）
#   5. workspace 文件清单（文件名+大小，不含内容）
# 绝不能注入：KB 文档清单、KB 文档摘要、KB 文档正文
# KB 信息只能通过 search_kb 工具按需获取

# token 预算：会话上下文总量上限 5000 token（约 20000 字符，按中文 1字≈2.5token 估）
_SESSION_CONTEXT_TOKEN_BUDGET = 5000
# 字符上限（粗略换算：中文 1 字 ≈ 2.5 token，留余量）
_SESSION_CONTEXT_CHAR_BUDGET = 18000

# 裁剪优先级（从低到高，超限时先丢）：KB 标签 > workspace 清单 > 文件清单 > 文档列表 > 工具历史
# （工具历史最有价值，最后裁剪）


def _inject_session_context(chat_id, kb, base_prompt, kb_tag_str="", history=None):
    """在 system prompt 末尾追加会话上下文。

    注入内容（5 类，超 token 预算按优先级裁剪）：
      1. 上传文件清单（assets/）
      2. 已生成文档列表（docs/）
      3. 工具调用历史（从 history 提取）
      4. KB 标签概览（kb_tag_str）
      5. workspace 文件清单

    Args:
        chat_id: 会话 ID（文件夹名）
        kb: KB 管理器（用于判断是否注入 KB 标签；不为 None 时注入）
        base_prompt: 基础 system prompt
        kb_tag_str: KB 标签概览字符串（已由调用方组装）
        history: 对话历史（list[dict]）

    Returns:
        str: 拼接后的完整 system prompt
    """
    if not chat_id:
        # 没有 chat_id（如单元测试），跳过注入
        return base_prompt

    try:
        import os as _os
        import json as _json
        from core.doc_session import _chat_root, _workspace_root, _docs_root
        from config import CHAT_DIR

        chat_path = _chat_root(chat_id)
        if not _os.path.isdir(chat_path):
            return base_prompt

        # ===== 收集 4 类信息（Patch4 v3.1 BUG#4+5：删除 assets_block，已由 workspace_block 覆盖）=====

        # 1) 已生成文档列表（workspace 里的 .md + completed 标记）
        docs_block = _collect_docs_block(chat_id)

        # 2) 工具调用历史（从 history 的 agent_timeline 提取）
        tools_block = _collect_tool_history_block(history)

        # 3) KB 标签概览
        kb_block = ""
        if kb is not None and kb_tag_str:
            kb_block = " KB 标签概览：" + kb_tag_str

        # 4) workspace 文件清单（含用户上传的文件）
        workspace_block = _collect_workspace_block(chat_id)

        # ===== 拼接 + token 预算裁剪 =====
        # 优先级（裁剪顺序，先丢优先级低的）：
        # KB 标签 → workspace 清单 → 文档列表 → 工具历史
        blocks = [
            ("kb", kb_block),
            ("workspace", workspace_block),
            ("docs", docs_block),
            ("tools", tools_block),
        ]

        # 先拼完整版本，超限则按优先级从低到高丢弃
        header = "\n\n[会话上下文]"
        assembled = _assemble_context(blocks)

        if len(assembled) <= _SESSION_CONTEXT_CHAR_BUDGET:
            body = assembled
        else:
            # 按优先级（列表顺序）从前往后丢，直到不超限
            body = assembled
            for i in range(len(blocks)):
                if len(body) <= _SESSION_CONTEXT_CHAR_BUDGET:
                    break
                # 丢掉第 i 个非空 block
                reduced = [b for j, b in enumerate(blocks) if j != i]
                body = _assemble_context(reduced)

        if not body.strip():
            return base_prompt

        return base_prompt + header + "\n" + body

    except Exception as e:
        log.warning("[AGENT_TOOLS] 会话上下文注入失败 chat_id=%s: %s", chat_id, str(e)[:100])
        return base_prompt


def _assemble_context(blocks):
    """把非空的 block 用换行拼接。"""
    parts = [b[1] for b in blocks if b[1]]
    return "\n".join(parts)


def _collect_docs_block(chat_id):
    """收集 workspace 里的 .md 文档列表 + completed 标记（Patch4 v3）。"""
    from core.doc_session import list_workspace_files, list_completed_docs
    try:
        files = list_workspace_files(chat_id)
    except Exception:
        return ""

    md_files = [f for f in files if f.get("name", "").endswith(".md")]
    if not md_files:
        return ""

    try:
        completed = list_completed_docs(chat_id)
    except Exception:
        completed = []

    lines = []
    for f in md_files[:20]:  # 最多 20 个
        name = f.get("name", "")
        size = f.get("size", 0)
        is_done = name in completed
        status_label = "已完成" if is_done else "写作中"
        lines.append("- %s（%s，%s）" % (name, _format_size(size), status_label))

    return " 文档状态：\n" + "\n".join(lines)


def _collect_tool_history_block(history):
    """从对话历史的 agent_timeline 提取工具调用历史。

    格式示例：
     本次会话工具调用历史：
    - search_web: "兵棋推演"(10条), "wargaming"(8条)
    - fetch_url: rand.org/...(2.3s)
    - search_kb: "兵棋推演"(无结果)
    """
    if not history or not isinstance(history, (list, tuple)):
        return ""

    # 聚合：tool_name → list[摘要]
    search_web_queries = []
    fetch_summaries = []
    search_kb_queries = []
    write_workspace_names = []  # Patch4 v3：write_workspace 写过的文件名

    for msg in history:
        if not isinstance(msg, dict):
            continue
        timeline = msg.get("agent_timeline")
        if not timeline or not isinstance(timeline, list):
            continue
        for item in timeline:
            if not isinstance(item, dict):
                continue
            status = item.get("status", "")
            if status == "searching":
                q = item.get("query", "")
                if q:
                    search_web_queries.append(q)
            elif status == "fetch_done":
                # 没有耗时字段，记 length
                length = item.get("length") or 0
                fetch_summaries.append("获取%d字" % length if length else "已抓取")
            elif status == "kb_searching":
                q = item.get("query", "")
                if q:
                    search_kb_queries.append(q)
            elif status in ("workspace_writing", "workspace_write_done"):
                # Patch4 v3：write_workspace 调用（item.name 或 item.path 是文件名）
                fname = item.get("name") or item.get("path") or ""
                if fname:
                    write_workspace_names.append(fname)

    if not (search_web_queries or fetch_summaries or search_kb_queries or write_workspace_names):
        return ""

    lines = []
    if search_web_queries:
        # 去重保序，最多 5 个
        seen = set()
        uniq = []
        for q in search_web_queries:
            if q not in seen:
                seen.add(q)
                uniq.append(q)
        kw = ", ".join('"%s"' % q for q in uniq[:5])
        lines.append("- search_web: %s（%d次）" % (kw, len(search_web_queries)))
    if fetch_summaries:
        lines.append("- fetch_url: %d 次" % len(fetch_summaries))
    if search_kb_queries:
        seen = set()
        uniq = []
        for q in search_kb_queries:
            if q not in seen:
                seen.add(q)
                uniq.append(q)
        kw = ", ".join('"%s"' % q for q in uniq[:5])
        lines.append("- search_kb: %s（%d次）" % (kw, len(search_kb_queries)))
    if write_workspace_names:
        seen = set()
        uniq = []
        for n in write_workspace_names:
            if n not in seen:
                seen.add(n)
                uniq.append(n)
        kw = ", ".join('"%s"' % n for n in uniq[:5])
        lines.append("- write_workspace: %s（%d次）" % (kw, len(write_workspace_names)))

    if not lines:
        return ""

    return " 工具调用历史：\n" + "\n".join(lines)


def _collect_workspace_block(chat_id):
    """收集 workspace/ 下的文件清单（文件名+大小，不含内容）。"""
    from core.doc_session import list_workspace_files
    try:
        files = list_workspace_files(chat_id)
    except Exception:
        return ""

    if not files:
        return ""

    lines = []
    for f in files[:20]:  # 最多 20 个
        name = f.get("name", "")
        size = f.get("size", 0)
        lines.append("- %s（%s）" % (name, _format_size(size)))

    return " 工作区文件：\n" + "\n".join(lines)


def _format_size(n):
    """字节数转人类可读。"""
    if n < 1024:
        return "%dB" % n
    elif n < 1024 * 1024:
        return "%.1fKB" % (n / 1024)
    else:
        return "%.1fMB" % (n / (1024 * 1024))


def get_tool_def(name):
    """获取指定工具的完整定义"""
    return TOOL_REGISTRY.get(name)


def get_status_event(tool_name, phase, **kwargs):
    """生成 agent_status 事件数据

    Args:
        tool_name: 工具名
        phase: "start" 或 "done"
        **kwargs: 附加参数（query, url, count, length 等）

    Returns:
        dict: agent_status 事件数据
    """
    tool_def = TOOL_REGISTRY.get(tool_name)
    if not tool_def:
        return {"status": phase, **kwargs}

    status_map = tool_def.get("status_map", {})
    status = status_map.get(phase, phase)

    return {"status": status, **kwargs}
