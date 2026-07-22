// /api/birbal-chat.js
// Vercel serverless function — Birbal AI backend with automatic failover.
//
// Chain: Groq -> Gemini -> Hugging Face -> OpenRouter.
// If one provider errors or hits its rate limit, the next one in the chain
// is tried immediately with the same conversation — the customer never
// sees which provider actually answered.
//
// Set these in Vercel Project Settings -> Environment Variables:
//   GROQ_API_KEY
//   GEMINI_API_KEY
//   HF_API_KEY
//   OPENROUTER_API_KEY
// Never put any of these keys directly in HTML/JS that ships to the browser.

const SYSTEM_PROMPT = `Tum "Birbal AI" ho — Birbal Mart (birbalmart.com) ka shopping advisor.
Birbal Mart ka usool: jo khud khareedein, wohi bechein. Sirf 4-star+ products.
Kabhi fake numbers, fake reviews, ya fake urgency ("sirf 2 bache hain!") nahi dete.
Agar koi policy (jaise universal free shipping ya fixed return window) abhi
platform pe live nahi hai to uska wada mat karo — sirf checkout page pe jo
dikh raha hai wahi sach hai.
Customer se Roman Urdu/Hinglish mein, seedhi aur dost jaisi baat karo — chhota,
madadgar jawab do, na ke lambi sales pitch. Agar sawal product ke baare mein hai
to honest raay do (agar cheez theek na lage to keh do). Agar order/delivery/COD
ke baare mein poochein to bata do ke Cash on Delivery available hai aur order
WhatsApp (0305-9192790) se confirm hota hai. Agar tumhe kisi cheez ka pakka jawab
nahi pata to saaf keh do ke pata nahi, jhooti maloomat mat do.
Language rule: customer jis zaban mein likhe usi mein jawab do — English mein
poochein to English, Urdu mein to Urdu, Arabic mein to Arabic, Hindi mein to
Hindi (Devanagari script). Zaban khud pehchano, customer se mat poochho.`;

// ---------- Provider callers ----------
// Each takes (messages) where messages = [{role, content}, ...] (no system
// message included — each caller injects the system prompt in whatever way
// that provider expects) and returns the reply text, or throws on failure.

async function callGroq(messages) {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error('GROQ_API_KEY missing');
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...messages],
      temperature: 0.6,
      max_tokens: 500
    })
  });
  if (!res.ok) throw new Error(`Groq ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const reply = data?.choices?.[0]?.message?.content?.trim();
  if (!reply) throw new Error('Groq: empty reply');
  return reply;
}

async function callGemini(messages) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY missing');
  const contents = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }]
  }));
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents,
        generationConfig: { temperature: 0.6, maxOutputTokens: 500 }
      })
    }
  );
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const reply = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
  if (!reply) throw new Error('Gemini: empty reply');
  return reply;
}

async function callHuggingFace(messages) {
  const key = process.env.HF_API_KEY;
  if (!key) throw new Error('HF_API_KEY missing');
  const res = await fetch('https://router.huggingface.co/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'meta-llama/Llama-3.3-70B-Instruct',
      messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...messages],
      temperature: 0.6,
      max_tokens: 500
    })
  });
  if (!res.ok) throw new Error(`HuggingFace ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const reply = data?.choices?.[0]?.message?.content?.trim();
  if (!reply) throw new Error('HuggingFace: empty reply');
  return reply;
}

async function callOpenRouter(messages) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error('OPENROUTER_API_KEY missing');
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://birbalmart.com',
      'X-Title': 'Birbal Mart'
    },
    body: JSON.stringify({
      model: 'meta-llama/llama-3.3-70b-instruct:free',
      messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...messages],
      temperature: 0.6,
      max_tokens: 500
    })
  });
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const reply = data?.choices?.[0]?.message?.content?.trim();
  if (!reply) throw new Error('OpenRouter: empty reply');
  return reply;
}

// ---------- Product search (shows real products inline in chat, like Alibaba's AI search) ----------
const SUPABASE_URL = 'https://szikthydpanliybbpehx.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InN6aWt0aHlkcGFubGl5YmJwZWh4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMwOTc3NjMsImV4cCI6MjA5ODY3Mzc2M30.g8smfp8XJxdXWzE7On6dAJdyiPzR-S_xcYN2m557cCI'; // public anon key — same one already used in products.html/product.html

const STOPWORDS = new Set(['a','an','the','is','are','main','mujhe','chahiye','hai','ka','ki','ke','se','mein','me','for','me','kya','koi','acha','achi','good','best','show','product','products','de','do','dikhao','batao','i','want','need','please','plz']);

function extractKeywords(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOPWORDS.has(w))
    .slice(0, 4);
}

async function searchProducts(lastUserMessage) {
  const keywords = extractKeywords(lastUserMessage);
  if (!keywords.length) return [];
  try {
    const orFilter = keywords.map(k => `name.ilike.*${k}*,category.ilike.*${k}*`).join(',');
    const url = `${SUPABASE_URL}/rest/v1/products?select=id,name,price,images,category,rating&or=(${orFilter})&limit=4`;
    const res = await fetch(url, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` }
    });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch (e) {
    console.error('Product search failed:', e.message);
    return [];
  }
}

// Order = the fallback chain. First one that succeeds wins.
const PROVIDERS = [
  { name: 'groq', call: callGroq },
  { name: 'gemini', call: callGemini },
  { name: 'huggingface', call: callHuggingFace },
  { name: 'openrouter', call: callOpenRouter }
];

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  const history = Array.isArray(body?.messages) ? body.messages : [];
  const productContext = typeof body?.product === 'string' ? body.product : '';

  const messages = history.slice(-12).map(m => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: String(m.content || '').slice(0, 2000)
  }));
  if (productContext) {
    messages.unshift({ role: 'user', content: `(Context: main is product ko dekh raha hun — ${productContext})` });
  }

  const lastUserMessage = [...messages].reverse().find(m => m.role === 'user')?.content || '';

  const errors = [];
  for (const provider of PROVIDERS) {
    try {
      const [reply, products] = await Promise.all([
        provider.call(messages),
        searchProducts(lastUserMessage)
      ]);
      return res.status(200).json({ reply, products }); // customer never sees which provider answered
    } catch (err) {
      errors.push(`${provider.name}: ${err.message}`);
      console.error(`Birbal AI provider failed (${provider.name}):`, err.message);
      // fall through to next provider
    }
  }

  // All four providers failed
  console.error('Birbal AI: all providers failed —', errors.join(' | '));
  return res.status(502).json({ error: 'Birbal AI abhi jawab nahi de saka. Thodi dair mein dobara koshish karein.' });
};
