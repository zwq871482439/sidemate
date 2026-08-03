# -*- coding: utf-8 -*-
"""
core/access_token.py — 令牌授权系统（Patch5 T01/T03）
=====================================================

支持三种令牌级别：
  - "full"：全文可见（私密文档内容可被云端 AI 读取）
  - "search"：仅搜索可见（私密文档可被检索但不暴露全文内容）
  - "none"：不可见（私密文档完全不出现在结果中）

令牌仅存内存，进程重启后失效（P5 设计决策：不持久化令牌）。
私密标记 is_private 持久化到 kb_meta.json（通过 KBDocument.is_private 字段）。

用法：
    from core.access_token import get_access_token_manager
    mgr = get_access_token_manager()
    token = mgr.generate_full_token("doc_xxx")
    is_valid, level = mgr.verify_token(token, "doc_xxx")
    accessible_ids = mgr.filter_private_docs(all_doc_ids, token)
"""
import time
import secrets
import logging
from dataclasses import dataclass, field
from typing import Dict, List, Tuple, Optional

log = logging.getLogger(__name__)


@dataclass
class AccessToken:
    """访问令牌数据结构

    Attributes:
        token: 32 字节随机 hex 字符串
        doc_id: 绑定的文档 ID
        level: 令牌级别 "full" | "search" | "none"
        session_id: 关联的会话 ID（空字符串 = 未关联）
        created_at: 创建时间（unix timestamp）
        expires_at: 过期时间（0=永不过期）
    """
    token: str
    doc_id: str
    level: str          # "full" | "search" | "none"
    session_id: str = ""  # 关联的会话 ID
    created_at: float = 0.0
    expires_at: float = 0.0  # 0 = 永不过期


class AccessTokenManager:
    """令牌授权系统管理器

    令牌格式：32 字节 hex（secrets.token_hex(32) = 64 字符）
    签名：无（P5 仅做简单随机令牌，HMAC 签名留待后续版本）

    令牌级别语义：
      - full：可读取私密文档的完整内容
      - search：可检索到私密文档（返回 chunk 文本），但不暴露文档级摘要
      - none：私密文档完全不可见（不出现在搜索结果中）

    私密文档过滤逻辑：
      - is_private=False 的文档：所有令牌级别（包括无令牌）均可访问
      - is_private=True 的文档：
          * 无令牌或令牌级别=none → 不可见
          * 令牌级别=search → 可见（搜索结果中出现）
          * 令牌级别=full → 完全可见（内容也可被云端读取）
    """

    def __init__(self, default_ttl: float = 0):
        """初始化令牌管理器

        Args:
            default_ttl: 令牌默认有效期（秒），0=永不过期
        """
        self._default_ttl = default_ttl
        # 令牌缓存：token_string → AccessToken
        self._tokens_cache: Dict[str, AccessToken] = {}
        # doc_id → {token_string} 的反向索引（方便按 doc_id 撤销）
        self._doc_tokens: Dict[str, set] = {}
        # P6 审计修复 C7：并发锁，所有读写操作必须持锁
        import threading as _threading
        self._lock = _threading.Lock()

    def _generate_token_string(self) -> str:
        """生成随机令牌字符串（32 字节 hex = 64 字符）

        Returns:
            64 字符的 hex 字符串
        """
        return secrets.token_hex(32)

    def _create_token(self, doc_id: str, level: str, ttl: float = None,
                      session_id: str = "") -> AccessToken:
        """创建令牌并存入缓存（线程安全）

        P5 审计修复 P2-13: 每个 doc_id 最多保留 MAX_TOKENS_PER_DOC 个令牌，
        超限时 LRU 淘汰最旧的令牌。
        P6 审计修复 C7：所有读写操作加 self._lock 保护

        Args:
            doc_id: 绑定的文档 ID
            level: 令牌级别 "full" | "search"
            ttl: 有效期（秒），None 则使用默认值
            session_id: 关联的会话 ID（空字符串 = 未关联）

        Returns:
            AccessToken 对象
        """
        with self._lock:
            now = time.time()
            effective_ttl = self._default_ttl if ttl is None else ttl
            expires_at = now + effective_ttl if effective_ttl > 0 else 0

            # P2-13: LRU 淘汰 — 每个 doc_id 最多 MAX_TOKENS_PER_DOC 个令牌
            MAX_TOKENS_PER_DOC = 1000
            doc_token_set = self._doc_tokens.setdefault(doc_id, set())
            if len(doc_token_set) >= MAX_TOKENS_PER_DOC:
                # P6 审计修复 LOW: 过滤掉已不在缓存的 token 再 min
                valid_tokens = [t for t in doc_token_set if t in self._tokens_cache]
                if valid_tokens:
                    oldest_token = min(valid_tokens,
                                       key=lambda t: self._tokens_cache[t].created_at)
                    self._remove_token_unlocked(oldest_token)

            token_str = self._generate_token_string()
            access_token = AccessToken(
                token=token_str,
                doc_id=doc_id,
                level=level,
                session_id=session_id or "",
                created_at=now,
                expires_at=expires_at,
            )
            self._tokens_cache[token_str] = access_token
            # 反向索引
            if doc_id not in self._doc_tokens:
                self._doc_tokens[doc_id] = set()
            self._doc_tokens[doc_id].add(token_str)

            log.info("[ACCESS_TOKEN] 生成令牌: doc_id=%s, level=%s, expires_at=%s",
                     doc_id, level, "never" if expires_at == 0 else str(expires_at))
            return access_token

    def generate_full_token(self, doc_id: str, ttl: float = None,
                            session_id: str = "") -> str:
        """生成全文令牌（full 级别）

        Args:
            doc_id: 文档 ID
            ttl: 有效期（秒），None 则使用默认值
            session_id: 关联的会话 ID

        Returns:
            令牌字符串
        """
        token = self._create_token(doc_id, "full", ttl, session_id=session_id)
        return token.token

    def generate_search_token(self, doc_id: str, ttl: float = None,
                              session_id: str = "") -> str:
        """生成搜索令牌（search 级别）

        Args:
            doc_id: 文档 ID
            ttl: 有效期（秒），None 则使用默认值
            session_id: 关联的会话 ID

        Returns:
            令牌字符串
        """
        token = self._create_token(doc_id, "search", ttl, session_id=session_id)
        return token.token

    def verify_token(self, token: str, doc_id: str = None) -> Tuple[bool, str]:
        """验证令牌有效性（线程安全）

        Args:
            token: 令牌字符串
            doc_id: 可选，如果提供则检查令牌是否绑定到此文档

        Returns:
            (is_valid: bool, level: str)
            is_valid=True 时 level 为 "full"/"search"/"none"
            is_valid=False 时 level 固定为 "none"
        """
        if not token:
            return False, "none"

        with self._lock:
            access_token = self._tokens_cache.get(token)
            if access_token is None:
                return False, "none"

            # 检查过期
            if access_token.expires_at > 0 and time.time() > access_token.expires_at:
                # 过期令牌自动清理
                self._remove_token_unlocked(token)
                log.info("[ACCESS_TOKEN] 令牌已过期: doc_id=%s", access_token.doc_id)
                return False, "none"

            # 检查 doc_id 绑定（如果提供了 doc_id）
            if doc_id is not None and access_token.doc_id != doc_id:
                log.warning("[ACCESS_TOKEN] 令牌 doc_id 不匹配: expected=%s, actual=%s",
                            doc_id, access_token.doc_id)
                return False, "none"

            return True, access_token.level

    def revoke_token(self, token: str) -> bool:
        """撤销指定令牌（线程安全）

        Args:
            token: 令牌字符串

        Returns:
            是否撤销成功
        """
        with self._lock:
            return self._remove_token_unlocked(token)

    def revoke_doc_tokens(self, doc_id: str) -> int:
        """撤销某文档的所有令牌（线程安全）

        Args:
            doc_id: 文档 ID

        Returns:
            撤销的令牌数量
        """
        with self._lock:
            token_set = self._doc_tokens.pop(doc_id, set())
            count = 0
            for token_str in token_set:
                self._tokens_cache.pop(token_str, None)
                count += 1
            if count > 0:
                log.info("[ACCESS_TOKEN] 撤销文档 %s 的 %d 个令牌", doc_id, count)
            return count

    def list_tokens(self) -> list:
        """列出所有活跃令牌（线程安全）

        Returns:
            [{"doc_id": "...", "level": "...", "session_id": "...", "created_at": N}, ...]
        """
        with self._lock:
            result = []
            for token_str, access_token in self._tokens_cache.items():
                result.append({
                    "token": token_str,
                    "doc_id": access_token.doc_id,
                    "level": access_token.level,
                    "session_id": access_token.session_id or "",
                    "created_at": access_token.created_at,
                })
            return result

    def revoke_all_for_session(self, session_id: str) -> int:
        """撤销某会话的所有令牌（线程安全）

        Args:
            session_id: 会话 ID

        Returns:
            撤销的令牌数量
        """
        if not session_id:
            return 0
        with self._lock:
            to_revoke = []
            for token_str, access_token in list(self._tokens_cache.items()):
                if access_token.session_id == session_id:
                    to_revoke.append(token_str)
            count = 0
            for token_str in to_revoke:
                if self._remove_token_unlocked(token_str):
                    count += 1
            if count > 0:
                log.info("[ACCESS_TOKEN] 撤销会话 %s 的 %d 个令牌", session_id, count)
        return count

    def _remove_token_unlocked(self, token: str) -> bool:
        """从缓存中移除令牌（无锁版本，调用方必须持锁）

        P6 审计修复 C7：拆分为 locked/unlocked 两个版本，
        避免在已持锁的方法里再次获取锁导致死锁。

        Args:
            token: 令牌字符串

        Returns:
            是否移除成功
        """
        access_token = self._tokens_cache.pop(token, None)
        if access_token is None:
            return False
        # 清理反向索引
        doc_set = self._doc_tokens.get(access_token.doc_id)
        if doc_set is not None:
            doc_set.discard(token)
            if not doc_set:
                self._doc_tokens.pop(access_token.doc_id, None)
        return True

    def filter_private_docs(self, doc_ids: List[str], token: str,
                            is_private_map: Dict[str, bool] = None) -> List[str]:
        """过滤私密文档，返回可访问的文档 ID 列表

        Patch5 审计修复 P1-9: 缩小令牌作用域
          - full 令牌：只对绑定的 doc_id 放行私密文档，其他私密仍屏蔽
          - search 令牌：所有私密都屏蔽（search 令牌只能 get_context，不能读私密全文）
          - 无令牌/令牌无效：所有私密都屏蔽

        Args:
            doc_ids: 候选文档 ID 列表
            token: 令牌字符串（可为 None 或空字符串）
            is_private_map: doc_id → is_private 的映射，None 则默认全部非私密

        Returns:
            可访问的文档 ID 列表
        """
        if is_private_map is None:
            is_private_map = {}

        # 验证令牌
        is_valid, level = self.verify_token(token)

        # N-3 修复：一次性在锁内取出令牌绑定的 doc_id，避免在下方循环里无锁读 _tokens_cache。
        # 若令牌已失效/被清理，bound_doc_id 为 None，私密文档一律不放行（fail-safe）。
        bound_doc_id = None
        if is_valid and level == "full":
            with self._lock:
                _tok = self._tokens_cache.get(token)
                bound_doc_id = _tok.doc_id if _tok else None

        accessible = []
        for doc_id in doc_ids:
            is_private = is_private_map.get(doc_id, False)
            if not is_private:
                # 非私密文档：始终可访问
                accessible.append(doc_id)
            else:
                # 私密文档：只有 full 令牌绑定到此 doc_id 时才放行
                if is_valid and level == "full" and bound_doc_id == doc_id:
                    accessible.append(doc_id)
                # level == "search" 或无有效令牌 → 跳过

        return accessible


# ===== 全局单例 =====

_access_token_manager: Optional[AccessTokenManager] = None
import threading as _threading
_atm_lock = _threading.Lock()


def get_access_token_manager() -> AccessTokenManager:
    """获取全局 AccessTokenManager 单例

    P8-4：双重检查锁，防止并发首调创建多个实例（token 表分裂）。

    Returns:
        AccessTokenManager 全局实例
    """
    global _access_token_manager
    if _access_token_manager is None:
        with _atm_lock:
            if _access_token_manager is None:
                try:
                    from config import get as _cfg
                    default_ttl = _cfg("access_token_default_ttl", 0)
                except Exception:
                    default_ttl = 0
                _access_token_manager = AccessTokenManager(default_ttl=default_ttl)
    return _access_token_manager
