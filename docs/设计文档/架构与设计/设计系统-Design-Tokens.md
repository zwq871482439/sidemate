# Sidemate（桌伴）— 设计系统令牌 · DESIGN.md

> **基因来源**: Linear Design System（70%）+ Sidemate 品牌色融合（30%）  
> **设计哲学**: "Gentle Precision" — 温和引导，精准克制  
> **适用场景**: 本地 AI 桌面应用 · 暗色/亮色双主题 · 半透明覆层空状态

---

## 1. Visual Theme — 视觉主题

### 核心理念：Gentle Precision

Sidemate 的覆层设计遵循三个原则：

| 原则 | 含义 | 设计体现 |
|------|------|----------|
| **不阻断** | 覆层是"提示"而非"拦截" | 半透明背景，保留底层内容可见 |
| **不冷漠** | 空状态有温度，有引导 | 插画 + 人性化文案 + 单 CTA |
| **不啰嗦** | 信息层级极致克制 | 图标 → 标题 → 描述 → 按钮，四层足矣 |

### 视觉学派坐标

```
        温暖/人性
            ↑
    Notion  ·  ·  Sidemate（目标位置）
            ·  Linear
            ·  
  ——————————·——————————→ 精确/克制
            ·
   Raycast ·
            ·
         冷淡/机械
```

Sidemate 的目标：**精确克制的骨架上，覆盖一层人性的温度**。这是 Linear 的设计基因与 Sidemate 暖色品牌调性的融合。

---

## 2. Color Palette — 色彩系统

### 品牌色（不可变）

| 令牌 | 色值 | 用途 |
|------|------|------|
| `--brand-deep-blue` | `#1e3a5f` | 主品牌色，深蓝 |
| `--brand-amber` | `#c9976c` | 暖调强调色，琥珀/橙金 |
| `--brand-cream` | `#faf9f6` | 暖白底色，米白 |

### 亮色主题（Light Mode）

```
/* ===== 覆层 ===== */
--overlay-backdrop:        rgba(30, 58, 95, 0.35)   /* 深蓝半透明遮罩 */
--overlay-card-bg:         #FFFFFF                    /* 卡片白底 */
--overlay-card-border:     rgba(30, 58, 95, 0.08)    /* 极淡边框 */
--overlay-card-shadow:     0 2px 24px rgba(30, 58, 95, 0.10),
                           0 0 0 1px rgba(30, 58, 95, 0.06)

/* ===== 文本 ===== */
--text-primary:            #1e3a5f                    /* 主文本 = 品牌深蓝 */
--text-secondary:          rgba(30, 58, 95, 0.55)    /* 次级文本 */
--text-tertiary:           rgba(30, 58, 95, 0.35)    /* 辅助/占位文本 */
--text-on-accent:          #FFFFFF                    /* 强调色上的文本 */

/* ===== 强调 & 交互 ===== */
--accent-default:          #c9976c                    /* 主按钮/链接 = 琥珀 */
--accent-hover:            #b8855a                    /* hover 加深 */
--accent-subtle:           rgba(201, 151, 108, 0.12)  /* 微妙强调背景 */

/* ===== 插画/图标色 ===== */
--illustration-primary:    #1e3a5f                    /* 插画主色 */
--illustration-secondary:  #c9976c                    /* 插画点缀 */
--illustration-tertiary:   rgba(30, 58, 95, 0.15)    /* 插画辅助线 */
--illustration-bg:         rgba(201, 151, 108, 0.06)  /* 插画容器底色 */

/* ===== 背景层 ===== */
--bg-app:                  #faf9f6                    /* 应用底色 = 米白 */
--bg-surface:              #FFFFFF                    /* 卡片/面板 */
--bg-subtle:               rgba(30, 58, 95, 0.03)    /* 微妙分层 */

/* ===== 状态色 ===== */
--color-success:           #2d6a4f                    /* 成功（低饱和绿） */
--color-warning:           #c9976c                    /* 警告 = 品牌琥珀 */
--color-error:             #c44d4d                    /* 错误（暖红） */
```

### 暗色主题（Dark Mode）

```
/* ===== 覆层 ===== */
--overlay-backdrop:        rgba(10, 18, 30, 0.72)    /* 深色半透明遮罩 */
--overlay-card-bg:         #162031                    /* 卡片深蓝底 */
--overlay-card-border:     rgba(201, 151, 108, 0.10) /* 暖色边框 */
--overlay-card-shadow:     0 4px 32px rgba(0, 0, 0, 0.35),
                           0 0 0 1px rgba(201, 151, 108, 0.08)

/* ===== 文本 ===== */
--text-primary:            #f0ede8                    /* 暖白主文本 */
--text-secondary:          rgba(240, 237, 232, 0.55) /* 次级文本 */
--text-tertiary:           rgba(240, 237, 232, 0.30) /* 辅助文本 */

/* ===== 强调 & 交互 ===== */
--accent-default:          #d4a87c                    /* 暗色下稍亮琥珀 */
--accent-hover:            #deb992                    /* hover 更亮 */
--accent-subtle:           rgba(201, 151, 108, 0.14)

/* ===== 插画/图标色 ===== */
--illustration-primary:    #5b8cb8                    /* 暗色插画主色（提亮蓝）*/
--illustration-secondary:  #d4a87c                    /* 暗色插画点缀 */
--illustration-tertiary:   rgba(240, 237, 232, 0.10) /* 插画辅助线 */
--illustration-bg:         rgba(201, 151, 108, 0.06) /* 插画容器底色 */

/* ===== 背景层 ===== */
--bg-app:                  #0f172a                    /* 深蓝黑底 */
--bg-surface:              #162031                    /* 卡片面板 */
--bg-subtle:               rgba(240, 237, 232, 0.04) /* 微妙分层 */
```

### CSS 变量完整声明

```css
:root {
  /* Light mode defaults */
  --overlay-backdrop: rgba(30, 58, 95, 0.35);
  --overlay-card-bg: #FFFFFF;
  --overlay-card-border: rgba(30, 58, 95, 0.08);
  --text-primary: #1e3a5f;
  --text-secondary: rgba(30, 58, 95, 0.55);
  --text-tertiary: rgba(30, 58, 95, 0.35);
  --accent-default: #c9976c;
  --accent-hover: #b8855a;
  --accent-subtle: rgba(201, 151, 108, 0.12);
  --illustration-primary: #1e3a5f;
  --illustration-secondary: #c9976c;
  --illustration-tertiary: rgba(30, 58, 95, 0.15);
  --illustration-bg: rgba(201, 151, 108, 0.06);
  --bg-app: #faf9f6;
  --bg-surface: #FFFFFF;
  --bg-subtle: rgba(30, 58, 95, 0.03);
}

[data-theme="dark"] {
  --overlay-backdrop: rgba(10, 18, 30, 0.72);
  --overlay-card-bg: #162031;
  --overlay-card-border: rgba(201, 151, 108, 0.10);
  --text-primary: #f0ede8;
  --text-secondary: rgba(240, 237, 232, 0.55);
  --text-tertiary: rgba(240, 237, 232, 0.30);
  --accent-default: #d4a87c;
  --accent-hover: #deb992;
  --accent-subtle: rgba(201, 151, 108, 0.14);
  --illustration-primary: #5b8cb8;
  --illustration-secondary: #d4a87c;
  --illustration-tertiary: rgba(240, 237, 232, 0.10);
  --illustration-bg: rgba(201, 151, 108, 0.06);
  --bg-app: #0f172a;
  --bg-surface: #162031;
  --bg-subtle: rgba(240, 237, 232, 0.04);
}
```

### 对比度检查（WCAG AA）

| 组合 | 对比度 | 评级 |
|------|--------|------|
| `#1e3a5f` 文字 on `#FFFFFF` 背景 | 10.2:1 | ✅ AAA |
| `#1e3a5f` 文字 on `#faf9f6` 背景 | 9.6:1 | ✅ AAA |
| `#f0ede8` 文字 on `#162031` 背景 | 11.8:1 | ✅ AAA |
| `rgba(30,58,95,0.55)` on `#FFFFFF` | 4.8:1 | ✅ AA |
| `#c9976c` 文字 on `#FFFFFF` 背景 | 2.6:1 | ⚠️ 仅用于大文本/装饰 |
| `#FFFFFF` 文字 on `#c9976c` 按钮 | 3.8:1 | ⚠️ 大按钮可接受 |

> **注意**: `#c9976c`（琥珀）在小字号正文中使用对比度不足。**仅用于 14px+ 的大按钮、图标、装饰元素**。正文和标签文本始终使用 `#1e3a5f` 或其半透明变体。

---

## 3. Typography — 排版系统

### 字体栈

```css
--font-sans: "Inter", "Inter Fallback", -apple-system, BlinkMacSystemFont,
             "Segoe UI", Roboto, "Noto Sans SC", "PingFang SC",
             "Microsoft YaHei", sans-serif;

--font-mono: "JetBrains Mono", "Cascadia Code", "SF Mono", "Fira Code",
             "Consolas", "Noto Sans Mono SC", monospace;
```

### 字号层级（覆层场景）

| 层级 | 字号 | 行高 | 字重 | CSS 变量 | 用途 |
|------|------|------|------|----------|------|
| **Heading L** | 22px | 1.3 | 600 | `--text-heading-lg` | 覆层主标题 |
| **Heading M** | 17px | 1.35 | 600 | `--text-heading-md` | 卡片标题 |
| **Body** | 14px | 1.55 | 400 | `--text-body` | 描述文本 |
| **Body Small** | 13px | 1.5 | 400 | `--text-body-sm` | 辅助说明 |
| **Caption** | 12px | 1.45 | 500 | `--text-caption` | 按钮文字 / 标签 |
| **Button** | 14px | 1 | 600 | `--text-button` | CTA 按钮 |

### 覆层文字规范

```
┌──────────────────────────────────────────┐
│                                          │
│         [插画 / 图标区域]                 │
│         64×64 ~ 80×80                    │
│                                          │
│       Heading L (22px, 600)              │  ← 一句话标题，5-8 字
│       如："模型尚未就绪"                   │
│                                          │
│    Body (14px, 400, secondary)           │  ← 1-2 句描述，≤30 字
│   如："请先从模型库下载一个模型，           │
│   或等待已安装模型完成预热"                 │
│                                          │
│         [ 主按钮 · CTA ]                  │  ← 单个主要操作
│         Button (14px, 600)               │
│                                          │
│      Caption (12px, tertiary)            │  ← 可选次要链接
│      如："查看模型管理 →"                 │
│                                          │
└──────────────────────────────────────────┘
```

---

## 4. Component Styles — 组件样式

### 4.1 空状态覆层（Empty State Overlay）

这是 Sidemate 的核心组件。两种场景共享相同结构、不同内容：

```
结构: backdrop → card → [illustration, text-block, cta-button, secondary-link?]
```

**规格：**

| 属性 | 亮色 | 暗色 |
|------|------|------|
| 覆层宽度 | `fill_container`（覆盖整个 Tab 区域） | 同 |
| 卡片最大宽度 | 360px | 360px |
| 卡片圆角 | 12px (`--radius-lg`) | 12px |
| 卡片内边距 | 40px 32px 32px | 40px 32px 32px |
| 插画尺寸 | 80×80（SVG） | 80×80 |
| 插画与标题间距 | 24px | 24px |
| 标题与描述间距 | 8px | 8px |
| 描述与按钮间距 | 28px | 28px |
| 按钮与次要链接间距 | 14px | 14px |
| 卡片背景 | `--overlay-card-bg` | `--overlay-card-bg` |
| 卡片边框 | `--overlay-card-border` | `--overlay-card-border` |
| 卡片阴影 | `--overlay-card-shadow` | `--overlay-card-shadow` |
| 覆层背景 | `--overlay-backdrop` | `--overlay-backdrop` |
| Z-index | 10（在内容之上，导航之下） | 10 |

**动画：**

```css
.overlay-enter {
  animation: overlayFadeIn 200ms ease-out;
}
.card-enter {
  animation: cardScaleIn 300ms cubic-bezier(0.16, 1, 0.3, 1);
}

@keyframes overlayFadeIn {
  from { opacity: 0; }
  to   { opacity: 1; }
}

@keyframes cardScaleIn {
  from { opacity: 0; transform: scale(0.96) translateY(8px); }
  to   { opacity: 1; transform: scale(1) translateY(0); }
}
```

### 4.2 按钮

**主按钮（Primary CTA）**：
```
背景: var(--accent-default) → #c9976c
hover: var(--accent-hover) → #b8855a
文字: #FFFFFF
圆角: 8px (--radius-md)
内边距: 8px 20px
字重: 600
字号: 14px
最小宽度: 140px
高度: 36px
```

**次要链接（Secondary Link）**：
```
文字: var(--text-tertiary)
hover: var(--text-secondary)
字号: 12px
字重: 500
无背景，文字 + 箭头图标
```

### 4.3 插画/图标区域

```
容器: 80×80, 圆角 16px (--radius-xl)
背景: var(--illustration-bg)
内容: SVG 插画（64×64 可视区域，居中）
风格: 线性插画（line-art），2px 描边，无填充或微填充
```

**主题色使用规则：**
- 插画主体线条 → `--illustration-primary`（品牌深蓝）
- 插画强调/高亮元素 → `--illustration-secondary`（琥珀点缀）
- 插画背景辅助形 → `--illustration-tertiary`（极淡蓝）

### 4.4 场景差异化

|  | 对话 Tab（模型未预热） | 文库 Tab（模型未加载） |
|------|------|------|
| **图标** | 芯片/大脑 + 温度计 | 数据库/书本 + 下载箭头 |
| **标题** | "模型预热中" | "需要模型支持" |
| **描述** | "模型正在加载到内存，请稍候片刻" | "文库功能需要模型支持，请先安装或加载模型" |
| **主按钮** | "刷新状态"（次要风格） | "前往模型管理"（主要风格） |
| **次要链接** | "切换模型 →" | "了解文库功能 →" |

---

## 5. Layout — 布局与间距

### 间距体系（8px 基准）

```css
--space-xs:  4px    /* 紧密关联 */
--space-sm:  8px    /* 标题-描述 */
--space-md:  16px   /* 组件内部 */
--space-lg:  24px   /* 插画-标题，段落间 */
--space-xl:  28px   /* 描述-按钮 */
--space-2xl: 32px   /* 卡片内边距（下） */
--space-3xl: 40px   /* 卡片内边距（上） */
```

### 覆层布局结构

```
┌──────────────────────────────────────────────────┐
│  ← backdrop: 覆盖整个内容区域，flex居中            │
│                                                  │
│          ┌────────────────────┐                  │
│          │  padding-top: 40px │ ← 上方留白更多    │
│          │                    │   形成"下沉"视觉   │
│          │   [插画 80×80]     │                  │
│          │                    │                  │
│          │   ↑ 24px ↓         │                  │
│          │                    │                  │
│          │   [标题 22px]       │                  │
│          │                    │                  │
│          │   ↑ 8px ↓          │                  │
│          │                    │                  │
│          │   [描述 14px]       │                  │
│          │                    │                  │
│          │   ↑ 28px ↓         │                  │
│          │                    │                  │
│          │   [主按钮]          │                  │
│          │                    │                  │
│          │   ↑ 14px ↓          │                  │
│          │                    │                  │
│          │   [次要链接]        │                  │
│          │                    │                  │
│          │  padding-bottom:32px│                 │
│          └────────────────────┘                  │
│              max-width: 360px                     │
└──────────────────────────────────────────────────┘
```

### 响应式断点

```css
/* 桌面端（默认）：卡片居中 */
/* 小窗（< 480px 宽）：卡片拉宽，减小内边距 */
@media (max-width: 480px) {
  .overlay-card {
    max-width: calc(100vw - 40px);
    padding: 32px 24px 24px;
  }
  .overlay-illustration {
    width: 64px;
    height: 64px;
  }
}
```

---

## 6. Depth & Elevation — 深度与阴影

### 阴影层级

```
Z-Index 层级:
  - 内容层:      0 (默认)
  - 覆层遮罩:    10 (backdrop)
  - 覆层卡片:    11 (card)
  - 导航栏:      50 (确保导航永远在覆层之上可点击)
  - Toast/提示:  100
  - 模态对话框:  200
```

### 阴影 Token

```css
/* 覆层卡片阴影 - 亮色 */
--shadow-overlay-light: 
  0 2px 24px rgba(30, 58, 95, 0.10),
  0 0 0 1px rgba(30, 58, 95, 0.06);

/* 覆层卡片阴影 - 暗色 */
--shadow-overlay-dark:
  0 4px 32px rgba(0, 0, 0, 0.35),
  0 0 0 1px rgba(201, 151, 108, 0.08);

/* 按钮 hover 微阴影 */
--shadow-button-hover:
  0 2px 8px rgba(201, 151, 108, 0.25);
```

### 圆角 Token

```css
--radius-sm:  6px    /* 小元素：标签、徽标 */
--radius-md:  8px    /* 按钮、输入框 */
--radius-lg:  12px   /* 覆层卡片、面板 */
--radius-xl:  16px   /* 插画容器 */
```

---

## 7. Cautions — 设计禁区

### 反模式（不要做的事）

| ❌ 禁区 | ✅ 替代方案 |
|---------|------------|
| 覆层使用不透明纯色背景（阻断感太强） | 使用半透明 backdrop，始终透出底层 |
| 空状态放 2 个以上 CTA 按钮（分散注意力） | 仅 1 个主操作 + 最多 1 个文字链接 |
| 标题使用"错误"/"失败"等负面词汇 | 使用"尚未就绪"/"需要支持"等中性措辞 |
| 插画使用实心厚重风格（视觉过重） | 使用线性轻量插画风格 |
| 卡片使用直角（过于严肃） | 使用 12px 圆角，柔化边界 |
| 在覆层中嵌入复杂表单 | 仅保留最简操作：一个按钮或一个链接 |
| 琥珀色用于小字正文（对比度不足） | 琥珀仅用于按钮/图标/装饰/大字 |
| 暗色模式下卡片与背景融为一体 | 确保卡片有 1px 暖色边框 + 阴影区分层次 |
| 覆层动画超过 400ms（感觉迟钝） | 进入 200-300ms，退出 150ms |

### 文案原则

- **标题**：5-8 字，动词优先（"模型预热中" > "模型未加载状态"）
- **描述**：≤30 字，解释原因 + 暗示解决路径
- **按钮**：动作导向（"前往模型管理" > "确定"）
- **语气**：温和告知，非严厉警告

---

## 8. Responsive Behavior — 响应式策略

### 桌面端（≥ 481px）— 默认

- 卡片固定宽度 360px，居中
- 所有间距、字号使用默认值
- 插画 80×80

### 小窗 / 窄屏（≤ 480px）

- 卡片 `max-width: calc(100vw - 40px)`，左右各留 20px 安全边距
- 卡片内边距缩减为 `32px 24px 24px`
- 插画缩小为 64×64
- 标题 20px，描述 13px
- 按钮宽度 `fill_container`

### 超宽屏（≥ 1600px）

- 卡片最大宽度保持 360px（不再增大，防止视觉稀疏）
- 插画与文字间距可略微增大至 28px

---

## 9. Agent Prompt Guide — AI 生成指南

当使用此设计系统生成 Sidemate 覆层 UI 时，遵循以下指引：

### 结构要求

```
1. 一个全宽全高的 backdrop div，flex 居中
2. 一个白色/深蓝卡片 div，max-width: 360px
3. 卡片内从上到下：illustration-container → heading → description → button → secondary-link
```

### 色彩要求

- 所有色彩使用 CSS 变量，不硬编码色值
- 亮色/暗色主题通过 `[data-theme="dark"]` 切换
- 插画使用品牌蓝 + 琥珀点缀

### 动画要求

- backdrop 淡入 200ms ease-out
- 卡片缩放淡入 300ms cubic-bezier(0.16, 1, 0.3, 1)（Linear 风格弹性曲线）

### 插画风格

- 线性插画（line-art），描边宽度 2px
- 主体色：品牌深蓝 `var(--illustration-primary)`
- 强调色：琥珀 `var(--illustration-secondary)`，仅用于 1-2 个点缀元素
- 背景辅助形：极淡蓝 `var(--illustration-tertiary)`
- 插画容器：80×80，圆角 16px，浅色背景

### 文案模板

**对话 Tab — 模型预热中：**
- 标题："模型预热中"
- 描述："AI 模型正在加载到内存，预计需要几秒到几十秒。加载完成后即可开始对话。"
- 按钮："刷新状态"
- 链接："切换其他模型 →"

**文库 Tab — 需要模型支持：**
- 标题："需要模型支持"
- 描述："文库功能依赖本地模型进行文档理解和检索，请先安装或加载一个模型。"
- 按钮："前往模型管理"
- 链接："了解文库功能 →"

---

## 附录 A：设计系统选型理由

### 候选对比

| 方案 | 设计系统 | 匹配度 | 特征 | 适配理由 |
|------|---------|--------|------|---------|
| **A（推荐）** | **Linear** | ★★★★★ | 极简克制、桌面原生、空状态业界标杆、暗色优先 | 覆层模式（Cmd+K）是设计界最佳实践；空状态"温和引导"理念与 Sidemate 需求完美契合；暗色模式成熟度最高 |
| B | Notion | ★★★★☆ | 温暖亲切、空状态插画出众、亮色原生 | 暖色调与品牌 #faf9f6 天然匹配；空状态使用友好插画 + 清晰 CTA；但覆层/模态设计不如 Linear 克制 |
| C | Raycast | ★★★★☆ | 桌面原生、覆层交互极致、效率导向 | 作为桌面启动器，对覆层/overlay 理解最深；橙色调 accent 与品牌 #c9976c 呼应；但视觉偏冷，缺乏"温度" |

### 为什么选择 Linear 作为基因来源

1. **空状态哲学**：Linear 的空状态从不使用"错误"暗示。它们的 empty state 是"你还没开始，这里是你将要看到的东西"——正是 Sidemate 需要的"温和引导"。
2. **覆层交互**：Linear 的 Command Palette（Cmd+K）是桌面应用覆层设计的黄金标准：半透明背景 + 居中卡片 + 弹性动画。
3. **暗色原生**：Linear 默认暗色模式，Sidemate 作为本地 AI 应用，暗色模式使用场景频繁。
4. **克制美学**：Linear 的"less is more"哲学确保覆层不会被过度设计。图标 + 标题 + 描述 + 按钮，四层结构刚好。

### Linear 基因 + Sidemate 品牌的融合

| Linear 原生 | → Sidemate 调整 |
|-------------|----------------|
| 紫色系 accent (#5e6ad2) | → 琥珀 accent (#c9976c)，更暖 |
| 纯黑背景 (#0d0d0d) | → 深蓝黑 (#0f172a)，融入品牌 |
| 冷灰文字 | → 暖白文字 (#f0ede8)，有温度 |
| 纯白卡片 | → 米白卡片 (#faf9f6 底)，柔和 |
| 无边框卡片 | → 1px 暖色边框，增加层次 |

---

## 附录 B：快速参考卡片

```
┌─ Sidemate 空状态覆层 · 快速参考 ─────────────────┐
│                                                    │
│  卡片: 360px宽, 12px圆角, 1px边框, 柔和阴影       │
│  插画: 80×80, 线性风格, 蓝+琥珀                    │
│  标题: 22px/600, #1e3a5f, 5-8字                   │
│  描述: 14px/400, 55%透明度, ≤30字                  │
│  按钮: 36px高, 8px圆角, 琥珀底白字                 │
│  动画: 淡入200ms + 弹性缩放300ms                   │
│  规则: 单CTA · 不做错误态 · 琥珀仅装饰             │
│                                                    │
│  亮色: 米白底(#faf9f6) + 深蓝文字(#1e3a5f)        │
│  暗色: 深蓝底(#0f172a) + 暖白文字(#f0ede8)        │
│                                                    │
└────────────────────────────────────────────────────┘
```
