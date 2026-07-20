-- Description et vignette deviennent obligatoires (US-2.1).
-- Backfill des lignes existantes pour poser les contraintes.
UPDATE games SET description = '' WHERE description IS NULL;
UPDATE games SET thumbnail_url = '' WHERE thumbnail_url IS NULL;

ALTER TABLE games ALTER COLUMN description SET NOT NULL;
ALTER TABLE games ALTER COLUMN thumbnail_url SET NOT NULL;
