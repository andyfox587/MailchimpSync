/**
 * Shared OAuth diagnostic + safety helpers.
 *
 * Used by both the Mailchimp (routes/oauth.js) and Klaviyo (routes/klaviyo.js)
 * flows so the hardening behaves identically across integrations.
 */

const crypto = require('crypto');

// Short ref shown to users on error pages so they can quote it back and we
// can grep every log line for one OAuth attempt.
function newRefId() {
  return crypto.randomBytes(3).toString('hex'); // 6 hex chars, e.g. "a3f29b"
}

// Never log the raw state — it's a CSRF token. Hash for correlation only.
function hashState(state) {
  if (!state) return null;
  return crypto.createHash('sha256').update(state).digest('hex').slice(0, 12);
}

function logEvent(event, fields) {
  try {
    console.log(JSON.stringify({ event, ts: new Date().toISOString(), ...fields }));
  } catch {
    // never let logging crash a request
    console.log(`[${event}]`, fields);
  }
}

function requestFingerprint(req) {
  return {
    ip: req.ip || req.headers['x-forwarded-for'] || null,
    ua: req.get('user-agent') || null,
    referer: req.get('referer') || null,
  };
}

// User agents that pre-fetch links (corporate safe-link scanners, chat
// unfurlers, browser prefetchers). If one of these hits an OAuth callback it
// would otherwise consume the single-use state and break the real user's flow.
const LINK_CHECKER_UA_PATTERNS = [
  /Slackbot-LinkExpanding/i,
  /\bSlackbot\b/i,
  /Slack-ImgProxy/i,
  /facebookexternalhit/i,
  /Twitterbot/i,
  /LinkedInBot/i,
  /WhatsApp/i,
  /TelegramBot/i,
  /Discordbot/i,
  /Mattermost-Bot/i,
  /SkypeUriPreview/i,
  /Microsoft Office/i,
  /OfficeProtect/i,
  /BingPreview/i,
  /YandexBot/i,
  /Google-Safety/i,
  /GoogleImageProxy/i,
  /MSOffice/i,
  /Outlook-iOS/i,
  /Outlook-Android/i,
  /safelinks/i,
];

function isLinkCheckerUA(ua) {
  if (!ua) return false;
  return LINK_CHECKER_UA_PATTERNS.some((pat) => pat.test(ua));
}

module.exports = {
  newRefId,
  hashState,
  logEvent,
  requestFingerprint,
  isLinkCheckerUA,
  LINK_CHECKER_UA_PATTERNS,
};
