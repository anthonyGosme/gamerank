-- L'unicité d'URL devient par développeur (US-2.1) :
-- plusieurs comptes peuvent déclarer le même site (assumé),
-- mais un même compte ne peut pas le proposer deux fois.
ALTER TABLE games DROP CONSTRAINT games_url_key;
ALTER TABLE games ADD CONSTRAINT games_developer_url_key UNIQUE (developer_id, url);
