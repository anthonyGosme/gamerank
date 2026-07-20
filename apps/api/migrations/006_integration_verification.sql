-- Vérification d'intégration (US-2.2) :
--  - is_local : adresse locale (localhost / IP) déclarée par le dev →
--    vérification par réception d'événements SDK ;
--  - NDD internet → le backend télécharge la page et vérifie la balise.
ALTER TABLE games ADD COLUMN is_local boolean NOT NULL DEFAULT false;
ALTER TABLE games ADD COLUMN integration_verified_at timestamptz;

UPDATE games SET is_local = true WHERE domain = 'localhost';
