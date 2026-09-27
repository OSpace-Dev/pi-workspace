import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Pool } from "pg";
import { normalizeAllowedOrigin, resolveAllowedDestination, UpstreamPolicyError, type AddressResolver } from "./upstream-policy.ts";
import { openCredential, sealCredential, type CredentialIdentity } from "./credential-vault.ts";

const migration = readFileSync(new URL("../../migrations/001-model-connections.sql", import.meta.url), "utf8");
const migrationChecksum = createHash("sha256").update(migration).digest("hex");

export type ModelConnectionMetadata = CredentialIdentity & {
  displayName: string;
  enabled: boolean;
  version: string;
  createdAt: Date;
  updatedAt: Date;
};

export type NewModelConnection = {
  displayName: string;
  baseUrl: string;
  modelId: string;
  credential: string;
};

type ConnectionRow = {
  id: string;
  display_name: string;
  origin: string;
  base_url: string;
  model_id: string;
  enabled: boolean;
  version: string;
  created_at: Date;
  updated_at: Date;
};

type CredentialRow = ConnectionRow & {
  credential_ciphertext: Buffer;
  credential_nonce: Buffer;
  credential_tag: Buffer;
  key_version: number;
};

function metadata(row: ConnectionRow): ModelConnectionMetadata {
  return {
    id: row.id,
    displayName: row.display_name,
    origin: row.origin,
    baseUrl: row.base_url,
    modelId: row.model_id,
    enabled: row.enabled,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function applyConnectionMigration(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(73240101)");
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version integer PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const applied = await client.query<{ checksum: string }>("SELECT checksum FROM schema_migrations WHERE version = 1");
    if (applied.rowCount) {
      if (applied.rows[0].checksum !== migrationChecksum) throw new Error("MIGRATION_CHECKSUM_MISMATCH");
    } else {
      await client.query(migration);
      await client.query("INSERT INTO schema_migrations (version, checksum) VALUES (1, $1)", [migrationChecksum]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function approveModelOrigin(pool: Pool, value: string): Promise<string> {
  const origin = normalizeAllowedOrigin(value);
  await pool.query("INSERT INTO approved_model_origins (origin) VALUES ($1) ON CONFLICT DO NOTHING", [origin]);
  return origin;
}

export async function createModelConnection(
  pool: Pool,
  key: Buffer,
  input: NewModelConnection,
  resolver?: AddressResolver,
): Promise<ModelConnectionMetadata> {
  if (!input.displayName.trim() || input.displayName.length > 200 || !input.modelId.trim() || input.modelId.length > 200) {
    throw new Error("INVALID_CONNECTION_METADATA");
  }
  const approved = await pool.query<{ origin: string }>("SELECT origin FROM approved_model_origins");
  const destination = await resolveAllowedDestination(
    input.baseUrl,
    approved.rows.map((row) => row.origin),
    resolver,
  );
  const identity: CredentialIdentity = {
    id: randomUUID(),
    origin: destination.origin,
    baseUrl: destination.baseUrl,
    modelId: input.modelId,
  };
  const sealed = sealCredential(key, identity, input.credential);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const stillApproved = await client.query("SELECT 1 FROM approved_model_origins WHERE origin = $1 FOR SHARE", [identity.origin]);
    if (!stillApproved.rowCount) throw new UpstreamPolicyError("TARGET_NOT_ALLOWED");
    const saved = await client.query<ConnectionRow>(`INSERT INTO model_connections
      (id, display_name, origin, base_url, model_id, credential_ciphertext, credential_nonce, credential_tag, key_version)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING id, display_name, origin, base_url, model_id, enabled, xmin::text AS version, created_at, updated_at`, [
      identity.id, input.displayName.trim(), identity.origin, identity.baseUrl, identity.modelId,
      sealed.ciphertext, sealed.nonce, sealed.tag, sealed.keyVersion,
    ]);
    await client.query("COMMIT");
    return metadata(saved.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function getModelConnection(pool: Pool, id: string): Promise<ModelConnectionMetadata | null> {
  const result = await pool.query<ConnectionRow>(`SELECT id, display_name, origin, base_url, model_id, enabled, xmin::text AS version, created_at, updated_at
    FROM model_connections WHERE id = $1`, [id]);
  return result.rows[0] ? metadata(result.rows[0]) : null;
}

export async function readModelCredential(pool: Pool, key: Buffer, id: string): Promise<string | null> {
  const result = await pool.query<CredentialRow>(`SELECT id, display_name, origin, base_url, model_id, enabled, xmin::text AS version, created_at, updated_at,
    credential_ciphertext, credential_nonce, credential_tag, key_version FROM model_connections
    WHERE id = $1 AND enabled = true`, [id]);
  const row = result.rows[0];
  if (!row) return null;
  return openCredential(key, metadata(row), {
    ciphertext: row.credential_ciphertext,
    nonce: row.credential_nonce,
    tag: row.credential_tag,
    keyVersion: row.key_version,
  });
}

export async function listModelOrigins(pool: Pool): Promise<{ origin: string; createdAt: Date }[]> {
  const result = await pool.query<{ origin: string; created_at: Date }>(
    "SELECT origin, created_at FROM approved_model_origins ORDER BY origin",
  );
  return result.rows.map((row) => ({ origin: row.origin, createdAt: row.created_at }));
}

export async function listModelConnections(pool: Pool): Promise<ModelConnectionMetadata[]> {
  const result = await pool.query<ConnectionRow>(`SELECT id, display_name, origin, base_url, model_id,
    enabled, xmin::text AS version, created_at, updated_at
    FROM model_connections ORDER BY created_at DESC, id DESC`);
  return result.rows.map(metadata);
}

export async function disableModelConnection(pool: Pool, id: string, version: string): Promise<ModelConnectionMetadata | null> {
  const result = await pool.query<ConnectionRow>(`UPDATE model_connections
    SET enabled = false, updated_at = clock_timestamp()
    WHERE id = $1 AND xmin::text = $2 AND enabled = true
    RETURNING id, display_name, origin, base_url, model_id, enabled, xmin::text AS version, created_at, updated_at`,
  [id, version]);
  return result.rows[0] ? metadata(result.rows[0]) : null;
}

export async function replaceModelCredential(
  pool: Pool, key: Buffer, id: string, version: string, credential: string,
): Promise<ModelConnectionMetadata | null> {
  const existing = await getModelConnection(pool, id);
  if (!existing || !existing.enabled || existing.version !== version) return null;
  const sealed = sealCredential(key, existing, credential);
  const result = await pool.query<ConnectionRow>(`UPDATE model_connections SET
    credential_ciphertext = $3, credential_nonce = $4, credential_tag = $5,
    key_version = $6, updated_at = clock_timestamp()
    WHERE id = $1 AND xmin::text = $2 AND enabled = true
    RETURNING id, display_name, origin, base_url, model_id, enabled, xmin::text AS version, created_at, updated_at`,
  [id, version, sealed.ciphertext, sealed.nonce, sealed.tag, sealed.keyVersion]);
  return result.rows[0] ? metadata(result.rows[0]) : null;
}
