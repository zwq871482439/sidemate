# -*- coding: utf-8 -*-
"""
core/mcp_client.py — MCP (Model Context Protocol) 客户端（0.10 M4-5）
=====================================================================

连接外部 MCP 服务器（stdio 子进程），发现工具并代理调用。
一次接入整个第三方工具生态（文件系统/GitHub/Slack/数据库/…）。

协议（JSON-RPC 2.0 over stdio，换行分隔）：
    → {"jsonrpc":"2.0","id":1,"method":"initialize","params":{...}}
    ← {"jsonrpc":"2.0","id":1,"result":{...}}
    → {"jsonrpc":"2.0","method":"notifications/initialized"}
    → {"jsonrpc":"2.0","id":2,"method":"tools/list"}
    ← {"jsonrpc":"2.0","id":2,"result":{"tools":[{name,description,inputSchema}]}}
    → {"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"...","arguments":{...}}}
    ← {"jsonrpc":"2.0","id":3,"result":{"content":[{type:"text",text:"..."}]}}

配置（data/mcp_servers.json）：
    {"servers": [{"name": "filesystem", "command": "npx", "args": ["-y", "@anthropic/mcp-server-filesystem", "/path"]}]}
"""
from __future__ import annotations

import json
import logging
import os
import subprocess
import threading
import time
from typing import Any, Dict, List, Optional

log = logging.getLogger(__name__)

CONFIG_FILE = "mcp_servers.json"
INIT_TIMEOUT = 10
CALL_TIMEOUT = 60


def _config_path() -> str:
    from config import DATA_DIR
    return os.path.join(DATA_DIR, CONFIG_FILE)


def load_mcp_config() -> dict:
    """读取 MCP 服务器配置。"""
    try:
        with open(_config_path(), "r", encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return {"servers": []}
    except Exception as e:
        log.warning("[MCP] 配置读取失败: %s", str(e)[:80])
        return {"servers": []}


def save_mcp_config(config: dict):
    """保存 MCP 服务器配置。"""
    with open(_config_path(), "w", encoding="utf-8") as f:
        json.dump(config, f, ensure_ascii=False, indent=2)


class MCPConnection:
    """一个 MCP 服务器的连接（stdio 子进程 + JSON-RPC）。"""

    def __init__(self, name: str, command: str, args: List[str] = None):
        self.name = name
        self.command = command
        self.args = args or []
        self.proc: Optional[subprocess.Popen] = None
        self._id = 0
        self._lock = threading.Lock()
        self.tools: List[dict] = []
        self.status = "disconnected"  # disconnected | connecting | connected | error
        self.error = ""

    def _next_id(self) -> int:
        with self._lock:
            self._id += 1
            return self._id

    def _send_request(self, method: str, params: dict = None, timeout: float = 30) -> Optional[dict]:
        """发送 JSON-RPC 请求并等待响应。"""
        if not self.proc or self.proc.poll() is not None:
            return None
        req_id = self._next_id()
        req = {"jsonrpc": "2.0", "id": req_id, "method": method}
        if params:
            req["params"] = params
        try:
            self.proc.stdin.write(json.dumps(req) + "\n")
            self.proc.stdin.flush()
        except Exception as e:
            self.error = "发送失败: %s" % str(e)[:80]
            return None
        # 读响应（同 id 的行）
        deadline = time.time() + timeout
        while time.time() < deadline:
            line = self.proc.stdout.readline()
            if not line:
                time.sleep(0.05)
                continue
            try:
                resp = json.loads(line.strip())
                if resp.get("id") == req_id:
                    return resp
            except json.JSONDecodeError:
                continue
        return None

    def connect(self) -> bool:
        """启动子进程并完成 MCP 握手 + 工具发现。"""
        self.status = "connecting"
        try:
            self.proc = subprocess.Popen(
                [self.command] + self.args,
                stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                stderr=subprocess.PIPE, text=True, encoding="utf-8",
                cwd=os.path.dirname(_config_path()),
            )
        except Exception as e:
            self.status = "error"
            self.error = "启动失败: %s" % str(e)[:120]
            log.warning("[MCP:%s] %s", self.name, self.error)
            return False

        # initialize 握手
        resp = self._send_request("initialize", {
            "protocolVersion": "2024-11-05",
            "capabilities": {"tools": {}},
            "clientInfo": {"name": "sidemate", "version": "0.10"},
        }, timeout=INIT_TIMEOUT)
        if not resp or "result" not in resp:
            self.status = "error"
            self.error = "初始化握手失败（无响应或格式错误）"
            log.warning("[MCP:%s] %s", self.name, self.error)
            return False

        # initialized 通知（无 id，不期望响应）
        try:
            self.proc.stdin.write(json.dumps({
                "jsonrpc": "2.0", "method": "notifications/initialized"
            }) + "\n")
            self.proc.stdin.flush()
        except Exception:
            pass

        # 工具发现
        resp = self._send_request("tools/list", timeout=INIT_TIMEOUT)
        if resp and "result" in resp:
            self.tools = resp["result"].get("tools", [])
            self.status = "connected"
            log.info("[MCP:%s] 连接成功，发现 %d 个工具: %s",
                     self.name, len(self.tools),
                     ", ".join(t["name"] for t in self.tools[:5]))
            return True
        self.status = "error"
        self.error = "工具发现失败"
        return False

    def call_tool(self, tool_name: str, arguments: dict) -> dict:
        """调用 MCP 工具并返回结果。"""
        resp = self._send_request("tools/call", {
            "name": tool_name, "arguments": arguments,
        }, timeout=CALL_TIMEOUT)
        if not resp:
            return {"error": "调用超时或连接断开"}
        if "error" in resp:
            return {"error": str(resp["error"].get("message", "MCP 错误"))[:200]}
        result = resp.get("result", {})
        # MCP 返回 content 数组，取文本部分
        texts = []
        for c in result.get("content", []):
            if c.get("type") == "text":
                texts.append(c.get("text", ""))
        return {"ok": not result.get("isError", False),
                "text": "\n".join(texts)[:10000]}

    def disconnect(self):
        """关闭连接。"""
        if self.proc:
            try:
                self.proc.terminate()
                self.proc.wait(timeout=3)
            except Exception:
                self.proc.kill()
            self.proc = None
        self.status = "disconnected"
        self.tools = []


class MCPManager:
    """管理所有 MCP 服务器连接。"""

    def __init__(self):
        self.connections: Dict[str, MCPConnection] = {}
        self._lock = threading.Lock()

    def connect_all(self) -> int:
        """按配置连接所有服务器，返回成功数。"""
        config = load_mcp_config()
        connected = 0
        for srv in config.get("servers", []):
            name = srv.get("name", "")
            if not name:
                continue
            conn = make_connection(srv)
            if conn.connect():
                with self._lock:
                    self.connections[name] = conn
                connected += 1
        return connected

    def get_all_tools(self) -> List[dict]:
        """获取所有已连接服务器的工具（TOOL_REGISTRY 注册用）。"""
        tools = []
        for name, conn in self.connections.items():
            if conn.status != "connected":
                continue
            for t in conn.tools:
                tools.append({
                    "server": name,
                    "name": t["name"],
                    "description": t.get("description", ""),
                    "inputSchema": t.get("inputSchema", {}),
                })
        return tools

    def call(self, server: str, tool: str, arguments: dict) -> dict:
        """调用指定服务器的工具。"""
        conn = self.connections.get(server)
        if not conn or conn.status != "connected":
            return {"error": "MCP 服务器 %s 未连接" % server}
        return conn.call_tool(tool, arguments)

    def status(self) -> List[dict]:
        """所有服务器状态（设置页展示用；0.11 B2 带 transport/url/auth 供本地/远程分组）。"""
        out = []
        for name, conn in self.connections.items():
            entry = {"name": name, "status": conn.status,
                     "tools": len(conn.tools), "error": conn.error}
            if isinstance(conn, HTTPConnection):
                entry.update({
                    "transport": conn.transport,      # http | sse
                    "remote": True,
                    "url": conn.url,
                    "auth": ("Bearer/API-Key" if conn._auth_ok() else ""),
                    "authed": conn._auth_ok(),
                })
            else:
                entry.update({"transport": "stdio", "remote": False,
                              "url": " ".join([conn.command] + (conn.args or [])[:2])})
            out.append(entry)
        return out

    def disconnect_all(self):
        """断开所有连接。"""
        for conn in self.connections.values():
            conn.disconnect()
        self.connections.clear()


# 全局单例
_manager: Optional[MCPManager] = None

def get_mcp_manager() -> MCPManager:
    global _manager
    if _manager is None:
        _manager = MCPManager()
    return _manager


# ============================================================
#  0.11 B2：远程传输（Streamable HTTP，含 SSE 响应解析）
# ============================================================

class HTTPConnection:
    """Streamable HTTP 传输的 MCP 连接（远程服务器，如 GitHub/Slack 官方 MCP）。

    与 MCPConnection（stdio）同接口：connect / call_tool / disconnect。
    协议：POST JSON-RPC 到单一 URL，Accept 同时列 json 与 SSE；
    响应为 JSON 或 text/event-stream（逐行 data: 拼 JSON），按 id 匹配。
    认证：headers 注入（API-Key / Bearer），响应头 Mcp-Session-Id 会话续用。
    """

    def __init__(self, name: str, url: str, headers: Dict[str, str] = None,
                 transport: str = "http"):
        self.name = name
        self.url = (url or "").strip()
        self.headers = dict(headers or {})
        self.transport = transport          # http（streamable）| sse（legacy SSE 端点）
        self.tools: List[dict] = []
        self.status = "disconnected"        # disconnected | connecting | connected | error
        self.error = ""
        self._session_id = ""
        self._id = 0
        self._lock = threading.Lock()

    def _next_id(self) -> int:
        with self._lock:
            self._id += 1
            return self._id

    def _auth_ok(self) -> bool:
        """至少带了一个认证头（Authorization / X-Api-Key / query token 常见三种里的前两种）。"""
        keys = {k.lower() for k in self.headers}
        return "authorization" in keys or "x-api-key" in keys

    def _post(self, payload: dict, timeout: float = 30) -> Optional[dict]:
        """POST 一条 JSON-RPC，返回匹配的 result/error（None=失败）。"""
        import httpx
        hdrs = {
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
        }
        hdrs.update(self.headers)
        if self._session_id:
            hdrs["Mcp-Session-Id"] = self._session_id
        try:
            r = httpx.post(self.url, json=payload, headers=hdrs, timeout=timeout)
        except Exception as e:
            self.error = "请求失败: %s" % str(e)[:100]
            return None
        if r.status_code == 404 and self._session_id:
            # 会话过期：丢掉重试一次（Streamable HTTP 规范的服务端行为）
            self._session_id = ""
            return self._post(payload, timeout)
        if r.status_code >= 400:
            self.error = "HTTP %d: %s" % (r.status_code, r.text[:120])
            return None
        sid = r.headers.get("mcp-session-id") or r.headers.get("Mcp-Session-Id")
        if sid:
            self._session_id = sid
        ctype = (r.headers.get("content-type") or "").lower()
        body = r.text.strip()
        if "text/event-stream" in ctype or (not ctype and body.startswith("event:") or body.startswith("data:")):
            return self._parse_sse(body, payload.get("id"))
        try:
            resp = json.loads(body)
            if isinstance(resp, dict) and resp.get("id") == payload.get("id"):
                return resp
            return resp if isinstance(resp, dict) else None
        except (json.JSONDecodeError, TypeError):
            return None

    @staticmethod
    def _parse_sse(text: str, want_id) -> Optional[dict]:
        """解析 SSE 响应体：拼 data: 行为 JSON，按 id 匹配。"""
        for block in text.split("\n\n"):
            data_lines = [ln[5:].strip() for ln in block.split("\n") if ln.startswith("data:")]
            if not data_lines:
                continue
            try:
                ev = json.loads("".join(data_lines))
            except json.JSONDecodeError:
                continue
            if isinstance(ev, dict) and (want_id is None or ev.get("id") == want_id):
                return ev
        return None

    def connect(self) -> bool:
        """握手 + 工具发现（Streamable HTTP）。"""
        if not self.url:
            self.status = "error"
            self.error = "缺少 URL"
            return False
        if not self._auth_ok():
            self.status = "error"
            self.error = "未配置认证（headers 需含 Authorization 或 X-Api-Key）"
            return False
        self.status = "connecting"
        resp = self._post({
            "jsonrpc": "2.0", "id": self._next_id(), "method": "initialize",
            "params": {
                "protocolVersion": "2025-03-26",
                "capabilities": {"tools": {}},
                "clientInfo": {"name": "sidemate", "version": "0.11"},
            },
        }, timeout=INIT_TIMEOUT)
        if not resp or "result" not in resp:
            self.status = "error"
            self.error = self.error or "初始化握手失败（无响应或格式错误）"
            log.warning("[MCP:%s/http] %s", self.name, self.error)
            return False
        # initialized 通知（规范要求 POST，响应 202 即可，忽略）
        try:
            self._post({"jsonrpc": "2.0", "method": "notifications/initialized"}, timeout=10)
        except Exception:
            pass
        self.error = ""
        resp = self._post({"jsonrpc": "2.0", "id": self._next_id(),
                           "method": "tools/list"}, timeout=INIT_TIMEOUT)
        if resp and "result" in resp:
            self.tools = resp["result"].get("tools", [])
            self.status = "connected"
            log.info("[MCP:%s/http] 连接成功，发现 %d 个工具", self.name, len(self.tools))
            return True
        self.status = "error"
        self.error = self.error or "工具发现失败"
        return False

    def call_tool(self, tool_name: str, arguments: dict) -> dict:
        """调用 MCP 工具并返回结果（与 stdio 版同构）。"""
        resp = self._post({
            "jsonrpc": "2.0", "id": self._next_id(), "method": "tools/call",
            "params": {"name": tool_name, "arguments": arguments},
        }, timeout=CALL_TIMEOUT)
        if not resp:
            return {"error": self.error or "调用超时或连接断开"}
        if "error" in resp:
            return {"error": str(resp["error"].get("message", "MCP 错误"))[:200]}
        result = resp.get("result", {})
        texts = []
        for c in result.get("content", []):
            if c.get("type") == "text":
                texts.append(c.get("text", ""))
        return {"ok": not result.get("isError", False),
                "text": "\n".join(texts)[:10000]}

    def disconnect(self):
        self._session_id = ""
        self.status = "disconnected"
        self.tools = []


def make_connection(srv: dict):
    """按配置创建连接：stdio（command）| http（type/url）。"""
    name = srv.get("name", "")
    ctype = (srv.get("type") or "").lower()
    if ctype in ("http", "sse") or (not ctype and srv.get("url") and not srv.get("command")):
        return HTTPConnection(name, srv.get("url", ""), srv.get("headers") or {},
                              transport=ctype or "http")
    return MCPConnection(name, srv.get("command", ""), srv.get("args", []))
