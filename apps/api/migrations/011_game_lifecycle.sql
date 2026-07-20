-- Cycle de vie explicite (US-2.3) : le statut doit refléter ce qui bloque
-- réellement le jeu, pas afficher « awaiting jury » dès la création.
--
--   awaiting_snippet      → l'intégration SDK n'est pas vérifiée
--   awaiting_peer_review  → au dev de juger 5 jeux (son devoir d'inscription)
--   awaiting_jury         → le jeu attend ses 5 présentations au jury
--   ranked                → dans le classement officiel
--   hidden                → retiré par un administrateur
ALTER TABLE games DROP CONSTRAINT games_status_check;

UPDATE games SET status = 'awaiting_snippet'
 WHERE status IN ('awaiting_jury', 'in_evaluation') AND integration_verified_at IS NULL;
UPDATE games SET status = 'awaiting_peer_review'
 WHERE status IN ('awaiting_jury', 'in_evaluation') AND integration_verified_at IS NOT NULL;

ALTER TABLE games ADD CONSTRAINT games_status_check CHECK (status IN (
  'awaiting_snippet', 'awaiting_peer_review', 'awaiting_jury', 'ranked', 'hidden'
));
ALTER TABLE games ALTER COLUMN status SET DEFAULT 'awaiting_snippet';
