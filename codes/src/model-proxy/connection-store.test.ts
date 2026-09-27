import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Pool } from "pg";
import {
  applyConnectionMigration,
  approveModelOrigin,
  createModelConnection,
  disableModelConnection,
  getModelConnection,
  listModelConnections,
  listModelOrigins,
  readModelCredential,
  replaceModelCredential,
} from "./connection-store.ts";
import { CredentialVaultError, loadMasterKey } from "./credential-vault.ts";
import type { AddressResolver } from "./upstream-policy.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for the isolated connection store test");

const resolver: AddressResolver = async () => [{ address: "8.8.8.8", family: 4 }];
const key = randomBytes(32);
const syntheticCredential = "synthetic-provider-secret-for-test-only";

async function expectVaultError(action: () => Promise<unknown> | unknown, code: CredentialVaultError["code"]): Promise<void> {
  await assert.rejects(async () => action(), (error: unknown) =>
    error instanceof CredentialVaultError && error.code === code && error.message === code);
}

test("loads only an existing raw 32-byte external master key", async () => {
  const directory = mkdtempSync(join(tmpdir(), "piws-key-test-"));
  try {
    const valid = join(directory, "valid-key");
    const short = join(directory, "short-key");
    writeFileSync(valid, key, { mode: 0o600 });
    writeFileSync(short, randomBytes(31), { mode: 0o600 });
    assert.deepEqual(loadMasterKey(valid), key);
    await expectVaultError(() => loadMasterKey(short), "INVALID_MASTER_KEY");
    await expectVaultError(() => loadMasterKey(join(directory, "missing")), "INVALID_MASTER_KEY");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("lists metadata and protects credential replacement and disable with versions", async () => {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await applyConnectionMigration(pool);
    await approveModelOrigin(pool, "https://api.example.test");
    assert.ok((await listModelOrigins(pool)).some((item) => item.origin === "https://api.example.test"));
    const saved = await createModelConnection(pool, key, {
      displayName: "Managed connection", baseUrl: "https://api.example.test/v1",
      modelId: "managed-model", credential: syntheticCredential,
    }, resolver);
    assert.ok((await listModelConnections(pool)).some((item) => item.id === saved.id));
    const changed = await replaceModelCredential(pool, key, saved.id, saved.version, "synthetic-replacement");
    assert.ok(changed);
    assert.notEqual(changed.version, saved.version);
    assert.equal(await readModelCredential(pool, key, saved.id), "synthetic-replacement");
    assert.equal(await replaceModelCredential(pool, key, saved.id, saved.version, "stale"), null);
    assert.equal(await disableModelConnection(pool, saved.id, saved.version), null);
    const disabled = await disableModelConnection(pool, saved.id, changed.version);
    assert.equal(disabled?.enabled, false);
    assert.equal(await readModelCredential(pool, key, saved.id), null);
    assert.equal(await replaceModelCredential(pool, key, saved.id, disabled.version, "later"), null);
  } finally {
    await pool.end();
  }
});

test("persists approved connection metadata and authenticated ciphertext across reconnect", async () => {
  const pool = new Pool({ connectionString: databaseUrl });
  let id: string;
  try {
    await applyConnectionMigration(pool);
    await applyConnectionMigration(pool);
    const migrationCount = await pool.query<{ count: string }>("SELECT count(*) FROM schema_migrations WHERE version = 1");
    assert.equal(migrationCount.rows[0].count, "1");
    assert.equal(await approveModelOrigin(pool, "https://API.Example.Test:443/"), "https://api.example.test");

    let called = false;
    await assert.rejects(() => createModelConnection(pool, key, {
      displayName: "Not approved",
      baseUrl: "https://unapproved.example.test/v1",
      modelId: "synthetic-model",
      credential: syntheticCredential,
    }, async () => {
      called = true;
      return [{ address: "8.8.8.8", family: 4 }];
    }), { code: "TARGET_NOT_ALLOWED" });
    assert.equal(called, false);

    const saved = await createModelConnection(pool, key, {
      displayName: " Test connection ",
      baseUrl: "https://API.Example.Test:443/v1",
      modelId: "synthetic-model",
      credential: syntheticCredential,
    }, resolver);
    id = saved.id;
    assert.equal(saved.displayName, "Test connection");
    assert.equal(saved.origin, "https://api.example.test");
    assert.equal(saved.baseUrl, "https://api.example.test/v1");
    assert.equal(JSON.stringify(saved).includes(syntheticCredential), false);
    const stored = await pool.query<{ credential_ciphertext: Buffer; credential_nonce: Buffer }>(
      "SELECT credential_ciphertext, credential_nonce FROM model_connections WHERE id = $1", [id],
    );
    assert.equal(stored.rows[0].credential_ciphertext.includes(Buffer.from(syntheticCredential)), false);
    assert.equal(stored.rows[0].credential_nonce.length, 12);
  } finally {
    await pool.end();
  }

  const reopened = new Pool({ connectionString: databaseUrl });
  try {
    const stored = await getModelConnection(reopened, id);
    assert.equal(stored?.modelId, "synthetic-model");
    assert.equal(JSON.stringify(stored).includes("credential"), false);
    assert.equal(await readModelCredential(reopened, key, id), syntheticCredential);
    await reopened.query("UPDATE model_connections SET enabled = false WHERE id = $1", [id]);
    assert.equal(await readModelCredential(reopened, key, id), null);
    await reopened.query("UPDATE model_connections SET enabled = true WHERE id = $1", [id]);
    await expectVaultError(() => readModelCredential(reopened, randomBytes(32), id), "INVALID_CREDENTIAL");

    await reopened.query("UPDATE model_connections SET base_url = $1 WHERE id = $2", ["https://api.example.test/other", id]);
    await expectVaultError(() => readModelCredential(reopened, key, id), "INVALID_CREDENTIAL");
    await reopened.query("UPDATE model_connections SET base_url = $1 WHERE id = $2", ["https://api.example.test/v1", id]);
    await reopened.query("UPDATE model_connections SET credential_ciphertext = decode('00', 'hex') WHERE id = $1", [id]);
    await expectVaultError(() => readModelCredential(reopened, key, id), "INVALID_CREDENTIAL");
  } finally {
    await reopened.end();
  }
});
