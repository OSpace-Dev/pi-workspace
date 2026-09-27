CREATE TABLE workspace_sources (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES workspace_tasks(id) ON DELETE CASCADE,
  file_name text NOT NULL,
  original_bytes bytea NOT NULL,
  text_content text NOT NULL,
  byte_count integer NOT NULL CHECK (byte_count > 0 AND byte_count <= 102400),
  sha256 text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(task_id, file_name)
);
CREATE INDEX workspace_sources_task ON workspace_sources(task_id, created_at, id);
ALTER TABLE workspace_turns ADD COLUMN source_ids uuid[] NOT NULL DEFAULT '{}';
ALTER TABLE workspace_turns ADD COLUMN result jsonb;
ALTER TABLE workspace_turns ADD COLUMN phase text NOT NULL DEFAULT 'completed';
UPDATE workspace_turns SET phase = 'model' WHERE status = 'pending';
