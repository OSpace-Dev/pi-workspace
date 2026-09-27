ALTER TABLE task_proxy_grants ADD COLUMN overlap_deadline timestamptz;

UPDATE task_proxy_grants
SET expires_at = LEAST(expires_at, issued_at + interval '1 hour');

UPDATE task_proxy_grants predecessor
SET overlap_deadline = LEAST(predecessor.expires_at, clock_timestamp())
WHERE predecessor.revoked_at IS NULL AND EXISTS (
  SELECT 1 FROM task_proxy_grants successor
  WHERE successor.rotated_from = predecessor.id
    AND successor.rotation_completed_at IS NULL
    AND successor.revoked_at IS NULL
);

ALTER TABLE task_proxy_grants
  ADD CONSTRAINT task_proxy_grants_lifetime_check
  CHECK (expires_at <= issued_at + interval '1 hour');

ALTER TABLE task_proxy_grants
  ADD CONSTRAINT task_proxy_grants_overlap_check
  CHECK (overlap_deadline IS NULL OR overlap_deadline <= expires_at);
