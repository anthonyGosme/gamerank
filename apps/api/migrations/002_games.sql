CREATE TABLE games (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  developer_id  uuid NOT NULL REFERENCES developers(id) ON DELETE CASCADE,
  name          text NOT NULL,
  url           text NOT NULL UNIQUE,
  -- Domaine dérivé de l'URL : les événements SDK d'une autre origine sont rejetés (US-2.2)
  domain        text NOT NULL,
  description   text,
  thumbnail_url text,
  sdk_key       text NOT NULL UNIQUE,
  -- Cycle de vie US-2.3 : awaiting_jury -> in_evaluation -> ranked ; hidden = retrait admin (US-8.2)
  status        text NOT NULL DEFAULT 'awaiting_jury'
                CHECK (status IN ('awaiting_jury', 'in_evaluation', 'ranked', 'hidden')),
  last_event_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX games_developer_idx ON games (developer_id);
