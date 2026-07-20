-- Couleur principale du badge, choisie par le développeur (US-4.3).
-- Les couleurs de texte/flèches sont calculées côté serveur pour le contraste.
ALTER TABLE games ADD COLUMN badge_color text NOT NULL DEFAULT '#111827';
