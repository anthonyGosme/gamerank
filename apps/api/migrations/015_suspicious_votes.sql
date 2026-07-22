-- Compteur de votes « faible confiance » (tripwire) : incrémenté en silence
-- quand un vote arrive sans le ctx attendu (mix(token+salt)) — signe d'une
-- requête bricolée. Exposé en admin ; branchable sur la dé-pondération plus tard.
ALTER TABLE games ADD COLUMN suspicious_votes integer NOT NULL DEFAULT 0;
