import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

export const credentialKeyVersion = 1;

export type CredentialIdentity = {
  id: string;
  origin: string;
  baseUrl: string;
  modelId: string;
};

export type SealedCredential = {
  ciphertext: Buffer;
  nonce: Buffer;
  tag: Buffer;
  keyVersion: number;
};

export class CredentialVaultError extends Error {
  readonly code: "INVALID_MASTER_KEY" | "INVALID_CREDENTIAL";

  constructor(code: CredentialVaultError["code"]) {
    super(code);
    this.name = "CredentialVaultError";
    this.code = code;
  }
}

export function loadMasterKey(path: string): Buffer {
  let key: Buffer;
  try {
    key = readFileSync(path);
  } catch {
    throw new CredentialVaultError("INVALID_MASTER_KEY");
  }
  if (key.length !== 32) throw new CredentialVaultError("INVALID_MASTER_KEY");
  return key;
}

function associatedData(identity: CredentialIdentity): Buffer {
  return Buffer.from(JSON.stringify([
    credentialKeyVersion,
    identity.id,
    identity.origin,
    identity.baseUrl,
    identity.modelId,
  ]), "utf8");
}

export function sealCredential(key: Buffer, identity: CredentialIdentity, credential: string): SealedCredential {
  if (key.length !== 32) throw new CredentialVaultError("INVALID_MASTER_KEY");
  if (!credential || Buffer.byteLength(credential, "utf8") > 8192) {
    throw new CredentialVaultError("INVALID_CREDENTIAL");
  }
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(associatedData(identity));
  const ciphertext = Buffer.concat([cipher.update(credential, "utf8"), cipher.final()]);
  return { ciphertext, nonce, tag: cipher.getAuthTag(), keyVersion: credentialKeyVersion };
}

export function openCredential(key: Buffer, identity: CredentialIdentity, sealed: SealedCredential): string {
  if (key.length !== 32) throw new CredentialVaultError("INVALID_MASTER_KEY");
  if (sealed.keyVersion !== credentialKeyVersion || sealed.nonce.length !== 12 || sealed.tag.length !== 16) {
    throw new CredentialVaultError("INVALID_CREDENTIAL");
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, sealed.nonce);
    decipher.setAAD(associatedData(identity));
    decipher.setAuthTag(sealed.tag);
    return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]).toString("utf8");
  } catch {
    throw new CredentialVaultError("INVALID_CREDENTIAL");
  }
}
