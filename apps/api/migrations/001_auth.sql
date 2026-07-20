CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE developers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email       text NOT NULL UNIQUE,
  -- Signaux réseau d'inscription (CDC §4, appliqués au poids de juré §7.4)
  signup_ip   inet,
  signup_asn  integer,  -- TODO : résolution MaxMind GeoLite2-ASN (clé de compte requise)
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE magic_link_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email       text NOT NULL,
  token_hash  text NOT NULL UNIQUE,
  request_ip  inet,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX magic_link_tokens_email_idx ON magic_link_tokens (email, created_at DESC);

CREATE TABLE sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  developer_id  uuid NOT NULL REFERENCES developers(id) ON DELETE CASCADE,
  token_hash    text NOT NULL UNIQUE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz
);

CREATE INDEX sessions_developer_idx ON sessions (developer_id);
