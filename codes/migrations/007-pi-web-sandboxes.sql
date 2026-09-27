ALTER TABLE workspace_tasks ADD COLUMN kind text NOT NULL DEFAULT 'qa' CHECK (kind IN ('qa', 'sandbox'));
ALTER TABLE workspace_tasks ADD COLUMN display_name text;
ALTER TABLE workspace_tasks ADD CONSTRAINT sandbox_name_required CHECK
  (kind = 'qa' OR (display_name IS NOT NULL AND length(display_name) BETWEEN 1 AND 80));
CREATE INDEX workspace_tasks_kind_created ON workspace_tasks(kind, created_at DESC, id DESC);
