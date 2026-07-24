-- ============================================================
-- BIRBAL MART — Wazir tools ke liye database setup (CORRECTED)
-- Aapki asal products/categories table structure ke mutabiq.
-- Supabase → SQL Editor mein ye poora paste karke "Run without RLS" dabayein.
-- ============================================================

-- 1) products table mein sirf wo column jo abhi tak nahi hai
ALTER TABLE products ADD COLUMN IF NOT EXISTS margin_pct numeric; -- kitna % munafa rakha (repricing ke kaam aayega)

-- 2) Alerts table — Watcher yahan khabar chhodta hai, aap approve/reject karte hain
CREATE TABLE IF NOT EXISTS product_alerts (
  id           bigserial PRIMARY KEY,
  product_id   uuid REFERENCES products(id) ON DELETE CASCADE,
  product_name text,
  alert_type   text,        -- price_up | price_down | out_of_stock | back_in_stock | parse_failed
  old_value    text,
  new_value    text,
  message      text,
  status       text DEFAULT 'pending',   -- pending | approved | ignored
  created_at   timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_alerts_status ON product_alerts(status, created_at DESC);

-- 3) Price history — waqt ke sath price ka record
CREATE TABLE IF NOT EXISTS price_history (
  id           bigserial PRIMARY KEY,
  product_id   uuid REFERENCES products(id) ON DELETE CASCADE,
  source_price numeric,
  checked_at   timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_price_history_product ON price_history(product_id, checked_at DESC);

-- 4) SAFAI: wo purane demo products jinka title khali hai — hata dein
DELETE FROM products WHERE title IS NULL OR trim(title) = '';

-- Dekh lein ab kitne aur kaunse products hain:
-- SELECT id, title, price, category_id, stock, status FROM products ORDER BY created_at DESC;
-- Categories dekhne ke liye:
-- SELECT id, name, emoji, is_active FROM categories ORDER BY name;
