// /api/product-import.js
// WAZIR #1 — "Quick Add"
// Aap ek product ka link bhejte hain, ye us page se title, price aur
// tasveerein nikaal kar laata hai, phir AI se saaf title banwa kar
// aapki APNI categories table mein se sahi category chun leta hai.
// Kuch bhi khud se save nahi karta — sirf tajweez wapas bhejta hai.
//
// Environment variables (Vercel → Settings → Environment Variables):
//   GROQ_API_KEY (+ backup GEMINI_API_KEY / OPENROUTER_API_KEY)
//   ADMIN_PASSCODE

const SUPABASE_URL = 'https://szikthydpanliybbpehx.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InN6aWt0aHlkcGFubGl5YmJwZWh4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMwOTc3NjMsImV4cCI6MjA5ODY3Mzc2M30.g8smfp8XJxdXWzE7On6dAJdyiPzR-S_xcYN2m557cCI';

// ---------- helpers ----------

function pick(html, regexes) {
  for (const re of regexes) {
    const m = html.match(re);
    if (m && m[1] && m[1].trim()) return m[1].trim();
  }
  return null;
}

function decodeEntities(s) {
  if (!s) return s;
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(d));
}

function detectStore(url) {
  const u = url.toLowerCase();
  if (u.includes('markaz')) return 'markaz';
  if (u.includes('aliexpress')) return 'aliexpress';
  if (u.includes('daraz')) return 'daraz';
  return 'other';
}

async function getCategories() {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/categories?select=id,name,emoji&is_active=eq.true&order=name`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` }
  });
  if (!r.ok) return [];
  return r.json();
}

function fromJsonLd(html) {
  const out = {};
  const blocks = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (const block of blocks) {
    const raw = block.replace(/<script[^>]*>/i, '').replace(/<\/script>/i, '').trim();
    let data;
    try { data = JSON.parse(raw); } catch { continue; }
    const items = Array.isArray(data) ? data : [data];
    for (const item of items) {
      const nodes = item['@graph'] ? item['@graph'] : [item];
      for (const node of nodes) {
        const type = String(node['@type'] || '').toLowerCase();
        if (!type.includes('product')) continue;
        if (node.name && !out.title) out.title = String(node.name);
        if (node.description && !out.description) out.description = String(node.description);
        if (node.image && !out.images) {
          out.images = Array.isArray(node.image) ? node.image.map(String) : [String(node.image)];
        }
        const offers = Array.isArray(node.offers) ? node.offers[0] : node.offers;
        if (offers) {
          if (offers.price && !out.price) out.price = parseFloat(String(offers.price).replace(/[^0-9.]/g, ''));
          if (offers.availability && out.in_stock === undefined) {
            out.in_stock = !String(offers.availability).toLowerCase().includes('outofstock');
          }
        }
        if (node.aggregateRating?.ratingValue && !out.rating) {
          out.rating = parseFloat(node.aggregateRating.ratingValue);
        }
        if (node.aggregateRating?.reviewCount && !out.review_count) {
          out.review_count = parseInt(node.aggregateRating.reviewCount, 10);
        }
      }
    }
  }
  return out;
}

function fromMetaTags(html) {
  const out = {};
  out.title = decodeEntities(pick(html, [
    /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+name=["']twitter:title["'][^>]+content=["']([^"']+)["']/i,
    /<title[^>]*>([^<]+)<\/title>/i
  ]));
  out.description = decodeEntities(pick(html, [
    /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i
  ]));
  const img = pick(html, [
    /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i
  ]);
  if (img) out.images = [decodeEntities(img)];

  const p = pick(html, [
    /<meta[^>]+property=["']product:price:amount["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+property=["']og:price:amount["'][^>]+content=["']([^"']+)["']/i,
    /"price"\s*:\s*"?([0-9][0-9,.]*)"?/i,
    /(?:Rs\.?|PKR|₨)\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i
  ]);
  if (p) out.price = parseFloat(String(p).replace(/,/g, '').replace(/[^0-9.]/g, ''));
  return out;
}

function extraImages(html, limit = 5) {
  const found = new Set();
  const re = /<img[^>]+(?:data-src|data-original|src)=["'](https?:\/\/[^"']+\.(?:jpg|jpeg|png|webp)[^"']*)["']/gi;
  let m;
  while ((m = re.exec(html)) && found.size < limit) {
    const url = decodeEntities(m[1]);
    if (/logo|icon|sprite|placeholder|avatar|banner/i.test(url)) continue;
    found.add(url);
  }
  return [...found];
}

// ---------- AI: title saaf karna + apni categories mein se best match chunna ----------

async function askAI(prompt) {
  const providers = [
    async () => {
      const key = process.env.GROQ_API_KEY;
      if (!key) throw new Error('no groq key');
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.2, max_tokens: 400
        })
      });
      if (!r.ok) throw new Error('groq ' + r.status);
      return (await r.json())?.choices?.[0]?.message?.content;
    },
    async () => {
      const key = process.env.GEMINI_API_KEY;
      if (!key) throw new Error('no gemini key');
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }] })
      });
      if (!r.ok) throw new Error('gemini ' + r.status);
      return (await r.json())?.candidates?.[0]?.content?.parts?.[0]?.text;
    },
    async () => {
      const key = process.env.OPENROUTER_API_KEY;
      if (!key) throw new Error('no openrouter key');
      const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'meta-llama/llama-3.3-70b-instruct:free',
          messages: [{ role: 'user', content: prompt }], temperature: 0.2, max_tokens: 400
        })
      });
      if (!r.ok) throw new Error('openrouter ' + r.status);
      return (await r.json())?.choices?.[0]?.message?.content;
    }
  ];
  for (const p of providers) {
    try {
      const out = await p();
      if (out) return out;
    } catch (e) { /* agla try karo */ }
  }
  return null;
}

async function aiEnrich(raw, categories) {
  const catNames = categories.map(c => c.name);
  const prompt = `Tum ek e-commerce catalog assistant ho. Neeche ek product ka raw data hai jo website se nikala gaya hai.

Raw title: ${raw.title || '(nahi mila)'}
Raw description: ${(raw.description || '').slice(0, 400)}

Hamari store ki mojooda categories: ${catNames.join(', ')}

Kaam:
1. Ek saaf, chhota product title banao (max 60 characters). Keyword spam, store ka naam, "Free Shipping" jaisi bakwas hata do.
2. Upar di gayi categories mein se EXACTLY ek chuno jo is product se sab se zyada match kare. Agar koi bhi theek se match na kare to "NONE" likho.
3. Ek chhoti honest description likho (max 2 sentences, Roman Urdu mein) — sirf wahi likho jo raw data mein hai, koi jhooti tareef nahi.

Sirf JSON do, aur kuch nahi:
{"title":"...","category":"...","description":"..."}`;

  const text = await askAI(prompt);
  if (!text) return null;
  try {
    const clean = text.replace(/```json/gi, '').replace(/```/g, '').trim();
    const start = clean.indexOf('{'), end = clean.lastIndexOf('}');
    return JSON.parse(clean.slice(start, end + 1));
  } catch {
    return null;
  }
}

// ---------- main ----------

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-passcode');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const passcode = req.headers['x-admin-passcode'];
  if (!process.env.ADMIN_PASSCODE || passcode !== process.env.ADMIN_PASSCODE) {
    return res.status(401).json({ error: 'Ghalat passcode.' });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const url = String(body?.url || '').trim();
  if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'Sahi link bhejein (https:// se shuru).' });

  const categories = await getCategories();

  try {
    const pageRes = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9'
      },
      redirect: 'follow'
    });

    if (!pageRes.ok) {
      return res.status(200).json({
        ok: false,
        reason: `Page khula nahi (${pageRes.status}). Shayad link galat hai ya site block kar rahi hai. Tafseel khud bhar dein.`,
        source_url: url, source: detectStore(url), categories
      });
    }

    const html = await pageRes.text();
    const ld = fromJsonLd(html);
    const meta = fromMetaTags(html);

    const raw = {
      title: ld.title || meta.title || null,
      description: ld.description || meta.description || null,
      price: ld.price ?? meta.price ?? null,
      images: (ld.images && ld.images.length ? ld.images : (meta.images || [])).concat(extraImages(html)),
      rating: ld.rating ?? null,
      review_count: ld.review_count ?? null,
      in_stock: ld.in_stock !== undefined ? ld.in_stock : true
    };
    raw.images = [...new Set(raw.images)].slice(0, 6);

    if (!raw.title && raw.price == null) {
      return res.status(200).json({
        ok: false,
        reason: 'Is page se kuch parh nahi saka (shayad login/JavaScript maangta hai). Neeche khud tafseel bhar dein.',
        source_url: url, source: detectStore(url), categories
      });
    }

    const ai = await aiEnrich(raw, categories);
    const matchedCat = ai?.category ? categories.find(c => c.name.toLowerCase() === ai.category.toLowerCase()) : null;

    return res.status(200).json({
      ok: true,
      source_url: url,
      source: detectStore(url),
      source_price: raw.price,
      categories,
      suggested: {
        title: ai?.title || raw.title || '',
        category_id: matchedCat?.id || null,
        category_name: matchedCat?.name || null,
        description: ai?.description || raw.description || '',
        images: raw.images,
        rating: raw.rating,
        review_count: raw.review_count,
        in_stock: raw.in_stock
      },
      ai_used: !!ai,
      note: ai ? (matchedCat ? null : 'AI ko koi maujooda category theek se match nahi lagi — khud chun lein ya nayi banayein.')
               : 'AI se rabta nahi ho saka — title/category khud dekh lein.'
    });

  } catch (err) {
    console.error('product-import error:', err.message);
    return res.status(200).json({
      ok: false,
      reason: 'Link kholne mein masla hua. Neeche khud tafseel bhar dein.',
      source_url: url, source: detectStore(url), categories
    });
  }
};
