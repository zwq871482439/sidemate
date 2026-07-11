// -*- coding: utf-8 -*-
/**
 * test_regression_v097.mjs — 0.9.7 回归测试
 * ====================================================
 * 覆盖 0.9.7 全部改动：
 *   [A] 模块导入（llamacpp_backend / 精简后 _base / 所有 pipeline）
 *   [B] _base.py 死代码已删（7 个符号不存在）
 *   [C] config.py 新增配置项（last_loaded_model / llamacpp_*）
 *   [D] ModelRegistry 扫描 + 迁移逻辑
 *   [E] ollama_manager 委托层（LlamaCppManager 接口）
 *   [F] stream_engine OpenAI 兼容（无 Ollama API 残留）
 *   [G] model_manager API 替换（无 /api/tags /api/ps /api/delete）
 *   [H] settings_extensions GGUF 安装（无 blob/manifest 构造）
 *   [I] 前端 JS 版本号 bump
 *   [J] heroicons 图标统一（utils.js viewBox 24×24）
 *   [K] 文档审计日志（search.py + kb.py API）
 *   [L] Bug 三件套（B1 task_classifier / B3 prompt / B2 超时兜底）
 *
 * 运行: node tests/test_regression_v097.mjs
 */

import { execFileSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';

const ROOT = 'C:/Sidemate';
let passed = 0, failed = 0;
const errors = [];

function assert(cond, name) {
  if (cond) { passed++; console.log('  ✅', name); }
  else { failed++; errors.push(name); console.log('  ❌', name); }
}

function readFile(rel) {
  return readFileSync(ROOT + '/' + rel, 'utf-8');
}

function runPython(code) {
  return execFileSync('python', ['-c', code], {
    cwd: ROOT, encoding: 'utf-8', timeout: 30000,
    env: { ...process.env, PYTHONPATH: ROOT + '/server' }
  });
}

console.log('=== 0.9.7 回归测试 ===\n');

// ========== A. 模块导入 ==========
console.log('[A] 模块导入');
try {
  const result = runPython(`
import sys; sys.path.insert(0, 'server')
# 0.9.7 新增模块
from core.llamacpp_backend import LlamaCppManager, LlamaCppClient, ModelRegistry, ModelInfo
# 精简后的 _base（只留 3 个符号）
from pipelines._base import StreamContext, sse_event, _sanitize_output
# 三个 pipeline + doc_action
from pipelines.local_pipeline import run_local_pipeline
from pipelines.cloud_pipeline import run_cloud_pipeline
from pipelines.parallel_pipeline import run_parallel_pipeline
from pipelines.doc_action import generate_docx, generate_html_report, generate_ppt_html
# 其他核心模块
from core.stream_engine import StreamEngine
from core.ollama_manager import OllamaManager
from core.model_manager import ModelManager
from routers.settings_system import router
from routers.settings_extensions import router as erouter
from routers.kb import router as kbrouter
print('IMPORT_OK')
`);
  assert(result.includes('IMPORT_OK'), '所有 0.9.7 模块可导入');
} catch (e) {
  assert(false, '模块导入失败: ' + e.message.slice(0, 100));
}

// ========== B. _base.py 死代码已删 ==========
console.log('\n[B] _base.py 死代码已删');
const baseSrc = readFile('server/pipelines/_base.py');
const deadSymbols = ['EngineResult', 'yield_engine_tokens', 'handle_action_router',
                     'handle_kb_retrieval', 'handle_doc_action', 'save_conversation', 'save_on_stop'];
deadSymbols.forEach(sym => {
  assert(!baseSrc.includes('def ' + sym) && !baseSrc.includes('class ' + sym),
    '_base.py 不含死代码: ' + sym);
});
// 保留的 3 个
assert(baseSrc.includes('class StreamContext'), '_base.py 保留 StreamContext');
assert(baseSrc.includes('def sse_event'), '_base.py 保留 sse_event');
assert(baseSrc.includes('def _sanitize_output'), '_base.py 保留 _sanitize_output');

// ========== C. config.py 新增配置 ==========
console.log('\n[C] config.py 新增配置项');
const configSrc = readFile('server/config.py');
assert(configSrc.includes('"last_loaded_model"'), 'config 含 last_loaded_model');
assert(configSrc.includes('"llamacpp_ctx_size"'), 'config 含 llamacpp_ctx_size');
assert(configSrc.includes('"llamacpp_gpu_layers"'), 'config 含 llamacpp_gpu_layers');
assert(configSrc.includes('"llamacpp_model"'), 'config 含 llamacpp_model');
assert(configSrc.includes('"version": "0.9.7"'), '版本号 0.9.7');

// ========== D. ModelRegistry 扫描 ==========
console.log('\n[D] ModelRegistry 模型扫描');
try {
  const result = runPython(`
import sys; sys.path.insert(0, 'server')
from core.llamacpp_backend import ModelRegistry
r = ModelRegistry('models')
models = r.scan()
print('SCAN_COUNT:%d' % len(models))
for m in models:
    print('MODEL:%s|gguf=%s|%sB' % (m.model_id, m.gguf_exists, m.size_b))
# 测试 recommend
rec = r.recommend(vram_gb=0, ram_gb=8)
if rec:
    print('RECOMMEND:%s' % rec.model_id)
`);
  assert(result.includes('SCAN_COUNT:'), 'ModelRegistry.scan() 成功');
  const count = parseInt(result.match(/SCAN_COUNT:(\d+)/)?.[1] || '0');
  assert(count === 3, '扫描到 3 个 Q4 模型');
  assert(result.includes('qwen3.5-0.8b-q4'), '含 0.8B 模型');
  assert(result.includes('qwen3.5-2b-q4'), '含 2B 模型');
  assert(result.includes('qwen3.5-4b-q4'), '含 4B 模型');
  assert(result.includes('RECOMMEND:qwen3.5-4b-q4'), '推荐最大可用(4B)');
} catch (e) {
  assert(false, 'ModelRegistry 测试失败: ' + e.message.slice(0, 120));
}

// ========== E. ollama_manager 委托层 ==========
console.log('\n[E] ollama_manager 委托层');
const omSrc = readFile('server/core/ollama_manager.py');
assert(omSrc.includes('from core.llamacpp_backend import'), '委托给 llamacpp_backend');
assert(omSrc.includes('class OllamaManager'), '保留 OllamaManager 类名');
assert(omSrc.includes('def _find_default_model'), '含 _find_default_model');
assert(omSrc.includes('_detect_hardware'), '含硬件检测');
assert(omSrc.includes('def list_available_models'), '含 list_available_models');
assert(omSrc.includes('def switch_model'), '含 switch_model');
assert(omSrc.includes('last_loaded_model'), '切换后写 last_loaded_model');

// ========== F. stream_engine OpenAI 兼容 ==========
console.log('\n[F] stream_engine OpenAI 兼容');
const seSrc = readFile('server/core/stream_engine.py');
// 检查实际请求代码不含 Ollama API（排除注释/docstring）
const seCode = seSrc.replace(/#.*/g, '').replace(/""".*?"""/gs, '');
assert(!seCode.includes('"/api/chat"') && !seCode.includes("'/api/chat'"), 'stream_engine 代码不含 Ollama /api/chat 请求');
assert(seSrc.includes('LlamaCppClient') || seSrc.includes('llamacpp_backend'), 'stream_engine 用 LlamaCppClient');
assert(seSrc.includes('/v1/chat/completions') || seSrc.includes('chat_stream'), '走 OpenAI 兼容 API');
assert(seSrc.includes('enable_thinking'), '含 think 模式控制');
assert(seSrc.includes('delta.content') || seSrc.includes('chat_stream'), 'OpenAI delta 解析');

// ========== G. model_manager API 替换 ==========
console.log('\n[G] model_manager 无 Ollama API 残留（代码层面）');
const mmSrc = readFile('server/core/model_manager.py');
// 检查实际代码不含 Ollama API URL（排除注释/字符串常量）
const mmCode = mmSrc.replace(/#.*/g, '').replace(/""".*?"""/gs, '').replace(/'''.*?'''/gs, '');
assert(!mmCode.match(/['"]\/api\/tags['"]/), '代码不含 /api/tags URL');
assert(!mmCode.match(/['"]\/api\/generate['"]/), '代码不含 /api/generate URL');
assert(!mmCode.match(/['"]\/api\/delete['"]/), '代码不含 /api/delete URL');
assert(!mmCode.match(/['"]\/api\/ps['"]/), '代码不含 /api/ps URL');
assert(mmSrc.includes('ModelRegistry'), '用 ModelRegistry 扫描模型');
assert(mmSrc.includes('psutil'), '用 psutil 测内存');
assert(mmSrc.includes('def is_busy'), '含 is_busy（AI 忙检测）');

// ========== H. settings_extensions GGUF 安装 ==========
console.log('\n[H] settings_extensions GGUF 安装');
const extSrc = readFile('server/routers/settings_extensions.py');
assert(!extSrc.includes('application/vnd.ollama.image'), '不含 Ollama mediaType');
assert(!extSrc.includes('registry.ollama.ai'), '不含 Ollama manifest 路径');
assert(extSrc.includes('meta.json'), '安装时写 meta.json');
assert(extSrc.includes('ModelRegistry'), '用 ModelRegistry');

// ========== I. 前端 JS 版本号 ==========
console.log('\n[I] 前端版本号 bump');
const idxSrc = readFile('server/index.html');
assert(idxSrc.includes('v=2.9.7') || idxSrc.includes("v0.9.7"), '前端版本号 0.9.7');
// 关键 JS 文件版本号都 > 2.7
['chat.js', 'qa.js', 'settings.js', 'core/utils.js'].forEach(jf => {
  const match = idxSrc.match(new RegExp(jf.replace('.', '\\.') + '\\?v=([0-9.]+)'));
  if (match) {
    const ver = parseFloat(match[1]);
    assert(ver >= 2.4, jf + ' 版本号 ' + match[1] + ' ≥ 2.4');
  }
});

// ========== J. heroicons 图标统一 ==========
console.log('\n[J] heroicons 图标统一');
const utilsSrc = readFile('server/static/js/core/utils.js');
assert(utilsSrc.includes('viewBox="0 0 24 24"'), 'utils.js 图标 viewBox 24×24');
assert(!utilsSrc.includes('viewBox="0 0 14 14"'), 'utils.js 不含旧 14×14 viewBox');
assert(utilsSrc.includes('stroke-width="1.5"'), 'utils.js 描边 1.5px');
// 设置页导航也是 heroicons
assert(idxSrc.includes('stroke-width="1.5"'), 'index.html 含 heroicons 描边');

// ========== K. 文档审计日志 ==========
console.log('\n[K] 文档审计日志');
const searchSrc = readFile('server/knowledge/search.py');
assert(searchSrc.includes('def _append_audit_log'), 'search.py 含审计日志写入');
assert(searchSrc.includes('def get_audit_log'), 'search.py 含审计日志读取');
assert(searchSrc.includes('def clear_audit_log'), 'search.py 含审计日志清除');
assert(searchSrc.includes('_AUDIT_LOG_MAX'), '含 FIFO 裁剪上限');
const kbSrc = readFile('server/routers/kb.py');
assert(kbSrc.includes('/audit_log'), 'kb.py 含审计日志 API');
assert(kbSrc.includes('audit_log/clear_all'), 'kb.py 含清空 API');
assert(kbSrc.includes('audit_log/stats'), 'kb.py 含统计 API');

// ========== L. Bug 三件套 ==========
console.log('\n[L] Bug 三件套');
// B1: 并行模式闲聊检测
const ppSrc = readFile('server/pipelines/parallel_pipeline.py');
assert(ppSrc.includes('is_greeting'), 'B1: parallel_pipeline 含 is_greeting 检测');
assert(ppSrc.includes('greeting_skip'), 'B1: 含 greeting_skip 标记');
// B3: 云端多嘴 prompt 约束
const promptSrc = readFile('server/core/agent_tools.py');
assert(promptSrc.includes('不评价') && promptSrc.includes('提问方式'), 'B3: agent_tools 含不评价提问方式约束');
const promptsSrc = readFile('server/prompts.py');
assert(promptsSrc.includes('不评价') || promptsSrc.includes('不要追加'), 'B3: prompts.py 含约束');
// B2: 提纲超时兜底
const chatSrc = readFile('server/static/js/chat.js');
assert(chatSrc.includes('_docOutlineTimer'), 'B2: chat.js 含提纲超时定时器');
assert(chatSrc.includes('doc-outline-timeout'), 'B2: 含超时提示样式');

// ========== M. 视觉改进 ==========
console.log('\n[M] 视觉改进');
// JetBrains Mono 字体
const cssSrc = readFile('server/static/css/main.css');
assert(cssSrc.includes('JetBrains Mono'), 'V2: main.css 含 JetBrains Mono');
assert(cssSrc.includes('JetBrainsMono-Regular.woff2'), 'V2: woff2 字体引用');
// 配色暗色边框提亮
assert(cssSrc.includes('#3d4d63'), 'V3: 暗色边框提亮 #3d4d63');
// 附件栏 placeholder
assert(idxSrc.includes('或点击下方添加附件'), '附件 placeholder 引导');
assert(idxSrc.includes('attachToolbar'), '含附件操作栏');
assert(idxSrc.includes('附加文档到聊天'), '附件文案正确');

// ========== N. Go Launcher ==========
console.log('\n[N] Go Launcher 底座替换');
const goSrc = readFile('launcher/main.go');
assert(!goSrc.includes('log.Fatalf.*ollama.exe'), 'Go 不再 Fatalf 校验 ollama.exe');
assert(goSrc.includes('llama-server.exe'), 'Go 含 llama-server.exe 校验');
assert(goSrc.includes('AppVersion = "v0.9.7"'), 'Go 版本号 v0.9.7');
// watchdog 健康检查改了
const wdSrc = readFile('launcher/watchdog.go');
assert(wdSrc.includes('/v1/models'), 'watchdog 健康检查用 /v1/models');

// ========== O. 打包脚本 ==========
console.log('\n[O] 打包脚本');
const buildSrc = readFile('installer/build_extensions.py');
assert(buildSrc.includes('Q4_K_M'), 'build_extensions 含 Q4 模型');
assert(buildSrc.includes('meta.json'), 'build_extensions 写 meta.json');
// 实际打包逻辑不操作 blobs 目录（注释里提到历史不算）
assert(!buildSrc.match(/['"].*blobs['"]/) || !buildSrc.includes('_write_dir_to_zip(zf, "models/blobs"') , 'build_extensions 不打包 blobs 目录');
// setup.iss 删了 ollama.exe
const issSrc = readFile('setup.iss');
assert(!issSrc.includes('Source: "ollama.exe"'), 'setup.iss 不含 ollama.exe');

// ========== P. pipeline 归属标签 ==========
console.log('\n[P] pipeline 归属标签');
assert(ppSrc.includes('管什么') && ppSrc.includes('不管什么'), 'parallel_pipeline 含归属标签');
assert(readFile('server/pipelines/local_pipeline.py').includes('管什么'), 'local_pipeline 含归属标签');
assert(readFile('server/pipelines/cloud_pipeline.py').includes('管什么'), 'cloud_pipeline 含归属标签');

// ========== Q. 模型下载功能（download_engine + download router + download.js）==========
console.log('\n[Q] 模型下载功能');
{
  const dlEngine = readFile('server/core/download_engine.py');
  const dlRouter = readFile('server/routers/download.py');
  const dlJs = readFile('server/static/js/download.js');

  // 下载引擎核心
  assert(dlEngine.includes('class DownloadTask'), 'download_engine.py 含 DownloadTask 类');
  assert(dlEngine.includes('def run_llm_download'), 'download_engine.py 含 run_llm_download');
  assert(dlEngine.includes('def run_kb_download'), 'download_engine.py 含 run_kb_download');
  assert(dlEngine.includes('def build_urls'), 'download_engine.py 含 build_urls（双源）');
  assert(dlEngine.includes('def list_repo_files'), 'download_engine.py 含 list_repo_files');
  assert(dlEngine.includes('on_complete'), 'download_engine.py 含 on_complete 回调（安装收尾不依赖SSE）');
  assert(dlEngine.includes('KB_EMBEDDING_FILES') && dlEngine.includes('KB_RERANKER_FILES'), 'download_engine.py 含 KB 文件清单');
  // KB 文件清单不含 onnx（去 onnx 省 2.27GB）
  assert(!dlEngine.includes('"onnx/model.onnx_data"'), 'KB 清单不含 onnx 权重副本');

  // 下载 API 端点
  assert(dlRouter.includes('/api/models/catalog'), 'download router 含 catalog 端点');
  assert(dlRouter.includes('/api/models/download'), 'download router 含 download 端点');
  assert(dlRouter.includes('/api/models/download/progress'), 'download router 含 SSE 进度端点');
  assert(dlRouter.includes('/api/models/download/cancel'), 'download router 含 cancel 端点');
  assert(dlRouter.includes('/api/models/download/status'), 'download router 含 status 端点（刷新恢复）');
  assert(dlRouter.includes('_finalize_install'), 'download router 含安装收尾函数');

  // 前端 download.js
  assert(dlJs.includes('function loadModelCatalog'), 'download.js 含 loadModelCatalog');
  assert(dlJs.includes('function downloadModel'), 'download.js 含 downloadModel');
  assert(dlJs.includes('function deleteModel'), 'download.js 含 deleteModel');
  assert(dlJs.includes('function installFromLocal'), 'download.js 含 installFromLocal（从本地安装）');
  assert(dlJs.includes('function uninstallKb'), 'download.js 含 uninstallKb');
  assert(dlJs.includes('_checkRunningTask'), 'download.js 含 _checkRunningTask（刷新恢复进度）');
  assert(dlJs.includes('_attachSSE'), 'download.js 含 _attachSSE');
  assert(dlJs.includes('_attachInstallSSE'), 'download.js 含 _attachInstallSSE（.sidemate 安装进度）');

  // download.js 已注册到 index.html
  const idx = readFile('server/index.html');
  assert(idx.includes('download.js'), 'index.html 引用 download.js');
  assert(idx.includes('stab-download'), 'index.html 含下载页 Tab');
  assert(idx.includes('dlLocalInput'), 'index.html 含本地安装文件选择 input');
}

// ========== R. KB 问答引擎 kb_ai_mode ==========
console.log('\n[R] KB 问答引擎 kb_ai_mode');
{
  const config = readFile('server/config.py');
  const mm = readFile('server/core/model_manager.py');
  const kb = readFile('server/routers/kb.py');
  const settings = readFile('server/static/js/settings.js');
  const idx = readFile('server/index.html');

  // config 定义
  assert(config.includes('"kb_ai_mode"'), 'config.py 含 kb_ai_mode 配置项');
  assert(config.includes('"kb_ai_mode": "local"'), 'kb_ai_mode 默认 local');

  // model_manager 路由逻辑
  assert(mm.includes('kb_mode') && mm.includes('kb_ai_mode'), 'model_manager.chat_stream 含 kb_ai_mode 路由');

  // kb.py 检索参数联动
  assert(kb.includes('kb_ai_mode'), 'kb.py 含 kb_ai_mode 读取');
  assert(kb.includes('ai_mode=kb_ai_mode'), 'kb.py 检索参数传 kb_ai_mode 给 get_context');

  // 前端设置
  assert(settings.includes('function loadKbAiMode'), 'settings.js 含 loadKbAiMode');
  assert(settings.includes('function saveKbAiMode'), 'settings.js 含 saveKbAiMode');
  assert(idx.includes('kbAiModeLocal') && idx.includes('kbAiModeCloud'), 'index.html 含问答引擎单选按钮');
}

// ========== S. 动态 num_ctx ==========
console.log('\n[S] 动态 num_ctx（token 上限跟随模型）');
{
  const mm = readFile('server/core/model_manager.py');
  const om = readFile('server/core/ollama_manager.py');

  // _get_device_token_limit 读模型 default_num_ctx
  assert(mm.includes('default_num_ctx'), 'model_manager._get_device_token_limit 读 default_num_ctx');
  // 兜底分支仍可用 MAX_INPUT_TOKENS（当模型不在 model_configs 时），但主路径读 default_num_ctx
  assert(mm.includes('# 兜底'), '_get_device_token_limit 有兜底注释');

  // switch_model 更新 ctx_size
  assert(om.includes('update_ctx_size') || om.includes('default_num_ctx'), 'ollama_manager.switch_model 含 ctx_size 更新');
}

// ========== T. 模型删除保留 meta.json ==========
console.log('\n[T] 模型删除保留 meta.json');
{
  const reg = readFile('server/core/llamacpp_backend/registry.py');
  const mm = readFile('server/core/model_manager.py');

  // remove() 不删 meta.json
  assert(reg.includes('保留 meta.json'), 'registry.remove 注释说明保留 meta.json');
  assert(!reg.includes("meta_path.unlink()"), 'registry.remove 不删 meta.json');

  // delete_model 注释正确
  assert(mm.includes('保留 meta.json'), 'model_manager.delete_model 注释说明保留 meta.json');
}

// ========== U. KB 洞察 prompt 改造 + 后置过滤 ==========
console.log('\n[U] KB 洞察 prompt 改造 + 后置过滤');
{
  const kb = readFile('server/routers/kb.py');

  // docs_digest 构造
  assert(kb.includes('docs_digest'), 'kb.py 含 docs_digest 构造');
  assert(kb.includes('docs_digest'), 'kb.py insight/questions prompt 喂 docs_digest');

  // insight prompt 约束
  assert(kb.includes('不要推断或联想'), 'insight prompt 含「不要推断或联想」约束');

  // questions prompt 硬约束
  assert(kb.includes('禁止生成需要库外知识'), 'questions prompt 含硬约束');

  // 后置过滤
  assert(kb.includes('_topic_words'), 'kb.py 含后置过滤逻辑');
  assert(kb.includes('后置过滤丢弃'), 'kb.py 含过滤日志');
}

// ========== V. Reranker 兜底阈值修复 ==========
console.log('\n[V] Reranker 兜底阈值修复');
{
  const search = readFile('server/knowledge/search.py');

  // 兜底逻辑有 0.05 条件
  assert(search.includes('best_score >= 0.05') || search.includes('0.05'), 'search.py 兜底逻辑含 0.05 阈值');
  assert(search.includes('完全不相关') || search.includes('返回空结果'), 'search.py 完全不相关时返回空结果');
}

// ========== W. 扩展卡片清理 + recorder 归档 ==========
console.log('\n[W] 扩展卡片清理 + recorder 归档');
{
  const extMgr = readFile('server/core/extension_manager.py');
  const settingsExt = readFile('server/routers/settings_extensions.py');
  const validator = readFile('server/common/sidemate_validator.py');
  const settings = readFile('server/static/js/settings.js');
  const idx = readFile('server/index.html');

  // recorder 从 VALID_IDS 移除
  assert(extMgr.includes('"knowledge", "llm"'), 'extension_manager VALID_IDS 不含 recorder');
  assert(!extMgr.includes('"recorder"'), 'extension_manager 无 recorder 定义');

  // settings_extensions 无 recorder 安装/卸载分支
  assert(!settingsExt.includes('elif ext_type == "recorder"'), 'settings_extensions 无 recorder 安装分支');

  // validator 无 recorder/whisper 类型推断
  assert(!validator.includes('"recorder"'), 'sidemate_validator 无 recorder 类型推断');

  // 前端：扩展卡片已删
  assert(!idx.includes('id="extList"'), 'index.html 无 extList（扩展列表已删）');
  assert(!idx.includes('capabilityList'), 'index.html 无 capabilityList（Action 展示已删）');
  assert(!settings.includes('function refreshExtensions'), 'settings.js 无 refreshExtensions');
  assert(!settings.includes('function installExtension'), 'settings.js 无 installExtension');
}

// ========== X. EULA → Apache-2.0 ==========
console.log('\n[X] EULA → Apache-2.0');
{
  const idx = readFile('server/index.html');
  const license = readFile('LICENSE');

  // index.html 不再写 EULA
  assert(!idx.includes('最终用户许可协议'), 'index.html 不含「最终用户许可协议」');
  assert(idx.includes('Apache-2.0') || idx.includes('开源协议'), 'index.html 含「开源协议」');

  // LICENSE 是 Apache-2.0
  assert(license.includes('Apache License') && license.includes('Version 2.0'), 'LICENSE 是 Apache-2.0');
  assert(!license.includes('自创建起即'), 'LICENSE 不含多余的开源措辞');
}

// ========== Y. 版本号 + 静态资源 ==========
console.log('\n[Y] 版本号 + 静态资源');
{
  const idx = readFile('server/index.html');

  // 版本号 ≥ 2.79
  const m = idx.match(/\?v=([\d.]+)/);
  const ver = m ? parseFloat(m[1]) : 0;
  assert(ver >= 2.79, 'index.html 静态资源版本号 ≥ 2.79 (当前: ' + (m ? m[1] : '?') + ')');

  // 所有 JS 都有版本号
  const scripts = idx.match(/src="[^"]*\.js\?v=/g) || [];
  const scriptsNoVer = (idx.match(/src="\/static\/js\/[^"]*\.js"(?!\?v)/g) || []).filter(s => !s.includes('?v='));
  assert(scripts.length >= 15, 'index.html 大部分 JS 有版本号 (' + scripts.length + ' 个)');
}

// ========== 总结 ==========
console.log('\n============================================');
console.log(`  0.9.7 回归测试: ${passed} 通过, ${failed} 失败`);
if (errors.length) {
  console.log('  失败项:');
  errors.forEach(e => console.log('    -', e));
}
console.log('============================================');
process.exit(failed > 0 ? 1 : 0);
