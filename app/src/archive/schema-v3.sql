-- Eve T5 dry-run ledger v3, explicit transactional migration from v2.
-- No message bodies, reasoning text, credentials, or tool outputs persisted here.
CREATE TABLE ai_decision_attempts (
 claim_id TEXT PRIMARY KEY,
 conversation_id TEXT NOT NULL,
 server_message_id TEXT NOT NULL,
 proof_epoch_id TEXT NOT NULL REFERENCES reconcile_epochs(epoch_id),
 backend_id TEXT NOT NULL,
 backend_kind TEXT NOT NULL CHECK (backend_kind IN ('model-api','agent-runtime')),
 state TEXT NOT NULL CHECK (state IN ('claimed','recorded','blocked','interrupted')),
 claimed_at_ms INTEGER NOT NULL,
 finished_at_ms INTEGER,
 action TEXT CHECK (action IN ('reply','skip','defer')),
 event_digest TEXT NOT NULL,
 decision_digest TEXT,
 reply_length INTEGER,
 failure_code TEXT,
 UNIQUE(conversation_id,server_message_id),
 FOREIGN KEY(conversation_id,server_message_id)
 REFERENCES eligible_events(conversation_id,server_message_id),
 CHECK(
  (state='claimed' AND finished_at_ms IS NULL AND action IS NULL AND decision_digest IS NULL AND failure_code IS NULL)
  OR (state='recorded' AND finished_at_ms IS NOT NULL AND action IS NOT NULL
      AND decision_digest IS NOT NULL AND reply_length IS NOT NULL AND failure_code IS NULL)
  OR (state IN ('blocked','interrupted') AND finished_at_ms IS NOT NULL
      AND action IS NULL AND decision_digest IS NULL AND reply_length IS NULL AND failure_code IS NOT NULL)
 )
) STRICT;
CREATE INDEX idx_ai_attempts_state ON ai_decision_attempts(state, claimed_at_ms);

-- Every event in a grouped AI request is reserved in the same transaction.
-- The lead event also appears here, so an event can never belong to two groups.
CREATE TABLE ai_batch_items (
 claim_id TEXT NOT NULL REFERENCES ai_decision_attempts(claim_id),
 conversation_id TEXT NOT NULL,
 server_message_id TEXT NOT NULL,
 ordinal INTEGER NOT NULL CHECK(ordinal >= 0 AND ordinal < 4),
 PRIMARY KEY(conversation_id,server_message_id),
 UNIQUE(claim_id,ordinal),
 FOREIGN KEY(conversation_id,server_message_id) REFERENCES eligible_events(conversation_id,server_message_id)
) STRICT;
CREATE INDEX idx_ai_batch_claim ON ai_batch_items(claim_id);
