-- Up Migration
CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  display_name  text NOT NULL,
  avatar_key    text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE portfolios (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          text NOT NULL,
  base_currency text NOT NULL DEFAULT 'usd',
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, name)
);

CREATE TABLE transactions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  portfolio_id uuid NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
  coin_id      text NOT NULL,
  type         text NOT NULL CHECK (type IN ('buy', 'sell')),
  quantity     numeric(38, 18) NOT NULL CHECK (quantity > 0),
  price_usd    numeric(38, 18) NOT NULL CHECK (price_usd >= 0),
  fee_usd      numeric(38, 18) NOT NULL DEFAULT 0 CHECK (fee_usd >= 0),
  executed_at  timestamptz NOT NULL,
  note         text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX transactions_portfolio_idx ON transactions (portfolio_id, executed_at);

CREATE TABLE watchlist (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  coin_id    text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, coin_id)
);

CREATE TABLE alerts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  coin_id      text NOT NULL,
  direction    text NOT NULL CHECK (direction IN ('above', 'below')),
  target_price numeric(38, 18) NOT NULL CHECK (target_price > 0),
  active       boolean NOT NULL DEFAULT true,
  triggered_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX alerts_active_idx ON alerts (coin_id) WHERE active;

CREATE TABLE notifications (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title      text NOT NULL,
  body       text NOT NULL,
  read_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_idx ON notifications (user_id, created_at DESC);

CREATE TABLE portfolio_snapshots (
  portfolio_id uuid NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
  date         date NOT NULL,
  value_usd    numeric(38, 2) NOT NULL,
  PRIMARY KEY (portfolio_id, date)
);

CREATE TABLE jobs (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       text NOT NULL CHECK (type IN ('export_csv', 'import_csv', 'report_pdf')),
  status     text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
  params     jsonb NOT NULL DEFAULT '{}'::jsonb,
  result_key text,
  result     jsonb,
  error      text,
  attempts   integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jobs_user_idx ON jobs (user_id, created_at DESC);

-- Down Migration
DROP TABLE jobs;
DROP TABLE portfolio_snapshots;
DROP TABLE notifications;
DROP TABLE alerts;
DROP TABLE watchlist;
DROP TABLE transactions;
DROP TABLE portfolios;
DROP TABLE users;
