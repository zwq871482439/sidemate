const boot = await window.byok.boot()

function show(id) {
  for (const section of document.querySelectorAll('#wizard > section')) section.hidden = section.id !== id
}

// 第三步那句话：小岛冒的那一行，这里说同一句
function showHint(hint) {
  document.querySelector('#hint').textContent = hint || boot.hint
}

async function tryKey(input, result) {
  if (input.dataset.busy === '1') return null
  input.dataset.busy = '1'
  const key = input.value
  result.textContent = '正在试……'
  try {
    const probed = await window.byok.probe(key)
    if (!probed.ok) {
      result.textContent = probed.message
      return null
    }
    const saved = await window.byok.saveKey(key)
    if (!saved.ok) {
      result.textContent = saved.message
      return null
    }
    input.value = ''
    result.textContent = probed.message
    return probed.message
  } finally {
    input.dataset.busy = ''
  }
}

function initWizard() {
  const lines = document.querySelector('#lines')
  for (const line of boot.safety) {
    const item = document.createElement('li')
    item.textContent = line
    lines.append(item)
  }
  document.querySelector('#hint').textContent = boot.hint
  document.querySelector('#start').addEventListener('click', () => show('key'))
  document.querySelector('#docs').addEventListener('click', () => window.byok.openDocs())
  document.querySelector('#done').addEventListener('click', () => window.byok.close())
  document.querySelector('#test').addEventListener('click', async () => {
    const input = document.querySelector('#key-input')
    const message = await tryKey(input, document.querySelector('#key-result'))
    if (!message) return
    document.querySelector('#ok').textContent = message
    show('intro')
    showHint(await window.byok.playIntro())
  })
  if (boot.unreadable) show('key')
  else if (boot.step === 'intro') {
    show('intro')
    showHint(boot.hint)
    window.byok.playIntro().then((hint) => showHint(hint))
  }
}

// 设置页的「用量」一节：数字都在主进程那边格式化好，这里只摆上去
function initUsage(usage) {
  const view = usage || { heading: '', total: '0', recent: [] }
  document.querySelector('#usage-heading').textContent = view.heading
  document.querySelector('#usage-total').textContent = view.total
  const list = document.querySelector('#usage-recent')
  for (const one of view.recent) {
    const row = document.createElement('li')
    const name = document.createElement('span')
    name.className = 'name'
    name.textContent = one.name
    const date = document.createElement('span')
    date.className = 'date'
    date.textContent = one.date
    const count = document.createElement('span')
    count.className = 'count'
    count.textContent = one.usage
    row.append(name, date, count)
    list.append(row)
  }
}

function initSettings() {
  document.querySelector('#wizard').hidden = true
  document.querySelector('#settings').hidden = false
  document.querySelector('#have').textContent = boot.unreadable
    ? '以前存的钥匙读不出来了，重新贴一把。'
    : (boot.hasKey ? '已经存了一把 DeepSeek 钥匙。' : '还没有钥匙。')
  initUsage(boot.usage)
  document.querySelector('#settings-docs').addEventListener('click', () => window.byok.openDocs())
  document.querySelector('#save-key').addEventListener('click', async () => {
    const message = await tryKey(document.querySelector('#settings-key'), document.querySelector('#settings-key-result'))
    if (message) document.querySelector('#have').textContent = '已经存了一把钥匙。'
  })
}

if (new URLSearchParams(location.search).get('view') === 'settings') initSettings()
else initWizard()
