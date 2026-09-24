#!/usr/bin/env python3
"""0.10.2 A3：官网演示同步脚本——发版时把产品 bundle 原样搬到官网。

用法（在 sidemate 仓库根）：
  python tools/sync_demo_bundle.py            # 只同步文件 + 换版本号
  python tools/sync_demo_bundle.py --deploy   # 同步后调 cloudserver 部署脚本（双站）

同步内容：
  server/static/js/v2/dist/bundle.js  → cloudserver/website/static/js/v2/dist/
  server/static/js/v2/dist/bundle.css → 同上
  server/static/vendor/{d2.js,mermaid.min.js,marked.min.js,purify.min.js}
                                      → cloudserver/website/static/vendor/
  server/static/img/logo.jpg          → cloudserver/website/static/img/
并更新 demo-app.html 里 bundle 的 ?v= 指纹（指纹取本文件内容前 8 位 md5）。
nginx gzip + /static/ 长缓存已配好（2026-09-24），无需再动服务器配置。
"""
import hashlib
import os
import re
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEB = os.path.join(os.path.dirname(ROOT), 'cloudserver', 'website')

FILES = [
    ('server/static/js/v2/dist/bundle.js', 'static/js/v2/dist/bundle.js', 'bundle-js'),
    ('server/static/js/v2/dist/bundle.css', 'static/js/v2/dist/bundle.css', 'bundle-css'),
    ('server/static/vendor/d2.js', 'static/vendor/d2.js', 'vendor-d2'),
    ('server/static/vendor/mermaid.min.js', 'static/vendor/mermaid.min.js', 'vendor-mermaid'),
    ('server/static/vendor/marked.min.js', 'static/vendor/marked.min.js', 'vendor-marked'),
    ('server/static/js/lib/purify.min.js', 'static/vendor/purify.min.js', 'vendor-purify'),
    ('server/static/img/logo.jpg', 'static/img/logo.jpg', 'img-logo'),
]


def main():
    deploy = '--deploy' in sys.argv
    tags = {}
    for src, dst, key in FILES:
        sp, dp = os.path.join(ROOT, src), os.path.join(WEB, dst)
        if not os.path.isfile(sp):
            print('MISSING source:', sp)
            sys.exit(1)
        os.makedirs(os.path.dirname(dp), exist_ok=True)
        shutil.copyfile(sp, dp)
        with open(sp, 'rb') as f:
            tags[key] = hashlib.md5(f.read()).hexdigest()[:8]
        print('OK %-42s -> %s' % (src, dst))

    app = os.path.join(WEB, 'demo-app.html')
    html = open(app, encoding='utf-8').read()
    html = re.sub(r'(dist/bundle\.js\?v=)[0-9a-f]+', r'\g<1>' + tags['bundle-js'], html)
    html = re.sub(r'(dist/bundle\.css\?v=)[0-9a-f]+', r'\g<1>' + tags['bundle-css'], html)
    open(app, 'w', encoding='utf-8', newline='\n').write(html)
    print('demo-app.html 版本指纹已更新: bundle.js?v=%s bundle.css?v=%s' % (tags['bundle-js'], tags['bundle-css']))

    if deploy:
        dep = os.path.join(os.path.dirname(WEB), 'tools', 'deploy_v0101.py')
        print('\n--deploy：调用', dep)
        subprocess.run([sys.executable, dep], check=False)
    else:
        print('\n未部署（--deploy 触发双站部署）。记得 git 提交 cloudserver 改动。')


if __name__ == '__main__':
    main()
