/**
 * Who may post sign-ups to /webhook/*, /klaviyo/webhook/* and /infobip/webhook/*.
 *
 * WEBHOOK_KEY (preferred): the sender (the n8n CRM Router) sends it as the
 * X-Webhook-Key header. Simple to send from n8n with a Header Auth credential.
 * WEBHOOK_SECRET (older): an HMAC-SHA256 of the JSON body in
 * X-Webhook-Signature. Either one passes when its variable is set.
 * With neither variable set, posts are accepted from anyone (the old
 * behaviour), and the service warns about it at startup.
 *
 * Rollout without losing sign-ups: deploy this, make n8n send X-Webhook-Key,
 * and only then set WEBHOOK_KEY on Render.
 */
const crypto = require('crypto');

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function verifyWebhook(req, res, next) {
  const key = process.env.WEBHOOK_KEY;
  const secret = process.env.WEBHOOK_SECRET;
  if (!key && !secret) return next();

  const givenKey = req.headers['x-webhook-key'];
  if (key && givenKey && safeEqual(givenKey, key)) return next();

  const signature = req.headers['x-webhook-signature'];
  if (secret && signature) {
    const expected = crypto.createHmac('sha256', secret).update(JSON.stringify(req.body)).digest('hex');
    if (safeEqual(signature, expected)) return next();
  }

  return res.status(401).json({ error: givenKey || signature ? 'Invalid webhook key' : 'Missing webhook key' });
}

function warnIfOpen() {
  if (!process.env.WEBHOOK_KEY && !process.env.WEBHOOK_SECRET) {
    console.warn('⚠ WEBHOOK_KEY is not set: the sign-up webhooks accept posts from anyone.');
  }
}

module.exports = { verifyWebhook, warnIfOpen };
