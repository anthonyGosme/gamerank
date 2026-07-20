-- Le magic link mémorise la page demandée avant connexion, pour y revenir
-- après validation (sinon l'utilisateur perd son parcours, ex. /games/new).
ALTER TABLE magic_link_tokens ADD COLUMN redirect_to text;
