CREATE TABLE workspace_tasks (
  id uuid PRIMARY KEY REFERENCES model_proxy_tasks(id) ON DELETE RESTRICT,
  model_connection_id uuid NOT NULL REFERENCES model_connections(id) ON DELETE RESTRICT,
  status text NOT NULL CHECK (status IN (
    'starting', 'idle', 'answering', 'stopping', 'stopped', 'resuming', 'failed', 'deleting'
  )),
  current_grant_id uuid,
  renew_at timestamptz,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX workspace_tasks_renew_idx ON workspace_tasks (renew_at)
  WHERE status IN ('idle', 'answering');

CREATE TABLE workspace_turns (
  id bigserial PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES workspace_tasks(id) ON DELETE CASCADE,
  question text NOT NULL,
  answer text,
  status text NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed')),
  error_code text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz
);

CREATE INDEX workspace_turns_task_order_idx ON workspace_turns (task_id, id);
