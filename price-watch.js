// /api/price-watch.js
// WAZIR #2 — "Price & Stock Watcher"
// Kaam: har 2 ghante chal kar aapke har product ka asli link dobara kholta hai,
// price aur stock check karta hai. Farq mile to CHUPKE SE badalta NAHI —
// product_alerts table mein khabar chhodta hai, aap admin panel se approve
// karte hain. Sirf out-of-stock hone par product ko foran chhupa deta hai
// (taake customer wo cheez order na kar le jo mil hi nahi sakti).
//
// Environment variables:
//   SUPABASE_URL, SUPABASE_KEY   (Supabase project URL aur key)
//   CRON_SECRET                  (taake koi aur ye endpoint na chala sake)

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://szikthydpanliybbpehx.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || '';

// price ka farq itna hone par hi khabar dena (chhoti hilchul se pareshan na karein)
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

function decodeEntities(s) {
  if (!s) return s;
  return s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
}

// page se price + stock nikalna (product-import.js jaisi hi mantiq)
function readPage(html) {
  const out = { price: null, in_stock: null, stock_qty: null };

  // JSON-LD sab se bharosemand
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

  // meta tags
  if (out.price == null) {
    const m = html.match(/<meta[^>]+property=["'](?:product|og):price:amount["'][^>]+content=["']([^"']+)["']/i)
           || html.match(/"price"\s*:\s*"?([0-9][0-9,.]*)"?/i)
           || html.match(/(?:Rs\.?|PKR|₨)\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i);
    if (m) out.price = parseFloat(m[1].replace(/,/g, ''));
  }

  // stock ke alfaz
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
  try {
    await sb('product_alerts', { method: 'POST', body: JSON.stringify(alert) });
  } catch (e) { console.error('alert save fail:', e.message); }
}

module.exports = async (req, res) => {
  // Sirf cron ya aap — secret check
  const secret = req.headers['x-cron-secret'] || req.query?.secret;
  const auth = req.headers['authorization'];
  const isVercelCron = auth === `Bearer ${process.env.CRON_SECRET}`;
  if (!process.env.CRON_SECRET || (secret !== process.env.CRON_SECRET && !isVercelCron)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!SUPABASE_KEY) return res.status(500).json({ error: 'SUPABASE_KEY set nahi hai' });

  const summary = { checked: 0, price_changed: 0, went_out_of_stock: 0, back_in_stock: 0, parse_failed: 0, errors: [] };

  try {
    const listRes = await sb('products?select=id,name,price,source_url,source_price,in_stock,margin_pct&source_url=not.is.null&limit=200');
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
          await logAlert({
            product_id: p.id, product_name: p.name, alert_type: 'parse_failed',
            message: `Page nahi khula (HTTP ${pageRes.status}) — khud dekh lein.`
          });
          continue;
        }

        const html = await pageRes.text();
        const now = readPage(html);

        // ---- kuch bhi parh nahi saka: chup-chaap ghalat update NAHI karna ----
        if (now.price == null && now.in_stock == null) {
          summary.parse_failed++;
          await logAlert({
            product_id: p.id, product_name: p.name, alert_type: 'parse_failed',
            message: 'Page se price/stock parh nahi saka — manually dekh lein.'
          });
          continue;
        }

        const patch = { last_synced: new Date().toISOString() };

        // ---- STOCK ----
        if (now.in_stock === false && p.in_stock !== false) {
          patch.in_stock = false;
          patch.is_active = false;               // customer ko foran dikhna band
          summary.went_out_of_stock++;
          await logAlert({
            product_id: p.id, product_name: p.name, alert_type: 'out_of_stock',
            old_value: 'in stock', new_value: 'out of stock',
            message: 'Stock khatam ho gaya — product site se chhupa diya gaya hai.',
            status: 'approved'                   // ye khud-ba-khud laagu, kyunke bechna hi nahi
          });
        } else if (now.in_stock === true && p.in_stock === false) {
          summary.back_in_stock++;
          await logAlert({
            product_id: p.id, product_name: p.name, alert_type: 'back_in_stock',
            old_value: 'out of stock', new_value: 'in stock',
            message: 'Stock wapas aa gaya — dobara live karna hai?'
          });
        }

        if (now.stock_qty != null) patch.stock_qty = now.stock_qty;

        // ---- PRICE ----
        if (now.price != null) {
          await sb('price_history', {
            method: 'POST',
            body: JSON.stringify({ product_id: p.id, source_price: now.price })
          }).catch(() => {});

          const old = p.source_price;
          if (old != null && old > 0) {
            const diffPct = ((now.price - old) / old) * 100;
            if (Math.abs(diffPct) >= PRICE_CHANGE_THRESHOLD_PCT) {
              summary.price_changed++;
              const up = diffPct > 0;
              // tajweez: purana margin barqarar rakhte hue nayi selling price
              const margin = p.margin_pct != null ? p.margin_pct
                           : (p.price && old ? ((p.price - old) / old) * 100 : null);
              const suggested = margin != null ? Math.round(now.price * (1 + margin / 100)) : null;

              await logAlert({
                product_id: p.id, product_name: p.name,
                alert_type: up ? 'price_up' : 'price_down',
                old_value: `Rs ${old}`, new_value: `Rs ${now.price}`,
                message: up
                  ? `Cost ${Math.abs(diffPct).toFixed(1)}% barh gayi. ${suggested ? `Munafa barqarar rakhne ke liye nayi qeemat Rs ${suggested} — approve karein?` : 'Apni qeemat dobara dekh lein.'}`
                  : `Cost ${Math.abs(diffPct).toFixed(1)}% kam ho gayi. ${suggested ? `Chahein to qeemat Rs ${suggested} kar ke sasta bech sakte hain.` : ''}`
              });
            }
          }
          // cost hamesha update — ye sirf aapki apni maloomat hai, customer ki qeemat nahi
          patch.source_price = now.price;
        }

        await sb(`products?id=eq.${p.id}`, { method: 'PATCH', body: JSON.stringify(patch) });

      } catch (e) {
        summary.errors.push(`${p.name}: ${e.message}`);
        await logAlert({
          product_id: p.id, product_name: p.name, alert_type: 'parse_failed',
          message: `Check nahi ho saka: ${e.message}`
        });
      }
    }

    return res.status(200).json({ ok: true, ran_at: new Date().toISOString(), ...summary });

  } catch (err) {
    console.error('price-watch fatal:', err.message);
    return res.status(500).json({ ok: false, error: err.message, ...summary });
  }
};
