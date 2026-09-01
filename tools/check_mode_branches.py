# -*- coding: utf-8 -*-
"""模式分支白名单检查（0.10.1 M1-C 管道收口配套）

规则（PLAN-099-010 五点七-5）：模式分支（ai_mode ==/!=/in/not in）只允许存在于
白名单文件（工厂/聊天入口/设置联动 + 既有功能性分支），新文件引入模式分支即挂红。

用法：python tools/check_mode_branches.py   （exit 0 = 通过）
"""
import os
import re
import sys

SERVER = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'server')

# 模式分支特征：对 ai_mode 的比较/成员判断（含 _ai_mode 局部变量写法）
PAT = re.compile(r'_?ai_mode\s*(==|!=|not\s+in|\bin\b)')

# 白名单（2026-09-01 盘点基线，含既有功能性分支文件；新增须 PLAN 评审）
ALLOWED = {
    'pipelines/__init__.py',      # create_pipeline 工厂（唯一路由点）
    'pipelines/cloud_pipeline.py',  # 云管道内部模式处理（既有）
    'routers/chat.py',            # 聊天路由入口
    'routers/kb.py',              # KB 跟随主引擎（既有功能性分支）
    'routers/settings_cloud.py',  # 设置联动
    'core/model_manager.py',      # 模型管理（既有）
    'core/prompt_builder.py',     # prompt 装配（既有）
    'core/tagging_scheduler.py',  # 标签订度（既有）
    'knowledge/search.py',        # KB 检索（既有）
    'session/context_cache.py',   # 会话压缩（既有）
}


def main():
    offenders = []
    seen = {}
    for root, dirs, files in os.walk(SERVER):
        if 'tests' in root.replace(os.sep, '/'):
            continue
        for fn in files:
            if not fn.endswith('.py'):
                continue
            fp = os.path.join(root, fn)
            rel = os.path.relpath(fp, SERVER).replace(os.sep, '/')
            try:
                with open(fp, encoding='utf-8') as f:
                    text = f.read()
            except Exception:
                continue
            n = len(PAT.findall(text))
            if n:
                seen[rel] = n
                if rel not in ALLOWED:
                    offenders.append(rel)

    for rel, n in sorted(seen.items()):
        mark = 'OK ' if rel in ALLOWED else '❌ '
        print('  %s%-40s %d 处' % (mark, rel, n))

    if offenders:
        print('\n❌ 以下文件新引入了模式分支（ai_mode 比较），不在白名单内：')
        for o in offenders:
            print('   - %s' % o)
        print('模式分支只许在：create_pipeline 工厂 / 聊天路由入口 / 设置联动。')
        print('确属功能性分支需新增白名单的，请先在 PLAN-099-010 评审。')
        return 1
    print('\n✅ 模式分支白名单检查通过（%d 个文件，均在白名单）' % len(seen))
    return 0


if __name__ == '__main__':
    sys.exit(main())
