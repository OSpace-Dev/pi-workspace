CREATE TABLE agent_sandboxes (
  id uuid PRIMARY KEY,
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 80),
  status text NOT NULL CHECK (status IN ('starting', 'idle', 'stopping', 'stopped', 'resuming', 'failed', 'deleting')),
  error_code text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX agent_sandboxes_created ON agent_sandboxes(created_at DESC, id DESC);
