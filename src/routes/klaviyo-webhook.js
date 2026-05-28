/**
 * Klaviyo Webhook Routes  (mounted at /klaviyo/webhook)
 *
 * Receives contact data from the n8n CRM Router and syncs to Klaviyo.
 * Accepts the SAME payload as the Mailchimp /webhook/contact endpoint, so the
 * CRM Router only needs a parallel HTTP node — no payload changes.
 *
 * POST /klaviyo/webhook/contact
 * {
 *   "mac_address": "XX:XX:XX:XX:XX:XX",
 *   "email": "guest@example.com",
 *   "first_name": "John",
 *   "last_name": "Doe",
 *   "phone": "+1234567890",
 *   "source": "WiFi Portal",
 *   "location_name": "Hill Country BBQ"
 * }
 */

const express = require('express');
const crypto = require('crypto');
const router = express.Router();

const db = require('../db');
const klaviyo = require('../services/klaviyo');

// Refresh a token this many seconds before it actually expires.
const TOKEN_REFRESH_BUFFER_SECONDS = 120;

/**
 * Verify webhook signature (if WEBHOOK_SECRET is configured).
 */
function verifySignature(req, res, next) {
  const secret = process.env.WEBHOOK_SECRET;
  if (!secret) return next();

  const signature = req.headers['x-webhook-signature'];
  if (!signature) {
    return res.status(401).json({ error: 'Missing webhook signature' });
  }
  const payload = JSON.stringify(req.body);
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  if (signature !== expected) {
    return res.status(401).json({ error: 'Invalid webhook signature' });
  }
  next();
}

/**
 * Return a valid access token for a connection, refreshing if it's expired or
 * about to expire. Persists refreshed tokens for every MAC on the same account.
 * Throws an error with code INVALID_GRANT if the app was uninstalled.
 */
async function getValidAccessToken(connection) {
  const expiresAt = new Date(connection.token_expires_at).getTime();
  const needsRefresh = Date.now() >= expiresAt - TOKEN_REFRESH_BUFFER_SECONDS * 1000;

  if (!needsRefresh) {
    return connection.access_token;
  }

  const refreshed = await klaviyo.refreshAccessToken(connection.refresh_token);
  await db.updateKlaviyoTokens(connection.account_id, {
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken,
    tokenExpiresAt: refreshed.tokenExpiresAt,
  });
  return refreshed.accessToken;
}

/**
 * Main contact sync endpoint.
 * POST /klaviyo/webhook/contact
 */
router.post('/contact', verifySignature, async (req, res) => {
  const startTime = Date.now();
  try {
    const { mac_address, email, first_name, last_name, phone, source, location_name, custom_fields = {} } = req.body;

    if (!mac_address) return res.status(400).json({ error: 'Missing required field: mac_address' });
    if (!email) return res.status(400).json({ error: 'Missing required field: email' });

    const normalizedMac = mac_address.toLowerCase();

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    // Look up connection; fall back to fuzzy auto-mapping by location name.
    let connection = await db.getKlaviyoConnectionByMac(normalizedMac);
    if (!connection && location_name) {
      connection = await tryAutoMapping(normalizedMac, location_name);
    }

    if (!connection) {
      await db.logSync({ macAddress: normalizedMac, email, success: false, errorMessage: 'No Klaviyo connection found' });
      return res.status(404).json({ error: 'No Klaviyo connection found for this location', mac_address: normalizedMac });
    }

    // Build contact + source tag.
    const sourceTagParts = ['VivaSpot WiFi'];
    if (connection.source_tag) sourceTagParts.push(connection.source_tag);
    if (source) sourceTagParts.push(source);
    const customSource = sourceTagParts.join(' | ');

    const contact = {
      email,
      firstName: first_name,
      lastName: last_name,
      phone,
      properties: { vivaspot_source: customSource, ...custom_fields },
    };

    // Valid (refreshed if needed) token, then sync.
    let accessToken;
    try {
      accessToken = await getValidAccessToken(connection);
    } catch (tokenErr) {
      if (tokenErr.code === 'INVALID_GRANT') {
        await db.logSync({ macAddress: normalizedMac, email, success: false, errorMessage: 'Klaviyo app uninstalled' });
        return res.status(410).json({ error: 'Klaviyo app was uninstalled for this account. Please reconnect.', account: connection.account_name });
      }
      throw tokenErr;
    }

    const result = await klaviyo.syncContact(accessToken, connection.list_id, contact, customSource);
    const duration = Date.now() - startTime;

    await db.logSync({ macAddress: normalizedMac, email, success: true, errorMessage: null });
    console.log(`Klaviyo contact synced: ${email} -> ${connection.account_name} (${duration}ms)`);

    res.json({
      success: true,
      email: result.email,
      status: result.status,
      account: connection.account_name,
      list: connection.list_name,
      source: customSource,
      duration_ms: duration,
    });
  } catch (error) {
    console.error('Klaviyo contact sync error:', error.message);
    await db.logSync({ macAddress: req.body.mac_address, email: req.body.email, success: false, errorMessage: error.message });
    res.status(500).json({ error: 'Failed to sync contact', message: error.message });
  }
});

/**
 * Test endpoint — verify a connection works.
 * POST /klaviyo/webhook/test
 */
router.post('/test', async (req, res) => {
  try {
    const { mac_address } = req.body;
    if (!mac_address) return res.status(400).json({ error: 'Missing mac_address' });

    const connection = await db.getKlaviyoConnectionByMac(mac_address);
    if (!connection) {
      return res.status(404).json({ error: 'No connection found', mac_address });
    }

    let accessToken;
    try {
      accessToken = await getValidAccessToken(connection);
    } catch (tokenErr) {
      return res.json({ success: false, error: tokenErr.code === 'INVALID_GRANT' ? 'App uninstalled — reconnect required' : 'Token refresh failed', account: connection.account_name });
    }

    const isValid = await klaviyo.pingAccount(accessToken);
    res.json({
      success: isValid,
      connection: {
        mac_address: connection.mac_address,
        account_name: connection.account_name,
        list_name: connection.list_name,
        source_tag: connection.source_tag,
        token_expires_at: connection.token_expires_at,
        connected_at: connection.created_at,
      },
    });
  } catch (error) {
    console.error('Klaviyo test endpoint error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Fuzzy-map a location to an existing Klaviyo connection and create a row for
 * this MAC. Mirrors the Mailchimp webhook auto-mapping.
 */
async function tryAutoMapping(macAddress, locationName) {
  try {
    const matches = await db.findKlaviyoConnectionsByAccountName(locationName, 0.3);
    if (matches.length === 0) return null;

    const best = matches[0];
    console.log(`Klaviyo auto-mapped "${locationName}" -> "${best.account_name}" (score: ${best.match_score})`);

    return await db.upsertKlaviyoConnection({
      macAddress,
      accessToken: best.access_token,
      refreshToken: best.refresh_token,
      tokenExpiresAt: best.token_expires_at,
      accountId: best.account_id,
      accountName: best.account_name,
      loginEmail: best.login_email,
      listId: best.list_id,
      listName: best.list_name,
      sourceTag: locationName,
    });
  } catch (error) {
    console.error('Klaviyo auto-mapping error:', error.message);
    return null;
  }
}

module.exports = router;
