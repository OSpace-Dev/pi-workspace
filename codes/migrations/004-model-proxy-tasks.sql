CREATE TABLE model_proxy_tasks (
  id uuid PRIMARY KEY,
  model_connection_id uuid NOT NULL REFERENCES model_connections(id) ON DELETE RESTRICT,
  status text NOT NULL CHECK (status IN ('active', 'stopped')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  stopped_at timestamptz
);

CREATE INDEX model_proxy_tasks_connection_active_idx
  ON model_proxy_tasks (model_connection_id) WHERE status = 'active';
