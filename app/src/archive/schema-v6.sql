-- Eve T6-3c-real-A L1 approval ledger v6, explicit transactional migration from v5.
--
-- 之前审批只是随调用传入的对象——能构造对象就等于「已批准」。
-- v6 把审批变成数据库中可核验、且**只能消费一次**的记录。
--
-- 审批绑定四件事：意图、接收方、正文摘要、有效期。
-- 任一不符即不得发送；消费后不可再用（sent/failed/unknown 都是终态）。

CREATE TABLE send_approvals (
  approval_id TEXT PRIMARY KEY CHECK (approval_id GLOB '[A-Za-z0-9_-][A-Za-z0-9_-][A-Za-z0-9_-][A-Za-z0-9_-][A-Za-z0-9_-][A-Za-z0-9_-][A-Za-z0-9_-][A-Za-z0-9_-]*' AND length(approval_id) <= 64),
  intent_id TEXT NOT NULL REFERENCES send_intents(intent_id),
  recipient_uid TEXT NOT NULL,
  text_digest TEXT NOT NULL CHECK (length(text_digest) = 64),
  approved_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  consumed_at_ms INTEGER,
  CHECK (expires_at_ms > approved_at_ms),
  CHECK (recipient_uid GLOB '[0-9]*' AND length(recipient_uid) BETWEEN 1 AND 64),
  CHECK (consumed_at_ms IS NULL
         OR (consumed_at_ms >= approved_at_ms AND consumed_at_ms < expires_at_ms))
) STRICT;

-- 一个意图至多一份审批记录（终态后不允许再批准重发）
CREATE UNIQUE INDEX ux_send_approvals_intent ON send_approvals(intent_id);
