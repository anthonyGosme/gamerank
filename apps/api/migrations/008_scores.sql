-- Épic 7 : historique des calculs de score (CDC §9, §12.12).
CREATE TABLE score_runs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  duration_ms  integer,
  status       text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'ok', 'error')),
  error        text,
  games_count  integer
);

CREATE TABLE game_scores (
  run_id   uuid NOT NULL REFERENCES score_runs(id) ON DELETE CASCADE,
  game_id  uuid NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  score    real NOT NULL,
  g        real NOT NULL,
  q        real NOT NULL,
  p        real NOT NULL,
  score_a  real NOT NULL,
  rank     integer NOT NULL,
  metrics  jsonb NOT NULL,
  PRIMARY KEY (run_id, game_id)
);

-- Score courant dénormalisé : mis à jour uniquement quand un run réussit,
-- le dernier classement valide survit donc à un échec de calcul.
ALTER TABLE games ADD COLUMN current_score real;
ALTER TABLE games ADD COLUMN current_rank integer;
