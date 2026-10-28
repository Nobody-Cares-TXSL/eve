-- Eve T4 reconciliation schema v2. Applied transactionally to an existing v1 database.
CREATE TABLE reconcile_epochs (
  epoch_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(conversation_id),
  instance_id TEXT NOT NULL,
  owner_uid TEXT NOT NULL,
  im_uid TEXT NOT NULL,
  target_uid TEXT NOT NULL,
  started_at_ms INTEGER NOT NULL,
  completed_at_ms INTEGER,
  old_anchor_id TEXT,
  new_anchor_id TEXT,
  state TEXT NOT NULL CHECK(state IN ('reconciling','verified','gap','ambiguous','cancelled')),
  reason_code TEXT
) STRICT;
CREATE INDEX idx_epochs_conversation ON reconcile_epochs(conversation_id, started_at_ms);
CREATE TABLE reconcile_pages (
  epoch_id TEXT NOT NULL REFERENCES reconcile_epochs(epoch_id),
  page_no INTEGER NOT NULL CHECK(page_no >= 0),
  batch_id TEXT NOT NULL UNIQUE REFERENCES archive_batches(batch_id),
  phase TEXT NOT NULL CHECK(phase IN ('older','head_close')),
  requested_cursor TEXT,
  returned_cursor TEXT NOT NULL,
  direction TEXT NOT NULL CHECK(direction IN ('older','newer')),
  has_more INTEGER NOT NULL CHECK(has_more IN (0,1)),
  raw_count INTEGER NOT NULL CHECK(raw_count >= 0),
  accepted_count INTEGER NOT NULL CHECK(accepted_count >= 0),
  excluded_count INTEGER NOT NULL CHECK(excluded_count >= 0),
  missing_id_count INTEGER NOT NULL CHECK(missing_id_count >= 0),
  ids_digest TEXT NOT NULL,
  ids_json TEXT NOT NULL,
  committed_at_ms INTEGER NOT NULL,
  CHECK(raw_count = accepted_count + excluded_count),
  CHECK(missing_id_count <= accepted_count),
  PRIMARY KEY(epoch_id,page_no)
) STRICT;
CREATE TABLE eligible_events (
  conversation_id TEXT NOT NULL REFERENCES conversations(conversation_id),
  server_message_id TEXT NOT NULL,
  epoch_id TEXT NOT NULL REFERENCES reconcile_epochs(epoch_id),
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','claimed','processed')),
  eligible_at_ms INTEGER NOT NULL,
  claim_id TEXT,
  PRIMARY KEY(conversation_id,server_message_id),
  FOREIGN KEY(conversation_id,server_message_id) REFERENCES messages(conversation_id,server_message_id)
) STRICT;
CREATE INDEX idx_eligible_events_state ON eligible_events(state,eligible_at_ms);
