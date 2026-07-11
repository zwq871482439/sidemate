"""生成 10 个测试 HTML（边界场景），每个覆盖 doc_action 的一个能力点"""
import sys, os, json
sys.path.insert(0, r'C:/Sidemate/server')
from pipelines.doc_action import generate_html_report

OUT = r'C:/Sidemate/tests/_selftest_out'
os.makedirs(OUT, exist_ok=True)

cases = {
    'T1': '',  # 空内容
    'T2': '# 标题\n\n```mermaid\nflowchart LR\n  A[开始] --> B[结束]\n```\n',
    'T3': '# 测试\n\n```mermaid\nflowchart TD\n  A --> B\n  B --> C\n```\n\n中间段落。\n\n```mermaid\nsequenceDiagram\n  Alice->>Bob: Hello\n  Bob-->>Alice: Hi\n```\n\n```mermaid\npie title Pets\n  "Dogs" : 386\n  "Cats" : 85\n```\n',
    'T4': '# 安全测试\n\n这里有 `</script>` 字面字符串。\n\n还有一段 <script>alert(1)</script> 测试。\n',
    'T5': '<div class="lead"><strong>重点</strong>这是混用\n\n## 二级标题\n\n普通段落有 **粗体** 和 *斜体* 和 `代码`。\n\n- 列表 1\n- 列表 2\n- 列表 3\n\n</div>',
    'T6': '| 列1 | 列2 | 列3 |\n|-----|-----|-----|\n| a   | b   | c   |\n| 1   | 2   | 3   |\n',
    'T7': '```python\ndef hello():\n    print("hi")\n```\n',
    'T8': '# 📊 数据报告\n\nEnglish mixed 中英文。**加粗** *italic* `code`。\n\n> 引用：复杂适应系统\n',
    'T9': '<div class="callout warn">\n<strong>注意</strong>：这是一个警告框\n</div>\n\n<span class="badge">新</span> <span class="badge orange">热</span>\n\n<div class="lead">引导段落</div>\n',
    'T10': '# 长内容\n\n' + '段落' * 200 + '\n\n## 子标题\n\n' + ('| a | b |\n|---|---|\n| 1 | 2 |\n' * 500) + '\n\n```mermaid\nflowchart LR\n  A --> B\n```\n',
}

results = []
for name, content in cases.items():
    p = os.path.join(OUT, name + '.html')
    try:
        generate_html_report(content, p, title=name)
        results.append({'name': name, 'ok': True, 'size': os.path.getsize(p)})
        print(f'GEN_OK {name} {os.path.getsize(p)}')
    except Exception as e:
        import traceback
        results.append({'name': name, 'ok': False, 'err': str(e)})
        print(f'GEN_FAIL {name} {e}')
        traceback.print_exc()

with open(os.path.join(OUT, '_gen_results.json'), 'w', encoding='utf-8') as f:
    json.dump(results, f, ensure_ascii=False, indent=2)