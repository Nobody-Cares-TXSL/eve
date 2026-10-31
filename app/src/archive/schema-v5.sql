-- Eve T6-3a handoff v5, explicit transactional migration from v4.
--
-- 目的：把「T5 决策」与「T6 发送意图」在同一个事务里绑定，
-- 并让 reply.delayMs 真正约束发送时间（not_before_ms）。
--
-- 不改写 schema-v4.sql：v4 是已建立测试基线的状态机。
-- 旧 v4 行两列为 NULL，仍可读；只有新的受信交接写入会带上绑定。

-- 可信来源绑定：哪一条 T5 claim 产生了这个意图
ALTER TABLE send_intents ADD COLUMN ai_claim_id TEXT REFERENCES ai_decision_attempts(claim_id);
-- 一条 T5 决策最多产生一个发送意图
CREATE UNIQUE INDEX ux_send_intents_ai_claim
  ON send_intents(ai_claim_id) WHERE ai_claim_id IS NOT NULL;

-- 最早允许发送时间 = 结算时刻 + reply.delayMs；NULL 表示旧 v4 行（不可用于真实发送）
ALTER TABLE send_intents ADD COLUMN not_before_ms INTEGER;

-- 两列必须同时存在或同时缺失：避免出现「有来源无延迟」或「有延迟无来源」的半绑定。
-- SQLite 的 ALTER 无法加表级 CHECK，用触发器补足。
CREATE TRIGGER trg_send_intents_handoff_binding
BEFORE INSERT ON send_intents
FOR EACH ROW
WHEN (NEW.ai_claim_id IS NULL) <> (NEW.not_before_ms IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'handoff_binding_incomplete');
END;
