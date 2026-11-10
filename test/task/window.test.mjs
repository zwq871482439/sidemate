// 任务窗页面预览：起 window-main.mjs 截十张图、点一遍按钮，对着 PNG 和 acts.json 断言。
// 没设 SIDEMATE_TASKWIN 就跳过，平时 npm test 不拉起 Electron。
// Windows：$env:SIDEMATE_TASKWIN='1'; $env:SIDEMATE_SHOTS='...'; node --test test/task/window.test.mjs

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const root = join(here, '..', '..')
const shots = process.env.SIDEMATE_SHOTS || ''

const NAMES = ['1-空的', '2-带了文件还没开始', '3-干活中', '4-等你回话', '5-做完了', '6-没干成', '7-只聊天', '8-回话带格式', '9-两段回答', '10-新任务', '最近两组', '11-输入框120字', '12-拖着文件进窗', '13-发消息前', '14-发消息后', '15-往上翻来新内容']
const FOLDER = 'C:/Users/slow/Desktop/本周材料'
const MATS = ['三季度工程进度周报表.xlsx', '本周会议纪要.docx', '数据汇总（含三季度完整口径）.xlsx', '上周周报.docx', '各项目负责人沟通记录.docx', '三季度现场照片说明.docx', '口径备注与勘误.docx'].map((n) => FOLDER + '/' + n)
const TPL = FOLDER + '/第三季度工程项目建设进展情况汇报（定稿）.docx'
const CARD = 'C:/Users/slow/桌伴/任务/1104-汇成本周周报/桌伴输出/本周周报.docx'

test('task window scenes', { skip: process.env.SIDEMATE_TASKWIN ? false : 'set SIDEMATE_TASKWIN=1', timeout: 180_000 }, async () => {
  assert.equal(shots !== '', true, 'SIDEMATE_SHOTS 未设置')
  const electron = createRequire(join(root, 'package.json'))('electron')
  const lab = mkdtempSync(join(tmpdir(), 'sidemate-taskwin-'))
  const run = (args) => new Promise((resolve) => {
    const child = spawn(electron, [...args, `--user-data-dir=${join(lab, 'user')}`, '--no-sandbox', '--disable-gpu'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
    let err = ''
    child.stderr.on('data', (chunk) => { err += chunk })
    child.on('close', (code) => resolve({ code, err }))
  })
  try {
    mkdirSync(shots, { recursive: true })
    const main = await run([join(root, 'test', 'task', 'window-main.mjs')])
    assert.equal(main.code, 0, main.err.slice(-2000))
    const scale = await run(['--force-device-scale-factor=1.5', join(root, 'test', 'task', 'window-main.mjs'), '--only-10'])
    assert.equal(scale.code, 0, scale.err.slice(-2000))

    for (const name of NAMES) {
      const file = join(shots, `${name}.png`)
      assert.equal(existsSync(file), true, file)
      assert.equal(statSync(file).size > 0, true, file)
    }
    const record = JSON.parse(readFileSync(join(shots, 'acts.json'), 'utf8'))
    const acts = record.acts.map((one) => one.action)
    const scene = (name) => record.acts.filter((one) => one.scene === name).map((one) => one.action)
    const has = (action) => acts.some((one) => JSON.stringify(one) === JSON.stringify(action))

    assert.equal(record.checks.cleared, true, '回车发送后输入框没清空')
    assert.equal(record.checks.held, '汇成本周周报', 'Shift+回车、组字中回车动了输入框')
    for (const [name, one] of Object.entries(record.layout)) {
      assert.deepEqual(one, { x: 0, y: 0 }, `${name} 窗内容溢出：${JSON.stringify(one)}`)
    }
    assert.equal(acts.filter((one) => one.type === 'send' && one.text === '汇成本周周报').length, 1, 'send 只该发一次')
    assert.equal(acts.filter((one) => one.type === 'send' && one.text === '再补一段').length, 1, '长对话里回车也只发一次')
    assert.equal(has({ type: 'send', text: '汇成本周周报' }), true)
    assert.equal(has({ type: 'stop' }), true)
    assert.equal(has({ type: 'open', path: CARD }), true)
    assert.equal(has({ type: 'reveal', path: CARD }), true)
    assert.equal(has({ type: 'retry' }), true)
    assert.equal(has({ type: 'settings' }), true)
    assert.equal(has({ type: 'remove', path: MATS[0] }), true)
    assert.equal(has({ type: 'add', cell: 'materials' }), true)
    assert.equal(has({ type: 'move', path: TPL, to: 'materials' }), true)
    assert.equal(has({ type: 'open-folder', path: FOLDER }), true)
    assert.equal(has({ type: 'recent', dir: FOLDER }), true)
    assert.equal(has({ type: 'new' }), true)
    // 小签上的菜单：改成范本 / 改成材料 / 去掉
    assert.deepEqual(record.checks.items, ['改成范本', '改成材料', '去掉'])
    // 模型说的每一段一个气泡：一轮两段 → 两个气泡
    assert.equal(record.checks.replies, 2, JSON.stringify(record.checks.replies))
    assert.deepEqual(scene('3-干活中'), [{ type: 'stop' }])
    // 没干成：流里两个按钮，先后是去设置、重来
    assert.deepEqual(scene('6-没干成'), [{ type: 'settings' }, { type: 'retry' }])
    assert.deepEqual(scene('最近两组'), [{ type: 'open-recent', dir: 'C:/Users/slow/桌伴/任务/2026-11-05-总结这些形成文献综述/桌伴输出' }])
    // 顶上「＋ 新任务」
    assert.deepEqual(scene('10-新任务'), [{ type: 'new' }])

    // 第二轮几条：数都在 checks.json 里，比具体的数
    const measured = JSON.parse(readFileSync(join(shots, 'checks.json'), 'utf8'))
    // 第 1 条：两种窗、发送 / 停下各量一次，#send 和 #input 交集面积 = 0
    assert.deepEqual(Object.keys(measured.overlap).sort(), ['460x680-send', '460x680-stop'])
    for (const key of Object.keys(measured.overlap)) {
      assert.equal(measured.overlap[key].area, 0, `${key}：${JSON.stringify(measured.overlap[key])}`)
      assert.equal(measured.overlap[key].btn, key.endsWith('stop') ? '停下' : '发送', key)
    }
    // 第 2 条：顶栏 44、小签行 38、输入区 102
    assert.equal(measured.sizes.withFiles.top, 44, JSON.stringify(measured.sizes))
    assert.equal(measured.sizes.withFiles.tags, 38, JSON.stringify(measured.sizes))
    assert.equal(measured.sizes.withFiles.box, 102, JSON.stringify(measured.sizes))
    assert.equal(measured.sizes.withFiles.tagHidden, false)
    assert.equal(measured.sizes.empty.tagHidden, true)
    // 第 3 条：不带 preload 的窗里点一遍、拖一遍，console 里 0 条 error
    assert.equal(measured.noPreload.errors, 0, JSON.stringify(measured.noPreload.logs))
    // 第 4 条 a：「▾」开着时来新视图不收，点不开了才收
    assert.deepEqual(measured.menu, { opened: false, same: false, extra: false, closed: true })
    // 第 4 条 b：连推同一个视图时真按鼠标，只收一条
    assert.deepEqual(measured.openClicks, [{ type: 'open', path: CARD }])
    assert.deepEqual(measured.stopClicks, [{ type: 'stop' }])
    // 第 5 条：出卡那一帧 MutationObserver 回调里量，流末余量 ≤ 1
    const gap = measured.flow['460x680'].gap
    assert.equal(typeof gap, 'number', `gap=${gap}`)
    assert.ok(gap <= 1, `流末被切 ${gap}px`)
    // 第 6 条：拖着文件进窗，窗分两块，压住哪块哪块变实线
    assert.equal(measured.drag.zones, 2, JSON.stringify(measured.drag))
    assert.equal(measured.drag.hidden, false, JSON.stringify(measured.drag))
    assert.equal(measured.drag.left, true, JSON.stringify(measured.drag))
    // 第 7 条：界面上那几样东西的位置和样子
    const done = measured.design.done
    assert.ok(done.userRight >= 0 && done.userRight <= 16, `我说的没靠右：${JSON.stringify(done)}`)
    assert.equal(done.replyLeft, done.userRight, JSON.stringify(done))
    // 做完了：没有过程行，也没有「正在工作」那行
    assert.equal(done.working, '', JSON.stringify(done))
    assert.equal(done.replies, 1, JSON.stringify(done))
    assert.equal(done.card.icon, true, JSON.stringify(done))
    assert.equal(done.card.buttons, 2, JSON.stringify(done))
    assert.equal(done.card.name, '本周周报.docx', JSON.stringify(done))
    assert.equal(done.card.line, '12 页 · 86 句核上出处，4 句没逐字核上（批注里标了）', JSON.stringify(done))
    const fmt = measured.design.fmt
    assert.ok(fmt.md.h >= 1, `标题没照排：${JSON.stringify(fmt)}`)
    assert.equal(fmt.md.ul, 1, JSON.stringify(fmt))
    assert.equal(fmt.md.table, 1, JSON.stringify(fmt))
    assert.equal(fmt.md.stars, false, JSON.stringify(fmt))
    const ask = measured.design.ask
    assert.equal(ask.tail, '等你一句话', JSON.stringify(ask))
    assert.equal(ask.tailColor, 'rgb(197, 58, 34)', JSON.stringify(ask))
    const fail = measured.design.fail
    assert.equal(fail.errColor, 'rgb(197, 58, 34)', JSON.stringify(fail))
    // 干活中：对话流最下面一行浅字「正在工作 · n 秒」
    const work = measured.design.work
    assert.match(work.working, /^正在工作 · \d+ 秒$/, JSON.stringify(work))
    // 渲染进程崩了：10 秒内页面自己回来，task:ready 又被调了一次，还是崩之前那个视图
    const crash = measured.crash
    assert.ok(crash, 'checks.json 里没有 crash')
    assert.equal(crash.back, true, '崩了以后页面没自己回来')
    assert.ok(crash.readyAfter > crash.readyBefore, `task:ready 没被再调：${JSON.stringify(crash)}`)
    assert.equal(crash.crashes.length, 1, JSON.stringify(crash))
    assert.equal(crash.crashes[0].reload, true, JSON.stringify(crash))
    assert.ok(crash.before.count > 0, JSON.stringify(crash.before))
    assert.equal(crash.after.count, crash.before.count, `回来以后视图不一样：${JSON.stringify(crash)}`)
    assert.equal(crash.after.first, crash.before.first, `回来以后第一条的字不一样：${JSON.stringify(crash)}`)

    // 第 8 条：回车发消息 → 滚到底；用户自己往上翻着看 → 来了新内容不硬拽
    const scroll = measured.scroll
    assert.ok(scroll.before.height > scroll.before.client, `对话流不够长，测不了滚动：${JSON.stringify(scroll)}`)
    assert.ok(scroll.after.top >= scroll.after.height - scroll.after.client - 2, `发完没滚到底：${JSON.stringify(scroll)}`)
    const keep = measured.scrollKeep
    assert.equal(keep.before.top, 0, JSON.stringify(keep))
    assert.equal(keep.after.top, 0, `用户往上翻着的时候被硬拽到底了：${JSON.stringify(keep)}`)
    assert.equal(keep.label, '↓ 有新消息', JSON.stringify(keep))
  } finally {
    rmSync(lab, { recursive: true, force: true })
  }
})
