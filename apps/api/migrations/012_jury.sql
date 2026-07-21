-- Épic 3 : jury des pairs (CDC §7.4).
-- Chaque développeur, à l'inscription, joue 5 jeux et en élit 2. Chaque jeu
-- est présenté à 5 jurés ; à la 5e présentation (ou après 14 j) il est classé.

-- Compteur de présentations au jury, et date du devoir de jury du dev.
ALTER TABLE games ADD COLUMN jury_presentations integer NOT NULL DEFAULT 0;
ALTER TABLE developers ADD COLUMN jury_completed_at timestamptz;

-- Une ligne = un jeu présenté à un juré (avec le temps joué et l'élection).
CREATE TABLE jury_reviews (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  juror_id     uuid NOT NULL REFERENCES developers(id) ON DELETE CASCADE,
  game_id      uuid NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  batch_id     uuid NOT NULL,          -- regroupe les 5 jeux d'un même devoir
  played_ms    integer NOT NULL DEFAULT 0,
  elected      boolean NOT NULL DEFAULT false,
  assigned_at  timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (juror_id, game_id)
);

CREATE INDEX jury_reviews_game_idx ON jury_reviews (game_id);
CREATE INDEX jury_reviews_batch_idx ON jury_reviews (batch_id);
