-- Eve original schema v1; see docs/contracts/archive.md
CREATE TABLE archive_meta (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  schema_version INTEGER NOT NULL CHECK (schema_version >= 1),
  owner_uid TEXT NOT NULL,
  target_uid TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE conversations (
  conversation_id TEXT PRIMARY KEY,
  sync_state TEXT NOT NULL DEFAULT 'unverified'
    CHECK (sync_state IN ('unverified','reconciling','verified','gap','ambiguous')),
  verified_anchor_id TEXT,
  history_cursor TEXT,
  last_verified_at_ms INTEGER,
  updated_at_ms INTEGER NOT NULL,
  CHECK (sync_state <> 'verified' OR
         (verified_anchor_id IS NOT NULL AND last_verified_at_ms IS NOT NULL))
) STRICT;

CREATE TABLE messages (
  local_id INTEGER PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(conversation_id),
  server_message_id TEXT NOT NULL,
  client_message_id TEXT,
  sender_uid TEXT NOT NULL,
  from_self INTEGER NOT NULL CHECK (from_self IN (0,1)),
  text TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('text','non_text')),
  message_type INTEGER NOT NULL,
  create_time TEXT,
  index_in_conversation TEXT,
  first_source TEXT NOT NULL CHECK (first_source IN ('live','history')),
  archived_at_ms INTEGER NOT NULL,
  UNIQUE (conversation_id, server_message_id)
) STRICT;
CREATE INDEX idx_messages_conversation_order
  ON messages(conversation_id, archived_at_ms, local_id);

CREATE TABLE uncertain_messages (
  local_id INTEGER PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(conversation_id),
  client_message_id TEXT,
  sender_uid TEXT NOT NULL,
  from_self INTEGER NOT NULL CHECK (from_self IN (0,1)),
  text TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('text','non_text')),
  message_type INTEGER NOT NULL,
  create_time TEXT,
  index_in_conversation TEXT,
  source TEXT NOT NULL CHECK (source IN ('live','history')),
  batch_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('missing_server_id','alignment_ambiguous')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','resolved','dismissed')),
  linked_message_id INTEGER REFERENCES messages(local_id),
  archived_at_ms INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_uncertain_pending ON uncertain_messages(status,conversation_id);

CREATE TABLE archive_gaps (
  id INTEGER PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(conversation_id),
  reason TEXT NOT NULL,
  from_anchor_id TEXT,
  to_anchor_id TEXT,
  detected_at_ms INTEGER NOT NULL,
  resolved_at_ms INTEGER
) STRICT;
CREATE INDEX idx_open_gaps ON archive_gaps(conversation_id,resolved_at_ms);

CREATE TABLE archive_batches (
  batch_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(conversation_id),
  source TEXT NOT NULL CHECK (source IN ('live','history')),
  request_digest TEXT NOT NULL,
  outcomes_json TEXT NOT NULL,
  item_count INTEGER NOT NULL CHECK (item_count >= 0),
  committed_at_ms INTEGER NOT NULL,
  inserted_count INTEGER NOT NULL CHECK (inserted_count >= 0),
  matched_count INTEGER NOT NULL CHECK (matched_count >= 0),
  ambiguous_count INTEGER NOT NULL CHECK (ambiguous_count >= 0)
) STRICT;
