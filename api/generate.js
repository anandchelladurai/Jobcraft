const Anthropic = require('@anthropic-ai/sdk');

const rateLimitStore = new Map();
const RATE_LIMIT = 10;
const WINDOW_MS = 24 * 60 * 60 * 1000;

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = rateLimitStore.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimitStore.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return { allowed: true, remaining: RATE_LIMIT - 1 };
  }
  if (entry.count >= RATE_LIMIT) {
    return { allowed: false, retryAfterSecs: Math.ceil((entry.resetAt - now) / 1000) };
  }
  entry.count++;
  return { allowed: true, remaining: RATE_LIMIT - entry.count };
}

module.exports = async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Rate limiting
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket?.remoteAddress || 'unknown';
  const rateCheck = checkRateLimit(ip);
  if (!rateCheck.allowed) {
    return res.status(429).json({ error: `Rate limit exceeded. Try again in ${rateCheck.retryAfterSecs} seconds.` });
  }

  // Validate request body
  const { prompt, maxTokens } = req.body || {};
  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({ error: 'Invalid request: prompt is required' });
  }

  // Check API key
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Server configuration error: API key not set' });
  }

  try {
    const client = new Anthropic({ apiKey });

    const message = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: maxTokens || 2000,
      messages: [{ role: 'user', content: prompt }]
    });

    const content = message.content?.[0]?.text;

    if (!content) {
      return res.status(500).json({ error: 'Empty response from Claude' });
    }

    return res.status(200).json({ content });

  } catch (error) {
    console.error('Anthropic API error:', error);

    if (error.status === 401) {
      return res.status(401).json({ error: 'Invalid API key' });
    }
    if (error.status === 429) {
      return res.status(429).json({ error: 'Rate limit reached. Please try again shortly.' });
    }
    if (error.status === 529) {
      return res.status(529).json({ error: 'Claude is temporarily overloaded. Please retry.' });
    }

    return res.status(500).json({ error: error.message || 'Internal server error' });
  }
};