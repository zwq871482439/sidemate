# Sidemate Settings — 设计令牌扩展

> 基于 `SIDEMATE_DESIGN_TOKENS.md` 向下扩展到设置页面
> 版本: v1.0 | 暗色优先 | 基因: Linear 70% + 琥珀暖色 30%

---

## 1. 布局系统

```css
/* 设置页容器 */
--settings-width: 720px;
--settings-sidebar-width: 200px;
--settings-content-width: 520px;
--settings-gap: 0px;           /* sidebar 与 content 无缝连接 */

/* Section 分组 */
--section-gap: 32px;           /* 卡片组垂直间距 */
--section-card-gap: 12px;      /* 同组卡片间距 */

/* 侧边栏 */
--sidebar-padding: 16px;
--sidebar-item-height: 36px;
--sidebar-item-radius: 6px;
--sidebar-icon-size: 18px;
--sidebar-font: 13px / 1 / 500;

/* 内容区 */
--content-padding: 28px 32px;
```

## 2. 色彩系统（扩展现有暗色主题）

```css
/* ===== 基础（继承自 main.css） ===== */
--bg-primary: #0f172a;         /* 应用背景 */
--bg-secondary: #1e293b;       /* 卡片/面板背景 */
--bg-tertiary: #334155;        /* 次级表面 */
--text-primary: #f8fafc;       /* 主文字 */
--text-secondary: #cbd5e1;     /* 次级文字 */
--text-muted: #94a3b8;         /* 辅助文字 */
--border-color: #334155;       /* 默认边框 */

/* ===== 新增：设置页专属 ===== */
--settings-sidebar-bg: rgba(15, 23, 42, 0.6);           /* 侧边栏半透明底 */
--settings-sidebar-hover: rgba(51, 65, 85, 0.5);        /* hover 态 */
--settings-sidebar-active: rgba(51, 65, 85, 0.8);       /* 选中态 */
--settings-sidebar-active-border: #60a5fa;               /* 选中指示条（蓝） */

--settings-section-title: #f8fafc;                       /* section 标题 */
--settings-section-desc: #94a3b8;                        /* section 描述 */

--settings-card-bg: #1e293b;                             /* 卡片背景 */
--settings-card-border: rgba(148, 163, 184, 0.12);      /* 卡片边框 */
--settings-card-radius: 8px;

--settings-row-border: rgba(148, 163, 184, 0.08);       /* 行底部分割线 */

/* ===== 强调色 ===== */
--accent-default: #60a5fa;          /* 主强调（蓝）— 选中态、激活态 */
--accent-hover: #93bbfd;           /* hover */
--accent-subtle: rgba(96, 165, 250, 0.12);  /* 微妙强调 */

--accent-warm: #c9976c;            /* 暖调强调（琥珀）— 品牌色点缀 */
--accent-warm-hover: #d4a87c;

/* ===== 状态色 ===== */
--success: #34d399;                /* 成功 / 连接正常 / 在线 */
--success-bg: rgba(52, 211, 153, 0.12);
--warning: #fbbf24;                /* 警告 */
--warning-bg: rgba(251, 191, 36, 0.12);
--error: #f87171;                  /* 错误 / 连接失败 */
--error-bg: rgba(248, 113, 113, 0.12);
```

## 3. 排版（设置页）

```css
/* 侧边栏 */
--sidebar-item: 13px / 1 / 500;

/* Section */
--section-heading: 11px / 1 / 600;          /* 分组标题（全大写） */
--section-desc: 13px / 1.5 / 400;

/* 设置行 */
--row-label: 14px / 1.4 / 400;              /* 行标签 */
--row-value: 14px / 1.4 / 400;              /* 行数值 */
--row-hint: 12px / 1.4 / 400;               /* 行辅助说明 */

/* 等宽 */
--font-mono: "JetBrains Mono", "Cascadia Code", "Consolas", monospace;
--mono-value: 13px / 1.4 / 500;             /* 数值、URL、路径 */
```

## 4. 组件令牌

### 4.1 侧边栏导航

```
┌──────────────┐
│  🔍 搜索...   │  ← 36px 搜索框（v0.9 预留）
├──────────────┤
│  ▎⚙ 通用     │  ← 36px，选中态左侧 2px 蓝条
│   🎙 语音    │
│   🤖 AI     │
│   🎵 录音    │
│   ℹ️ 关于    │
├──────────────┤
│              │  ← 弹性空白
├──────────────┤
│  v0.9.0      │  ← 版本信息
└──────────────┘
```

```css
.sidebar { width: 200px; padding: 12px 8px; background: var(--settings-sidebar-bg); }
.sidebar-item { height: 36px; padding: 0 10px; border-radius: 6px; gap: 8px; display: flex; align-items: center; font-size: 13px; font-weight: 500; cursor: pointer; transition: background 120ms; }
.sidebar-item:hover { background: var(--settings-sidebar-hover); }
.sidebar-item.active { background: var(--settings-sidebar-active); }
.sidebar-item.active::before { content: ''; position: absolute; left: 0; width: 2px; height: 20px; background: var(--settings-sidebar-active-border); border-radius: 1px; }
```

### 4.2 Section 分组容器

```css
.settings-section { margin-bottom: 32px; }
.settings-section-title { font-size: 11px; font-weight: 600; text-transform: uppercase; color: var(--text-muted); letter-spacing: 0.05em; margin-bottom: 8px; padding-left: 2px; }
.settings-section-desc { font-size: 13px; color: var(--text-muted); margin-bottom: 12px; }
```

### 4.3 Setting Row（单行配置）

```css
.setting-row {
  display: flex; align-items: center; justify-content: space-between;
  min-height: 44px; padding: 10px 16px;
  border-bottom: 1px solid var(--settings-row-border);
}
.setting-row:last-child { border-bottom: none; }
.setting-row .label { font-size: 14px; color: var(--text-primary); }
.setting-row .hint { font-size: 12px; color: var(--text-muted); margin-top: 1px; }
.setting-card {
  background: var(--settings-card-bg);
  border: 1px solid var(--settings-card-border);
  border-radius: var(--settings-card-radius);
  overflow: hidden;
}
```

### 4.4 Toggle Switch

```css
.toggle { position: relative; width: 40px; height: 22px; background: var(--bg-tertiary); border-radius: 11px; cursor: pointer; transition: background 180ms; flex-shrink: 0; }
.toggle.on { background: var(--accent-default); }
.toggle::after { content: ''; position: absolute; top: 2px; left: 2px; width: 18px; height: 18px; background: #fff; border-radius: 50%; transition: transform 180ms cubic-bezier(0.34, 1.56, 0.64, 1); }
.toggle.on::after { transform: translateX(18px); }
```

### 4.5 Select Dropdown

```css
.select { height: 32px; padding: 0 28px 0 10px; background: var(--bg-tertiary); border: 1px solid var(--border-color); border-radius: 6px; color: var(--text-primary); font-size: 13px; cursor: pointer; appearance: none; /* +chevron svg bg */ }
.select:focus { border-color: var(--accent-default); outline: none; }
```

### 4.6 Button

```css
.btn { height: 32px; padding: 0 14px; border-radius: 6px; font-size: 13px; font-weight: 500; cursor: pointer; transition: all 120ms; border: none; }
.btn-primary { background: var(--accent-default); color: #fff; }
.btn-primary:hover { background: var(--accent-hover); }
.btn-secondary { background: transparent; color: var(--text-secondary); border: 1px solid var(--border-color); }
.btn-secondary:hover { background: var(--bg-tertiary); color: var(--text-primary); }
.btn-danger { background: transparent; color: var(--error); border: 1px solid var(--error); }
.btn-ghost { background: transparent; color: var(--text-secondary); border: none; }
```

### 4.7 Status Indicator

```css
.status-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.status-dot.online { background: var(--success); }
.status-dot.offline { background: var(--error); }
.status-dot.warning { background: var(--warning); }
.status-dot.idle { background: var(--text-muted); }

.status-label { font-size: 12px; font-weight: 500; display: flex; align-items: center; gap: 6px; }
```

## 5. 间距 & 尺寸 Token

```css
--row-height: 44px;            /* 标准行高 */
--row-padding-x: 16px;         /* 行水平内边距 */
--card-padding: 0;             /* 卡片内边距（行自带 padding） */
--card-radius: 8px;            /* 卡片圆角 */
--sidebar-width: 200px;        /* 侧边栏宽度 */
--section-gap: 32px;           /* 分组间距 */
```

## 6. 动效

```css
--transition-fast: 120ms ease;       /* hover/active 微交互 */
--transition-normal: 180ms ease;    /* toggle、展开 */
--transition-spring: 180ms cubic-bezier(0.34, 1.56, 0.64, 1);  /* toggle 弹性 */
```

## 7. 完整 :root 声明块

```css
:root {
  /* 基础（继承） */
  --bg-primary: #0f172a;
  --bg-secondary: #1e293b;
  --bg-tertiary: #334155;
  --text-primary: #f8fafc;
  --text-secondary: #cbd5e1;
  --text-muted: #94a3b8;
  --border-color: #334155;

  /* 侧边栏 */
  --settings-sidebar-bg: rgba(15, 23, 42, 0.6);
  --settings-sidebar-hover: rgba(51, 65, 85, 0.5);
  --settings-sidebar-active: rgba(51, 65, 85, 0.8);
  --settings-sidebar-active-border: #60a5fa;

  /* 卡片 */
  --settings-card-bg: #1e293b;
  --settings-card-border: rgba(148, 163, 184, 0.12);
  --settings-card-radius: 8px;
  --settings-row-border: rgba(148, 163, 184, 0.08);

  /* 强调色 */
  --accent: #60a5fa;
  --accent-hover: #93bbfd;
  --accent-subtle: rgba(96, 165, 250, 0.12);
  --accent-warm: #c9976c;
  --accent-warm-hover: #d4a87c;

  /* 状态 */
  --success: #34d399;
  --success-bg: rgba(52, 211, 153, 0.12);
  --warning: #fbbf24;
  --warning-bg: rgba(251, 191, 36, 0.12);
  --error: #f87171;
  --error-bg: rgba(248, 113, 113, 0.12);

  /* 排版 */
  --font-mono: "JetBrains Mono", "Cascadia Code", "Consolas", monospace;

  /* 动效 */
  --transition-fast: 120ms ease;
  --transition-normal: 180ms ease;
  --transition-spring: 180ms cubic-bezier(0.34, 1.56, 0.64, 1);
}
```

## 8. 设计禁区（来自品牌设计系统）

| ❌ | ✅ |
|---|---|
| 彩色渐变背景 | 纯色 / 半透明层 |
| 圆角 > 8px（卡片可 12px） | 6-8px 圆角体系 |
| 装饰性插画 / emoji 图标 | 线性图标 1.5px 描边 |
| 弹性动效 > 200ms | 120-180ms 微交互 |
| 琥珀色用于正文 | 琥珀仅用于品牌点缀 |
| 信息密度过高 | 行高 ≥ 44px，给呼吸感 |
