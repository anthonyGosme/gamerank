-- Une URL = un seul jeu, tous comptes confondus (US-2.1 révisé).
-- Deux comptes ne peuvent plus déclarer la même URL : ça créait des fiches
-- en double et permettait de « revendiquer » le jeu d'un autre.

-- Dédoublonnage : on garde le plus ancien jeu par URL, on supprime les autres.
DELETE FROM games g USING games keep
 WHERE g.url = keep.url
   AND (g.created_at, g.id) > (keep.created_at, keep.id);

ALTER TABLE games DROP CONSTRAINT games_developer_url_key;
ALTER TABLE games ADD CONSTRAINT games_url_key UNIQUE (url);
