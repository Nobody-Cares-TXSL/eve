-- Eve T6 send ledger v4, explicit transactional migration from v3.
--
-- 设计要点（docs/contracts/send.md §8）：
--   * 幂等：UNIQUE(conversation_id, source_event_id)
--   * 一批合并消息只属于一个意图：send_intent_events 以 (conversation_id, server_message_id) 为主键
--   * 正文与账本分离：send_text 独立表，带 expires_at_ms，可单独清理
--   * 状态机只允许 pending→dispatching→sent/failed/unknown
CREATE TABLE send_intents (
  intent_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  text_digest TEXT NOT NULL,
  decision_digest TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','dispatching','sent','failed','unknown')),
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  reason_code TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  claimed_at_ms INTEGER,
  settled_at_ms INTEGER,
  evidence TEXT,
  UNIQUE (conversation_id, source_event_id),
  -- 每个状态必须自洽：pending 未认领未结算；dispatching 已认领未结算；终态已结算
  CHECK (
    (status = 'pending'     AND claimed_at_ms IS NULL     AND settled_at_ms IS NULL AND reason_code IS NULL AND evidence IS NULL)
    OR (status = 'dispatching' AND claimed_at_ms IS NOT NULL AND settled_at_ms IS NULL AND evidence IS NULL)
    OR (status = 'sent'      AND settled_at_ms IS NOT NULL AND reason_code IS NULL     AND evidence IS NOT NULL)
    OR (status IN ('failed','unknown') AND settled_at_ms IS NOT NULL AND reason_code IS NOT NULL AND evidence IS NULL)
  )
) STRICT;
CREATE INDEX idx_send_intents_status ON send_intents(status, updated_at_ms);

-- 同一服务端事件只能属于一个发送意图：防止一批消息被拆成多个意图
CREATE TABLE send_intent_events (
  conversation_id TEXT NOT NULL,
  server_message_id TEXT NOT NULL,
  intent_id TEXT NOT NULL REFERENCES send_intents(intent_id),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  PRIMARY KEY (conversation_id, server_message_id),
  UNIQUE (intent_id, ordinal)
) STRICT;

-- 正文独立受限存储：与账本分表，便于按 expires_at_ms 单独清理。
-- T5 的 decision_digest 只是摘要，不能据此恢复正文；正文只存在这里。
CREATE TABLE send_text (
  intent_id TEXT PRIMARY KEY REFERENCES send_intents(intent_id),
  body TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  CHECK (expires_at_ms > created_at_ms)
) STRICT;
CREATE INDEX idx_send_text_expiry ON send_text(expires_at_ms);
