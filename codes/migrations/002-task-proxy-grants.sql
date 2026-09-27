CREATE TABLE task_proxy_grants (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL,
  model_connection_id uuid NOT NULL REFERENCES model_connections(id) ON DELETE RESTRICT,
  rotated_from uuid REFERENCES task_proxy_grants(id) ON DELETE RESTRICT,
  token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL CHECK (expires_at > issued_at),
  rotation_completed_at timestamptz,
  revoked_at timestamptz
);

CREATE INDEX task_proxy_grants_task_active_idx
  ON task_proxy_grants (task_id, expires_at)
  WHERE revoked_at IS NULL;
