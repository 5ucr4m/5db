-- Test fixture for 5db: a small store with a variety of column types.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE order_status AS ENUM ('pending', 'paid', 'shipped', 'delivered', 'cancelled');

CREATE TABLE customers (
  id          bigserial PRIMARY KEY,
  name        text        NOT NULL,
  email       text        NOT NULL UNIQUE,
  country     char(2)     NOT NULL DEFAULT 'BR',
  is_vip      boolean     NOT NULL DEFAULT false,
  birthday    date,
  metadata    jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE customers IS 'People who buy things';

CREATE TABLE products (
  id          serial PRIMARY KEY,
  sku         uuid           NOT NULL DEFAULT gen_random_uuid(),
  title       varchar(200)   NOT NULL,
  price       numeric(10, 2) NOT NULL CHECK (price >= 0),
  stock       integer        NOT NULL DEFAULT 0,
  tags        text[]         NOT NULL DEFAULT '{}',
  description text
);

CREATE TABLE orders (
  id          bigserial PRIMARY KEY,
  customer_id bigint       NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  status      order_status NOT NULL DEFAULT 'pending',
  total       numeric(12, 2) NOT NULL DEFAULT 0,
  placed_at   timestamptz  NOT NULL DEFAULT now(),
  notes       text
);
CREATE INDEX orders_customer_idx ON orders(customer_id);
CREATE INDEX orders_status_placed_idx ON orders(status, placed_at DESC);

CREATE TABLE order_items (
  order_id   bigint  NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id integer NOT NULL REFERENCES products(id),
  quantity   integer NOT NULL CHECK (quantity > 0),
  unit_price numeric(10, 2) NOT NULL,
  PRIMARY KEY (order_id, product_id)
);

CREATE TABLE audit_log (
  at      timestamptz NOT NULL DEFAULT now(),
  actor   text,
  action  text,
  payload json
);

INSERT INTO customers (name, email, country, is_vip, birthday, metadata, created_at)
SELECT
  (ARRAY['Ana','Bruno','Carla','Diego','Elisa','Felipe','Gabi','Hugo','Iris','João','Karen','Lucas','Marta','Nina','Otávio','Paula'])[1 + (g % 16)]
    || ' ' || (ARRAY['Silva','Souza','Costa','Pereira','Lima','Rocha','Alves','Mendes'])[1 + (g % 8)],
  'user' || g || '@example.com',
  (ARRAY['BR','US','PT','AR','DE','JP'])[1 + (g % 6)],
  g % 11 = 0,
  CASE WHEN g % 5 = 0 THEN NULL ELSE date '1970-01-01' + (g * 37 % 15000) END,
  jsonb_build_object('plan', (ARRAY['free','pro','team'])[1 + (g % 3)], 'score', g % 100, 'newsletter', g % 2 = 0),
  now() - (g || ' hours')::interval
FROM generate_series(1, 5000) AS g;

INSERT INTO products (title, price, stock, tags, description)
SELECT
  (ARRAY['Caneca','Camiseta','Mochila','Teclado','Mouse','Caderno','Garrafa','Fone'])[1 + (g % 8)] || ' modelo ' || g,
  round((5 + (g * 7.31) % 495)::numeric, 2),
  g * 13 % 300,
  ARRAY[(ARRAY['novo','promo','eco','top'])[1 + (g % 4)]],
  CASE WHEN g % 3 = 0 THEN NULL ELSE 'Produto de teste número ' || g END
FROM generate_series(1, 300) AS g;

INSERT INTO orders (customer_id, status, total, placed_at, notes)
SELECT
  1 + (g * 7 % 5000),
  (ARRAY['pending','paid','shipped','delivered','cancelled']::order_status[])[1 + (g % 5)],
  round(((g * 3.7) % 2000)::numeric, 2),
  now() - (g || ' minutes')::interval,
  CASE WHEN g % 9 = 0 THEN 'Entregar após as 18h' END
FROM generate_series(1, 20000) AS g;

INSERT INTO order_items (order_id, product_id, quantity, unit_price)
SELECT o, 1 + ((o * 7 + k * 13) % 300), 1 + (o + k) % 4, round((5 + (o * k * 1.3) % 200)::numeric, 2)
FROM generate_series(1, 20000) AS o, generate_series(1, 2) AS k;

INSERT INTO audit_log (actor, action, payload)
VALUES ('system', 'seed', '{"ok": true}'), ('ana', 'login', NULL);

CREATE VIEW vip_customers AS
  SELECT id, name, email, country FROM customers WHERE is_vip;

CREATE MATERIALIZED VIEW sales_by_status AS
  SELECT status, count(*) AS orders, sum(total) AS revenue FROM orders GROUP BY status;

CREATE SCHEMA analytics;
CREATE TABLE analytics.daily_visits (
  day    date PRIMARY KEY,
  visits integer NOT NULL
);
INSERT INTO analytics.daily_visits SELECT current_date - g, 100 + g * 3 FROM generate_series(0, 90) AS g;

CREATE FUNCTION customer_order_count(cid bigint) RETURNS bigint
  LANGUAGE sql STABLE AS $$ SELECT count(*) FROM orders WHERE customer_id = cid $$;

ANALYZE;
