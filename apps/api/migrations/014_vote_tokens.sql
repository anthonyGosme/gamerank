-- Jetons de vote one-shot (anti-triche couche 1).
-- Le SDK en demande un au clic réel sur le widget ; /api/vote l'exige et le
-- consomme (usage unique, TTL court). Casse les votes curl/Postman et le replay,
-- et force un tricheur « JS discret » à scripter le vrai flux (détectable).
CREATE TABLE vote_tokens (
  token_hash text PRIMARY KEY,
  game_id    uuid NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  request_ip text,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz
);

CREATE INDEX idx_vote_tokens_expires_at ON vote_tokens (expires_at);
