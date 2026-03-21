const Anthropic = require('@anthropic-ai/sdk');

// In-memory rate limit store: ip -> { count, resetAt }
const rateLimitStore = new Map();
const RATE_LIMIT = 10;
const WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = rateLimitStore.get(ip);

  if (!entry || now > entry.resetAt) {
    rateLimitStore.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return { allowed: true, remaining: RATE_LIMIT - 1 };
  }

  if (entry.count >= RATE_LIMIT) {
    const retryAfterSecs = Math.ceil((entry.resetAt - now) / 1000);
    return { allowed: false, retryAfterSecs };
  }

  entry.count++;
  return { allowed: true, remaining: RATE_LIMIT - entry.count };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Get client IP
  const ip =
    req.headers['x-forwarded-for']?.split(',')[0].trim() ||
    req.socket?.remoteAddress ||
    'unknown';

  const limit = checkRateLimit(ip);
  if (!limit.allowed) {
    res.setHeader('Retry-After', limit.retryAfterSecs);
    return res.status(429).json({
      error: `Rate limit exceeded. You can make ${RATE_LIMIT} requests per 24 hours. Please try again later.`,
    });
  }

  const { prompt, maxTokens } = req.body || {};

  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid prompt' });
  }
  if (!maxTokens || typeof maxTokens !== 'number') {
    return res.status(400).json({ error: 'Missing or invalid maxTokens' });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'Server configuration error: API key not set.' });
  }
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  try {
    const message = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = message.content.map((block) => block.text || '').join('');
    res.setHeader('X-RateLimit-Remaining', limit.remaining);
    return res.status(200).json({ text });
  } catch (err) {
    const status = err.status || 500;
    return res.status(status).json({ error: err.message || 'API error' });
  }
};
