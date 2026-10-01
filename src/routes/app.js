/**
 * Merchant app routes (vivaspot-campaigns)
 *
 * Server-to-server only: the merchant app's server calls these with the
 * X-App-Key header, never a browser. The app tells us the merchant's VivaSpot
 * account (acc_id) and its access points' MACs, read from VivaSpot with the
 * merchant's own login, so connections are tied to the right account rather
 * than guessed from a Mailchimp login email or restaurant name.
 *
 *   POST /app/mailchimp/connect     { acc_id, macs, return_url } -> { authorize_url }
 *   GET  /app/mailchimp/status      ?acc_id=&macs=a,b            -> status (no guest data)
 *   GET  /app/mailchimp/audiences   ?acc_id=&macs=a,b            -> [{ id, name, member_count }]
 *   POST /app/mailchimp/audience    { acc_id, macs, audience_id }
 *   POST /app/mailchimp/disconnect  { acc_id, macs }
 *
 * The OAuth callback (/oauth/callback) recognises the flows started here and
 * sends the merchant back to `return_url` instead of the hosted pages.
 *
 * Env: APP_API_KEY (required; these routes refuse without it),
 *      APP_RETURN_ORIGINS (comma-separated origins `return_url` may use).
 */

const express = require('express');
const crypto = require('crypto');
const router = express.Router();

const db = require('../db');
const mailchimp = require('../services/mailchimp');
const { newRefId, hashState, logEvent } = require('../lib/oauthHelpers');

/** Marks a pending_oauth row as a merchant-app flow (its mac_address column). */
const APP_FLOW = 'app';

function requireAppKey(req, res, next) {
  const expected = process.env.APP_API_KEY;
  if (!expected) {
    return res.status(503).json({ error: 'App API is not configured' });
  }
  const given = String(req.headers['x-app-key'] || '');
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

router.use(requireAppKey);

const ACC_ID = /^acc_[A-Za-z0-9]{4,40}$/;

/** "aa:bb:cc:dd:ee:ff" for any of the usual spellings, or null. */
function normalizeMac(raw) {
  const clean = String(raw || '').replace(/[:\-.\s]/g, '').toLowerCase();
  return clean.length === 12 && /^[0-9a-f]+$/.test(clean) ? clean.match(/.{2}/g).join(':') : null;
}

/** The account and MACs from a body or query, or an error message. */
function accountFrom(src) {
  const accId = String(src.acc_id || '');
  if (!ACC_ID.test(accId)) return { error: 'acc_id is missing or invalid' };
  const rawMacs = Array.isArray(src.macs) ? src.macs : String(src.macs || '').split(',');
  const macs = [...new Set(rawMacs.map(normalizeMac).filter(Boolean))];
  if (macs.length === 0) return { error: 'macs: at least one access point MAC is required' };
  if (macs.length > 50) return { error: 'macs: at most 50' };
  return { accId, macs };
}

/** A return URL on one of the allowed origins, or null. */
function allowedReturnUrl(raw) {
  let url;
  try {
    url = new URL(String(raw || ''));
  } catch {
    return null;
  }
  const allowed = String(process.env.APP_RETURN_ORIGINS || '')
    .split(',')
    .map((o) => o.trim().replace(/\/$/, ''))
    .filter(Boolean);
  return allowed.includes(url.origin) ? url.toString() : null;
}

/** The connection the account's status is read from: the newest. */
function newest(rows) {
  return rows.reduce((a, b) => (new Date(b.updated_at) > new Date(a.updated_at) ? b : a));
}

/**
 * Start connecting Mailchimp. Returns the Mailchimp sign-in URL the app sends
 * the merchant's browser to. After they approve, /oauth/callback stores the
 * connection for these MACs and sends them back to return_url with
 * ?mailchimp=connected | choose_audience | no_audience | error.
 */
router.post('/mailchimp/connect', async (req, res) => {
  const refId = newRefId();
  const acct = accountFrom(req.body || {});
  if (acct.error) return res.status(400).json({ error: acct.error });
  const returnUrl = allowedReturnUrl(req.body.return_url);
  if (!returnUrl) return res.status(400).json({ error: 'return_url is missing or not on an allowed origin' });

  try {
    const state = crypto.randomBytes(32).toString('hex');
    await db.createPendingOAuth(state, APP_FLOW, JSON.stringify({ app: true, acc_id: acct.accId, macs: acct.macs, return_url: returnUrl }));
    logEvent('app.connect.start', { ref_id: refId, acc_id: acct.accId, macs: acct.macs.length, state_hash: hashState(state) });
    res.json({ authorize_url: mailchimp.getAuthorizationUrl(state) });
  } catch (error) {
    logEvent('app.connect.error', { ref_id: refId, message: error.message });
    res.status(500).json({ error: 'Failed to start connecting', ref_id: refId });
  }
});

/**
 * Where the account stands. Counts and times only, never guest emails.
 */
router.get('/mailchimp/status', async (req, res) => {
  const acct = accountFrom(req.query);
  if (acct.error) return res.status(400).json({ error: acct.error });

  try {
    const rows = await db.getAppConnections(acct.accId, acct.macs);
    if (rows.length === 0) {
      return res.json({ connected: false });
    }
    const current = newest(rows);
    const connectedMacs = rows.map((r) => r.mac_address.toLowerCase());
    const since = rows.reduce((a, r) => (new Date(r.created_at) < a ? new Date(r.created_at) : a), new Date());
    const monthAgo = new Date(Date.now() - 30 * 864e5);
    const [last, month] = await Promise.all([
      db.getLastSyncResults(connectedMacs, since),
      db.countSyncs(connectedMacs, since > monthAgo ? since : monthAgo),
    ]);
    res.json({
      connected: true,
      account_name: current.account_name,
      audience_id: current.audience_id || null,
      audience_name: current.audience_name || null,
      needs_audience: !current.audience_id,
      connected_at: since.toISOString(),
      access_points: { connected: connectedMacs.length, of: acct.macs.length, missing: acct.macs.filter((m) => !connectedMacs.includes(m)) },
      last_sent_at: last.lastSentAt,
      last_error: last.lastError && (!last.lastSentAt || new Date(last.lastError.at) > new Date(last.lastSentAt)) ? last.lastError : null,
      sent_30d: month.sent,
      failed_30d: month.failed,
      made_in_app: rows.some((r) => r.acc_id === acct.accId),
    });
  } catch (error) {
    console.error('App status error:', error.message);
    res.status(500).json({ error: 'Failed to read the connection' });
  }
});

/** The connected Mailchimp account's audiences, for the app's picker. */
router.get('/mailchimp/audiences', async (req, res) => {
  const acct = accountFrom(req.query);
  if (acct.error) return res.status(400).json({ error: acct.error });

  try {
    const rows = await db.getAppConnections(acct.accId, acct.macs);
    if (rows.length === 0) return res.status(404).json({ error: 'Not connected' });
    const current = newest(rows);
    const audiences = await mailchimp.getAudiences(current.access_token, current.data_center);
    res.json({ audiences: audiences.map((a) => ({ id: a.id, name: a.name, member_count: a.memberCount })) });
  } catch (error) {
    console.error('App audiences error:', error.message);
    res.status(502).json({ error: 'Mailchimp did not return the audiences' });
  }
});

/** Choose (or change) the audience sign-ups go to. */
router.post('/mailchimp/audience', async (req, res) => {
  const acct = accountFrom(req.body || {});
  if (acct.error) return res.status(400).json({ error: acct.error });
  const audienceId = String(req.body.audience_id || '');
  if (!/^[A-Za-z0-9]{4,40}$/.test(audienceId)) return res.status(400).json({ error: 'audience_id is missing or invalid' });

  try {
    const rows = await db.getAppConnections(acct.accId, acct.macs);
    if (rows.length === 0) return res.status(404).json({ error: 'Not connected' });
    const current = newest(rows);
    const audiences = await mailchimp.getAudiences(current.access_token, current.data_center);
    const audience = audiences.find((a) => a.id === audienceId);
    if (!audience) return res.status(400).json({ error: 'That audience is not in the connected Mailchimp account' });
    const updated = await db.setAppAudience(acct.accId, acct.macs, audience.id, audience.name);
    logEvent('app.audience.set', { acc_id: acct.accId, rows: updated.length });
    res.json({ success: true, audience_id: audience.id, audience_name: audience.name });
  } catch (error) {
    console.error('App audience error:', error.message);
    res.status(502).json({ error: 'Could not change the audience' });
  }
});

/**
 * Disconnect: new sign-ups stop going to Mailchimp. Contacts already in
 * Mailchimp stay there. Mailchimp has no API to revoke an OAuth token, so we
 * delete ours; the merchant can also remove VivaSpot under their Mailchimp
 * account's connected apps.
 */
router.post('/mailchimp/disconnect', async (req, res) => {
  const acct = accountFrom(req.body || {});
  if (acct.error) return res.status(400).json({ error: acct.error });

  try {
    const removed = await db.deleteAppConnections(acct.accId, acct.macs);
    logEvent('app.disconnect', { acc_id: acct.accId, removed });
    res.json({ success: true, removed });
  } catch (error) {
    console.error('App disconnect error:', error.message);
    res.status(500).json({ error: 'Failed to disconnect' });
  }
});

/**
 * The app flow's data from a consumed pending_oauth row, or null when the row
 * belongs to the older hosted flows.
 */
function appFlowFrom(pendingRow) {
  if (!pendingRow || pendingRow.mac_address !== APP_FLOW) return null;
  try {
    const data = JSON.parse(pendingRow.redirect_url || 'null');
    return data && data.app === true && Array.isArray(data.macs) && data.acc_id && data.return_url ? data : null;
  } catch {
    return null;
  }
}

/** `return_url` with ?mailchimp=<outcome> (and a reference on errors). */
function appReturn(flow, outcome, refId) {
  const url = new URL(flow.return_url);
  url.searchParams.set('mailchimp', outcome);
  if (refId) url.searchParams.set('ref', refId);
  return url.toString();
}

/**
 * Finish an app flow inside /oauth/callback: exchange the code, store the
 * connection for the account's MACs, and send the merchant back to the app.
 * With one audience it's chosen for them; otherwise they choose in the app
 * (the webhook skips contacts until they do).
 */
async function completeAppFlow(res, flow, code, refId) {
  try {
    const { accessToken } = await mailchimp.exchangeCodeForToken(code);
    const metadata = await mailchimp.getAccountMetadata(accessToken);
    const audiences = await mailchimp.getAudiences(accessToken, metadata.dataCenter);
    if (audiences.length === 0) {
      logEvent('app.connect.no_audience', { ref_id: refId, acc_id: flow.acc_id });
      return res.redirect(appReturn(flow, 'no_audience'));
    }

    // Keep the audience they had if it's in this Mailchimp account.
    const existing = await db.getAppConnections(flow.acc_id, flow.macs);
    const kept = existing.length ? audiences.find((a) => a.id === newest(existing).audience_id) : null;
    const chosen = audiences.length === 1 ? audiences[0] : kept || null;

    await db.upsertAppConnections(flow.acc_id, flow.macs, {
      accessToken,
      dataCenter: metadata.dataCenter,
      accountId: metadata.accountId,
      accountName: metadata.accountName,
      audienceId: chosen ? chosen.id : null,
      audienceName: chosen ? chosen.name : null,
    });
    logEvent('app.connect.done', { ref_id: refId, acc_id: flow.acc_id, macs: flow.macs.length, audience_chosen: !!chosen });
    return res.redirect(appReturn(flow, chosen ? 'connected' : 'choose_audience'));
  } catch (error) {
    logEvent('app.connect.error', { ref_id: refId, acc_id: flow.acc_id, message: error.message });
    return res.redirect(appReturn(flow, 'error', refId));
  }
}

module.exports = router;
module.exports.appFlowFrom = appFlowFrom;
module.exports.appReturn = appReturn;
module.exports.completeAppFlow = completeAppFlow;
