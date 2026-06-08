// api/search.js — Vercel serverless function
// Proxies requests to PokémonPriceTracker API v2, injecting the API key server-side.

const BASE_URL = 'https://www.pokemonpricetracker.com/api/v2';

export default async function handler(req, res) {
  // CORS for local dev
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.POKEPRICE_API_KEY;
  if (!apiKey) {
    return res.status(503).json({ error: 'API key not configured. Set POKEPRICE_API_KEY in Vercel environment variables.' });
  }

  // Forward all query params from the client to the upstream API
  const { search, language, limit, set, tcgPlayerId } = req.query;

  const params = new URLSearchParams();
  if (search)      params.set('search',      search.trim());
  if (language)    params.set('language',    language === 'japanese' ? 'japanese' : 'english');
  if (limit)       params.set('limit',       String(Math.min(Number(limit) || 20, 50)));
  if (set)         params.set('set',         set.trim());
  if (tcgPlayerId) params.set('tcgPlayerId', tcgPlayerId.trim());

  // Default limit
  if (!params.has('limit')) params.set('limit', '24');

  const upstream = `${BASE_URL}/cards?${params}`;

  try {
    const response = await fetch(upstream, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Accept': 'application/json',
      },
    });

    const body = await response.text();

    if (!response.ok) {
      return res.status(response.status).json({ error: 'Upstream API error', detail: body });
    }

    const data = JSON.parse(body);

    // Normalise: API returns { data: [...] } or { data: {...} }
    const cards = Array.isArray(data.data)
      ? data.data
      : data.data
        ? [data.data]
        : [];

    res.setHeader('Cache-Control', 's-maxage=180, stale-while-revalidate=60');
    return res.status(200).json({
      cards,
      metadata: data.metadata || {},
      total: cards.length,
    });
  } catch (err) {
    console.error('pokeprice proxy error:', err);
    return res.status(500).json({ error: 'Proxy fetch failed', detail: err.message });
  }
}
