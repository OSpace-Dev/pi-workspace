CREATE TABLE approved_model_origins (
  origin text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE model_connections (
  id uuid PRIMARY KEY,
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  origin text NOT NULL REFERENCES approved_model_origins(origin) ON DELETE RESTRICT,
  base_url text NOT NULL,
  model_id text NOT NULL CHECK (length(model_id) BETWEEN 1 AND 200),
  enabled boolean NOT NULL DEFAULT true,
  credential_ciphertext bytea NOT NULL,
  credential_nonce bytea NOT NULL CHECK (octet_length(credential_nonce) = 12),
  credential_tag bytea NOT NULL CHECK (octet_length(credential_tag) = 16),
  key_version smallint NOT NULL CHECK (key_version = 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
