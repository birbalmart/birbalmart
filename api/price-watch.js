// /api/price-watch.js
// WAZIR #2 — "Price & Stock Watcher"
// Har 2 ghante chal kar har product ka asli link dobara kholta hai, price
// aur stock check karta hai. Farq mile to CHUPKE SE badalta NAHI —
// product_alerts table mein khabar chhodta hai. Sirf out-of-stock hone par
// product ko foran 'inactive' kar deta hai (customer ko na dikhe).
//
// Environment variables:
//   SUPABASE_URL, SUPABASE_KEY, CRON_SECRET

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://szikthydpanliybbpehx.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || '';
const PRICE_CHANGE_THRESHOLD_PCT = 2;

function sb(path, options = {}) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...(options.headers || {})
    }
  });
}

function readPage(html) {
  const out = { price: null, in_stock: null, stock_qty: null };

  const blocks = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (const block of blocks) {
    const raw = block.replace(/<script[^>]*>/i, '').replace(/<\/script>/i, '').trim();
    let data; try { data = JSON.parse(raw); } catch { continue; }
    const items = Array.isArray(data) ? data : [data];
    for (const item of items) {
      const nodes = item['@graph'] ? item['@graph'] : [item];
      for (const node of nodes) {
        if (!String(node['@type'] || '').toLowerCase().includes('product')) continue;
        const offers = Array.isArray(node.offers) ? node.offers[0] : node.offers;
        if (offers) {
          if (offers.price != null && out.price == null) {
            out.price = parseFloat(String(offers.price).replace(/[^0-9.]/g, ''));
          }
          if (offers.availability && out.in_stock == null) {
            out.in_stock = !String(offers.availability).toLowerCase().includes('outofstock');
          }
          if (offers.inventoryLevel?.value != null && out.stock_qty == null) {
            out.stock_qty = parseInt(offers.inventoryLevel.value, 10);
          }
        }
      }
    }
  }

  if (out.price == null) {
    const m = html.match(/<meta[^>]+property=["'](?:product|og):price:amount["'][^>]+content=["']([^"']+)["']/i)
           || html.match(/"price"\s*:\s*"?([0-9][0-9,.]*)"?/i)
           || html.match(/(?:Rs\.?|PKR|₨)\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i);
    if (m) out.price = parseFloat(m[1].replace(/,/g, ''));
  }

  const text = html.toLowerCase();
  if (out.in_stock == null) {
    if (/out\s*of\s*stock|sold\s*out|stock\s*khatam|unavailable|currently unavailable/.test(text)) out.in_stock = false;
    else if (/in\s*stock|add to cart|buy now|available/.test(text)) out.in_stock = true;
  }
  if (out.stock_qty == null) {
    const q = html.match(/only\s+(\d{1,4})\s+(?:left|remaining|pieces?|items?)/i)
           || html.match(/(\d{1,4})\s+(?:pieces?|items?)\s+(?:left|available|in stock)/i);
    if (q) out.stock_qty = parseInt(q[1], 10);
  }

  return out;
}

async function logAlert(alert) {
  try { await sb('product_alerts', { method: 'POST', body: JSON.stringify(alert) }); }
  catch (e) { console.error('alert save fail:', e.message); }
}

module.exports = async (req, res) => {
  const secret = req.headers['x-cron-secret'] || req.query?.secret;
  const auth = req.headers['authorization'];
  const isVercelCron = auth === `Bearer ${process.env.CRON_SECRET}`;
  if (!process.env.CRON_SECRET || (secret !== process.env.CRON_SECRET && !isVercelCron)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!SUPABASE_KEY) return res.status(500).json({ error: 'SUPABASE_KEY set nahi hai' });

  const summary = { checked: 0, price_changed: 0, went_out_of_stock: 0, back_in_stock: 0, parse_failed: 0, errors: [] };

  try {
    const listRes = await sb('products?select=id,title,price,source_url,source_price,status,margin_pct&source_url=not.is.null&limit=200');
    if (!listRes.ok) throw new Error('products fetch ' + listRes.status);
    const products = await listRes.json();

    for (const p of products) {
      summary.checked++;
      try {
        const pageRes = await fetch(p.source_url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36',
            'Accept-Language': 'en-US,en;q=0.9'
          },
          redirect: 'follow'
        });

        if (!pageRes.ok) {
          summary.parse_failed++;
          await logAlert({ product_id: p.id, product_name: p.title, alert_type: 'parse_failed',
            message: `Page nahi khula (HTTP ${pageRes.status}) — khud dekh lein.` });
          continue;
        }

        const html = await pageRes.text();
        const now = readPage(html);

        if (now.price == null && now.in_stock == null) {
          summary.parse_failed++;
          await logAlert({ product_id: p.id, product_name: p.title, alert_type: 'parse_failed',
            message: 'Page se price/stock parh nahi saka — manually dekh lein.' });
          continue;
        }

        const patch = { last_synced: new Date().toISOString() };
        const wasOutOfStock = p.status === 'out_of_stock' || p.status === 'inactive';

        // ---- STOCK ----
        if (now.in_stock === false && !wasOutOfStock) {
          patch.status = 'out_of_stock';
          summary.went_out_of_stock++;
          await logAlert({ product_id: p.id, product_name: p.title, alert_type: 'out_of_stock',
            old_value: p.status || 'active', new_value: 'out_of_stock',
            message: 'Stock khatam ho gaya — product site se chhupa diya gaya hai.',
            status: 'approved' });
        } else if (now.in_stock === true && wasOutOfStock) {
          summary.back_in_stock++;
          await logAlert({ product_id: p.id, product_name: p.title, alert_type: 'back_in_stock',
            old_value: p.status || 'out_of_stock', new_value: 'active',
            message: 'Stock wapas aa gaya — dobara live karna hai? (Admin panel se "active" karein.)' });
        }

        if (now.stock_qty != null) patch.stock = now.stock_qty;

        // ---- PRICE ----
        if (now.price != null) {
          await sb('price_history', { method: 'POST', body: JSON.stringify({ product_id: p.id, source_price: now.price }) }).catch(() => {});

          const old = p.source_price;
          if (old != null && old > 0) {
            const diffPct = ((now.price - old) / old) * 100;
            if (Math.abs(diffPct) >= PRICE_CHANGE_THRESHOLD_PCT) {
              summary.price_changed++;
              const up = diffPct > 0;
              const margin = p.margin_pct != null ? p.margin_pct
                           : (p.price && old ? ((p.price - old) / old) * 100 : null);
              const suggested = margin != null ? Math.round(now.price * (1 + margin / 100)) : null;

              await logAlert({
                product_id: p.id, product_name: p.title,
                alert_type: up ? 'price_up' : 'price_down',
                old_value: `Rs ${old}`, new_value: `Rs ${now.price}`,
                message: up
                  ? `Cost ${Math.abs(diffPct).toFixed(1)}% barh gayi. ${suggested ? `Munafa barqarar rakhne ke liye nayi qeemat Rs ${suggested} — approve karein?` : 'Apni qeemat dobara dekh lein.'}`
                  : `Cost ${Math.abs(diffPct).toFixed(1)}% kam ho gayi. ${suggested ? `Chahein to qeemat Rs ${suggested} kar ke sasta bech sakte hain.` : ''}`
              });
            }
          }
          patch.source_price = now.price;
        }

        await sb(`products?id=eq.${p.id}`, { method: 'PATCH', body: JSON.stringify(patch) });

      } catch (e) {
        summary.errors.push(`${p.title}: ${e.message}`);
        await logAlert({ product_id: p.id, product_name: p.title, alert_type: 'parse_failed',
          message: `Check nahi ho saka: ${e.message}` });
      }
    }

    return res.status(200).json({ ok: true, ran_at: new Date().toISOString(), ...summary });

  } catch (err) {
    console.error('price-watch fatal:', err.message);
    return res.status(500).json({ ok: false, error: err.message, ...summary });
  }
};
