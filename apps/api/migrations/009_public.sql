-- Épic 5 : site public.
ALTER TABLE games ADD COLUMN category text NOT NULL DEFAULT 'other';
ALTER TABLE games ADD COLUMN short_description text NOT NULL DEFAULT '';
-- Clics « Play » comptés via /go/<id> (US-5.2).
ALTER TABLE games ADD COLUMN play_clicks integer NOT NULL DEFAULT 0;

-- Backfill : description courte = début de la description longue.
UPDATE games SET short_description = left(description, 150) WHERE short_description = '';
