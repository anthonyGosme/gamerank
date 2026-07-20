-- Votes joueurs (CDC §11 : votes courants en PostgreSQL).
-- Un vote par visiteur et par jeu, le dernier remplace (US-4.3).
CREATE TABLE votes (
  game_id     uuid NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  visitor_id  text NOT NULL,
  value       smallint NOT NULL CHECK (value IN (-1, 1)),
  ip          inet,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (game_id, visitor_id)
);
