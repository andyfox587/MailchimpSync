/**
 * Klaviyo OAuth Routes  (mounted at /klaviyo)
 *
 * Mirrors the Mailchimp OAuth flow (routes/oauth.js) with two additions
 * Klaviyo requires:
 *   - Authorization Code + PKCE (a per-request code_verifier / code_challenge).
 *   - Access tokens expire, so we persist a refresh token + expiry.
 *
 * Flow:
 *   GET  /klaviyo/oauth/authorize     -> store state + PKCE verifier, redirect to Klaviyo
 *   GET  /klaviyo/oauth/callback      -> exchange code, pick list, auto-map MACs
 *   POST /klaviyo/oauth/select-list   -> when the account has multiple lists
 *   POST /klaviyo/oauth/select-location -> when multiple VivaSpot sites match
 *   POST /klaviyo/oauth/add-location  -> manual location + MAC entry
 *   GET  /klaviyo/oauth/status/:mac   -> connection status
 *   DELETE /klaviyo/oauth/disconnect/:mac
 */

const express = require('express');
const crypto = require('crypto');
const router = express.Router();

const db = require('../db');
const klaviyo = require('../services/klaviyo');
const {
  newRefId,
  hashState,
  logEvent,
  requestFingerprint,
  isLinkCheckerUA,
} = require('../lib/oauthHelpers');

const MAC_REGEX = /^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/;

// =============================================================================
// Start OAuth
// =============================================================================

router.get('/oauth/authorize', async (req, res) => {
  const refId = newRefId();
  try {
    const { mac_address, redirect_url } = req.query;

    // Normalize an optional MAC (colons, dashes, dots, or none).
    let macAddr = 'auto';
    if (mac_address) {
      const clean = String(mac_address).replace(/[:\-.\s]/g, '').toLowerCase();
      if (clean.length === 12 && /^[0-9a-f]+$/.test(clean)) {
        macAddr = clean.match(/.{2}/g).join(':');
      } else {
        return res.status(400).json({
          error: 'Invalid MAC address. Expected 12 hex characters (e.g. XX:XX:XX:XX:XX:XX). Omit the parameter to start without a MAC.',
          received: mac_address,
          ref_id: refId,
        });
      }
    }

    // CSRF state + PKCE pair.
    const state = crypto.randomBytes(32).toString('hex');
    const { codeVerifier, codeChallenge } = klaviyo.generatePKCE();

    await db.createPendingKlaviyoOAuth(state, macAddr, redirect_url || null, codeVerifier);

    const authUrl = klaviyo.getAuthorizationUrl(state, codeChallenge);

    logEvent('klaviyo.oauth.start', {
      ref_id: refId,
      mac: macAddr,
      state_hash: hashState(state),
      has_redirect_url: !!redirect_url,
      ...requestFingerprint(req),
    });
    res.redirect(authUrl);
  } catch (error) {
    logEvent('klaviyo.oauth.start.error', {
      ref_id: refId,
      message: error.message,
      ...requestFingerprint(req),
    });
    res.status(500).json({ error: 'Failed to start Klaviyo OAuth flow' });
  }
});

// =============================================================================
// Callback
// =============================================================================

router.get('/oauth/callback', async (req, res) => {
  const refId = newRefId();

  // Link prefetchers / safe-link scanners get an inert page so they can't
  // consume the single-use state ahead of the real user.
  if (isLinkCheckerUA(req.get('user-agent'))) {
    logEvent('klaviyo.oauth.callback.bot_skipped', { ref_id: refId, ...requestFingerprint(req) });
    return res.status(200).send('<!doctype html><title>VivaSpot OAuth</title>');
  }

  try {
    const { code, state, error: oauthError } = req.query;

    logEvent('klaviyo.oauth.callback', {
      ref_id: refId,
      state_hash: hashState(state),
      has_code: !!code,
      oauth_error: oauthError || null,
      ...requestFingerprint(req),
    });

    if (oauthError) {
      logEvent('klaviyo.oauth.callback.klaviyo_error', { ref_id: refId, oauth_error: oauthError });
      return renderProblemPage(res, 'klaviyo_error', refId, oauthError);
    }

    if (!code || !state) {
      return res.status(400).json({ error: 'Missing required parameters: code and state', ref_id: refId });
    }

    const consumeResult = await db.consumePendingOAuth(state);
    logEvent('klaviyo.oauth.consume', {
      ref_id: refId,
      state_hash: hashState(state),
      status: consumeResult.status,
      age_seconds: consumeResult.ageSeconds ?? null,
    });

    if (consumeResult.status !== 'consumed') {
      if (consumeResult.status === 'recently_used' && consumeResult.row) {
        const mac = consumeResult.row.mac_address;
        if (mac && mac !== 'auto') {
          const existing = await db.getKlaviyoConnectionByMac(mac);
          if (existing) {
            return renderSuccessPage(res, existing.account_name, existing.list_name, null, 1, existing.source_tag);
          }
        }
        return renderAlreadyConnectedPage(res, refId);
      }
      return renderProblemPage(res, consumeResult.status, refId);
    }

    const pending = consumeResult.row;
    const codeVerifier = pending.code_verifier;
    const macAddress = pending.mac_address;
    const redirectUrl = pending.redirect_url;

    // Exchange code -> tokens (PKCE).
    const tokens = await klaviyo.exchangeCodeForToken(code, codeVerifier);

    // Account + lists.
    const metadata = await klaviyo.getAccountMetadata(tokens.accessToken);
    const lists = await klaviyo.getLists(tokens.accessToken);

    logEvent('klaviyo.oauth.exchanged', {
      ref_id: refId,
      account_id: metadata.accountId,
      list_count: lists.length,
    });

    if (lists.length === 0) {
      return renderProblemPage(res, 'no_lists', refId);
    }

    if (lists.length === 1) {
      return completeWithList(res, {
        refId,
        macAddress,
        redirectUrl,
        tokens,
        metadata,
        list: lists[0],
        sourceTag: null,
      });
    }

    // Multiple lists -> selection page. Stash credentials in pending row.
    const selectionState = crypto.randomBytes(32).toString('hex');
    await db.query(
      `INSERT INTO pending_oauth (state, mac_address, redirect_url, expires_at)
       VALUES ($1, $2, $3, NOW() + INTERVAL '10 minutes')`,
      [selectionState, macAddress, JSON.stringify({ tokens: serializeTokens(tokens), metadata, redirectUrl })]
    );
    return renderListSelectionPage(res, lists, selectionState, metadata.accountName);
  } catch (error) {
    logEvent('klaviyo.oauth.callback.error', {
      ref_id: refId,
      message: error.message,
      klaviyo_error: error.klaviyoError || null,
      klaviyo_error_description: error.klaviyoErrorDescription || null,
      http_status: error.httpStatus || null,
      stack: error.stack,
    });
    const detail = error.klaviyoError
      ? `${error.message} — Klaviyo said: ${error.klaviyoError}${error.klaviyoErrorDescription ? ' (' + error.klaviyoErrorDescription + ')' : ''}`
      : error.message;
    return renderProblemPage(res, 'exception', refId, detail);
  }
});

// =============================================================================
// Select list (multi-list accounts)
// =============================================================================

router.post('/oauth/select-list', express.urlencoded({ extended: true }), async (req, res) => {
  const refId = newRefId();
  try {
    const { state, list_id, list_name, source_tag } = req.body;
    if (!state || !list_id) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }

    const result = await db.query('SELECT * FROM pending_oauth WHERE state = $1 AND expires_at > NOW()', [state]);
    if (result.rows.length === 0) {
      return renderProblemPage(res, 'expired', refId);
    }

    const { tokens, metadata, redirectUrl } = JSON.parse(result.rows[0].redirect_url);
    await db.query('DELETE FROM pending_oauth WHERE state = $1', [state]);

    return completeWithList(res, {
      refId,
      macAddress: result.rows[0].mac_address,
      redirectUrl,
      tokens: deserializeTokens(tokens),
      metadata,
      list: { id: list_id, name: list_name },
      sourceTag: source_tag || null,
    });
  } catch (error) {
    logEvent('klaviyo.oauth.select_list.error', { ref_id: refId, message: error.message });
    res.status(500).send('Failed to complete setup. Please try again.');
  }
});

// =============================================================================
// Select location (multiple matching VivaSpot sites)
// =============================================================================

router.post('/oauth/select-location', express.urlencoded({ extended: true }), async (req, res) => {
  const refId = newRefId();
  try {
    const { state, site_id } = req.body;
    if (!state || !site_id) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }

    const result = await db.query('SELECT * FROM pending_oauth WHERE state = $1 AND expires_at > NOW()', [state]);
    if (result.rows.length === 0) {
      return renderProblemPage(res, 'expired', refId);
    }

    const { tokens, metadata, redirectUrl, listId, listName, sourceTag } = JSON.parse(result.rows[0].redirect_url);

    const siteResult = await db.vivaspotQuery('SELECT * FROM vivaspot_sites WHERE id = $1', [site_id]);
    if (siteResult.rows.length === 0) {
      return res.status(400).send('Selected location not found. Please try again.');
    }
    const site = siteResult.rows[0];
    await db.query('DELETE FROM pending_oauth WHERE state = $1', [state]);

    if (!site.mac_addresses || site.mac_addresses.length === 0) {
      return renderProblemPage(res, 'no_devices', refId, site.restaurant_name);
    }

    const t = deserializeTokens(tokens);
    const connections = site.mac_addresses.map((mac) => ({
      macAddress: mac.toLowerCase(),
      accessToken: t.accessToken,
      refreshToken: t.refreshToken,
      tokenExpiresAt: t.tokenExpiresAt,
      accountId: metadata.accountId,
      accountName: metadata.accountName,
      loginEmail: metadata.loginEmail,
      listId,
      listName,
      sourceTag: sourceTag || site.restaurant_name || null,
    }));
    await db.bulkUpsertKlaviyoConnections(connections);

    logEvent('klaviyo.oauth.location_selected', { ref_id: refId, site: site.restaurant_name, devices: connections.length });
    return renderSuccessPage(res, metadata.accountName, listName, redirectUrl, connections.length, site.restaurant_name);
  } catch (error) {
    logEvent('klaviyo.oauth.select_location.error', { ref_id: refId, message: error.message });
    res.status(500).send('Failed to complete setup. Please try again.');
  }
});

// =============================================================================
// Add location manually
// =============================================================================

router.post('/oauth/add-location', express.urlencoded({ extended: true }), async (req, res) => {
  const refId = newRefId();
  try {
    const { state, location_name, mac_address, hospitality_group } = req.body;
    if (!state || !location_name || !mac_address) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }
    if (!MAC_REGEX.test(mac_address)) {
      return res.status(400).send('Invalid MAC address format. Expected XX:XX:XX:XX:XX:XX');
    }

    const result = await db.query('SELECT * FROM pending_oauth WHERE state = $1 AND expires_at > NOW()', [state]);
    if (result.rows.length === 0) {
      return renderProblemPage(res, 'expired', refId);
    }

    const { tokens, metadata, redirectUrl, listId, listName } = JSON.parse(result.rows[0].redirect_url);
    await db.query('DELETE FROM pending_oauth WHERE state = $1', [state]);

    // Record the new site so future auto-mapping finds it.
    await db.vivaspotQuery(
      `INSERT INTO vivaspot_sites (restaurant_name, hospitality_group, merchant_emails, mac_addresses, created_at, updated_at)
       VALUES ($1, $2, $3, $4, NOW(), NOW())`,
      [
        location_name,
        hospitality_group || null,
        metadata.loginEmail ? [metadata.loginEmail.toLowerCase()] : [],
        [mac_address.toLowerCase()],
      ]
    );

    const t = deserializeTokens(tokens);
    await db.upsertKlaviyoConnection({
      macAddress: mac_address.toLowerCase(),
      accessToken: t.accessToken,
      refreshToken: t.refreshToken,
      tokenExpiresAt: t.tokenExpiresAt,
      accountId: metadata.accountId,
      accountName: metadata.accountName,
      loginEmail: metadata.loginEmail,
      listId,
      listName,
      sourceTag: location_name,
    });

    logEvent('klaviyo.oauth.location_added', { ref_id: refId, site: location_name });
    return renderSuccessPage(res, metadata.accountName, listName, redirectUrl, 1, location_name);
  } catch (error) {
    logEvent('klaviyo.oauth.add_location.error', { ref_id: refId, message: error.message });
    res.status(500).send('Failed to add location. Please try again.');
  }
});

// =============================================================================
// Status / disconnect
// =============================================================================

router.get('/oauth/status/:mac_address', async (req, res) => {
  try {
    const connection = await db.getKlaviyoConnectionByMac(req.params.mac_address);
    if (!connection) {
      return res.json({ connected: false });
    }
    const isValid = await klaviyo.pingAccount(connection.access_token);
    res.json({
      connected: true,
      valid: isValid,
      accountName: connection.account_name,
      listName: connection.list_name,
      sourceTag: connection.source_tag,
      tokenExpiresAt: connection.token_expires_at,
      connectedAt: connection.created_at,
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to check connection status' });
  }
});

router.delete('/oauth/disconnect/:mac_address', async (req, res) => {
  try {
    const connection = await db.getKlaviyoConnectionByMac(req.params.mac_address);
    if (!connection) {
      return res.status(404).json({ error: 'Connection not found' });
    }
    // Best-effort revoke before deleting locally.
    await klaviyo.revokeToken(connection.refresh_token, 'refresh_token');
    await db.deleteKlaviyoConnection(req.params.mac_address);
    res.json({ success: true, message: `Disconnected ${connection.account_name}` });
  } catch (error) {
    res.status(500).json({ error: 'Failed to disconnect' });
  }
});

// =============================================================================
// Shared completion: given a chosen list, auto-map MACs and finish.
// =============================================================================

async function completeWithList(res, { refId, macAddress, redirectUrl, tokens, metadata, list, sourceTag }) {
  // Try to auto-map by account name / login email.
  const { sites, matchMethod } = await db.findCandidateSites(metadata.accountName, metadata.loginEmail);

  // Exactly one site -> map all its MACs.
  if (sites.length === 1 && sites[0].mac_addresses && sites[0].mac_addresses.length > 0) {
    const site = sites[0];
    const connections = site.mac_addresses.map((mac) => ({
      macAddress: mac.toLowerCase(),
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      tokenExpiresAt: tokens.tokenExpiresAt,
      accountId: metadata.accountId,
      accountName: metadata.accountName,
      loginEmail: metadata.loginEmail,
      listId: list.id,
      listName: list.name,
      sourceTag: sourceTag || site.restaurant_name || null,
    }));
    await db.bulkUpsertKlaviyoConnections(connections);
    logEvent('klaviyo.oauth.automapped', { ref_id: refId, site: site.restaurant_name, method: matchMethod, devices: connections.length });
    return renderSuccessPage(res, metadata.accountName, list.name, redirectUrl, connections.length, site.restaurant_name);
  }

  // A MAC was provided in the install URL and no site matched -> single map.
  if (sites.length === 0 && macAddress && macAddress !== 'auto') {
    await db.upsertKlaviyoConnection({
      macAddress,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      tokenExpiresAt: tokens.tokenExpiresAt,
      accountId: metadata.accountId,
      accountName: metadata.accountName,
      loginEmail: metadata.loginEmail,
      listId: list.id,
      listName: list.name,
      sourceTag: null,
    });
    logEvent('klaviyo.oauth.single_mac', { ref_id: refId, mac: macAddress });
    return renderSuccessPage(res, metadata.accountName, list.name, redirectUrl, 1, null);
  }

  // Multiple sites OR no match and no MAC -> need user input. Stash creds.
  const followupState = crypto.randomBytes(32).toString('hex');
  await db.query(
    `INSERT INTO pending_oauth (state, mac_address, redirect_url, expires_at)
     VALUES ($1, $2, $3, NOW() + INTERVAL '10 minutes')`,
    [
      followupState,
      macAddress || 'auto',
      JSON.stringify({
        tokens: serializeTokens(tokens),
        metadata,
        redirectUrl,
        listId: list.id,
        listName: list.name,
        sourceTag,
      }),
    ]
  );

  if (sites.length > 1) {
    return renderLocationSelectionPage(res, sites, followupState, metadata.accountName, matchMethod);
  }
  // No site at all -> manual entry.
  return renderManualLocationPage(res, followupState, metadata.accountName);
}

// =============================================================================
// Token (de)serialization for pending_oauth JSON blobs
// =============================================================================

function serializeTokens(tokens) {
  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    tokenExpiresAt: tokens.tokenExpiresAt.toISOString(),
  };
}

function deserializeTokens(t) {
  return {
    accessToken: t.accessToken,
    refreshToken: t.refreshToken,
    tokenExpiresAt: new Date(t.tokenExpiresAt),
  };
}

// =============================================================================
// HTML render helpers
// =============================================================================

function renderSuccessPage(res, accountName, listName, redirectUrl, deviceCount = 1, locationName = null) {
  const redirectScript = redirectUrl
    ? `<script>setTimeout(() => window.location.href = '${redirectUrl}', 3000);</script>`
    : '';
  const locationInfo = locationName ? `<p style="margin: 10px 0 0 0;"><strong>Location:</strong> ${locationName}</p>` : '';

  res.send(`
    <html>
      <head><title>Connected to Klaviyo</title>${redirectScript}</head>
      <body style="font-family: Arial, sans-serif; padding: 40px; text-align: center; background: #f5f5f5;">
        <div style="max-width: 500px; margin: 0 auto; background: white; padding: 40px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
          <div style="font-size: 60px; margin-bottom: 20px;">&#10003;</div>
          <h1 style="color: #2e7d32;">Successfully Connected!</h1>
          <p style="color: #666; font-size: 16px;">Your WiFi location is now connected to Klaviyo.</p>
          <div style="background: #e8f5e9; padding: 20px; border-radius: 4px; margin: 20px 0;">
            <p style="margin: 0;"><strong>Account:</strong> ${accountName}</p>
            ${locationInfo}
            <p style="margin: 10px 0 0 0;"><strong>List:</strong> ${listName}</p>
            <p style="margin: 10px 0 0 0;"><strong>Devices Mapped:</strong> ${deviceCount}</p>
          </div>
          <p style="color: #999; font-size: 14px;">WiFi guest contacts will now sync automatically to your Klaviyo list.</p>
          ${redirectUrl ? '<p style="color: #999; font-size: 12px;">Redirecting...</p>' : '<a href="https://www.klaviyo.com/" style="display: inline-block; margin-top: 20px; padding: 12px 30px; background: #2e7d32; color: white; text-decoration: none; border-radius: 4px; font-size: 16px;">Return to Klaviyo</a>'}
        </div>
      </body>
    </html>
  `);
}

function renderAlreadyConnectedPage(res, refId) {
  res.status(200).send(`
    <html><head><title>Already Connected - VivaSpot</title></head>
      <body style="font-family: Arial, sans-serif; padding: 40px; text-align: center; background: #f5f5f5;">
        <div style="max-width: 500px; margin: 0 auto; background: white; padding: 40px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
          <div style="font-size: 60px; margin-bottom: 20px;">&#10003;</div>
          <h1 style="color: #2e7d32;">You're Already Connected</h1>
          <p style="color: #666; font-size: 16px;">This Klaviyo connection has already been completed. WiFi guest contacts will sync automatically.</p>
          <a href="https://www.klaviyo.com/" style="display: inline-block; margin-top: 20px; padding: 12px 30px; background: #2e7d32; color: white; text-decoration: none; border-radius: 4px; font-size: 16px;">Return to Klaviyo</a>
          <p style="color:#999;font-size:12px;margin-top:30px;">Ref: ${refId}</p>
        </div>
      </body></html>
  `);
}

function renderProblemPage(res, status, refId, detail = null) {
  const variants = {
    expired: { code: 400, title: 'Authorization Link Expired', body: 'This authorization link has expired (valid for 10 minutes). Please start the connection process again.' },
    already_used: { code: 400, title: 'Link Already Used', body: 'This authorization link has already been used. Please start a new connection.' },
    not_found: { code: 400, title: 'Authorization Link Not Found', body: 'We couldn\'t find this authorization request. Please start the connection process again.' },
    no_lists: { code: 400, title: 'No Lists Found', body: 'Your Klaviyo account has no lists yet. Please create a list in Klaviyo first, then try again.' },
    no_devices: { code: 400, title: 'No Devices Configured', body: `The location "${detail || ''}" has no WiFi devices on file yet. Please add a device MAC address and try again.` },
    klaviyo_error: { code: 400, title: 'Authorization Failed', body: `Klaviyo returned an error: ${detail || 'unknown'}. Please try again or contact support.` },
    exception: { code: 500, title: 'Connection Failed', body: `An error occurred while connecting to Klaviyo: ${detail || 'unexpected error'}. Please try again or contact support.` },
  };
  const v = variants[status] || variants.not_found;
  res.status(v.code).send(`
    <html><head><title>${v.title} - VivaSpot</title></head>
      <body style="font-family: Arial, sans-serif; padding: 40px; text-align: center; background: #f5f5f5;">
        <div style="max-width: 500px; margin: 0 auto; background: white; padding: 40px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
          <h1 style="color: #c62828;">${v.title}</h1>
          <p style="color: #666; font-size: 16px; margin: 20px 0;">${v.body}</p>
          <a href="/klaviyo/oauth/authorize" style="display: inline-block; margin-top: 20px; padding: 12px 30px; background: #007bff; color: white; text-decoration: none; border-radius: 4px; font-size: 16px;">Start Over</a>
          <p style="color: #999; font-size: 13px; margin-top: 30px;">Need help? Contact <a href="mailto:support@vivaspot.com">support@vivaspot.com</a> and include the reference code below.</p>
          <p style="color:#999;font-size:12px;margin-top:10px;">Ref: ${refId}</p>
        </div>
      </body></html>
  `);
}

function renderListSelectionPage(res, lists, state, accountName) {
  const options = lists
    .map(
      (l) => `
    <label style="display: block; padding: 15px; border: 1px solid #ddd; border-radius: 4px; margin-bottom: 10px; cursor: pointer;">
      <input type="radio" name="list_id" value="${l.id}" data-name="${l.name}" required style="margin-right: 10px;">
      <strong>${l.name}</strong>
    </label>`
    )
    .join('');

  res.send(`
    <html><head><title>Select List - VivaSpot</title></head>
      <body style="font-family: Arial, sans-serif; padding: 40px; background: #f5f5f5;">
        <div style="max-width: 500px; margin: 0 auto; background: white; padding: 40px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
          <h1 style="margin-top: 0;">Select a List</h1>
          <p style="color: #666;">Connected to <strong>${accountName}</strong>. Choose which list should receive WiFi guest contacts:</p>
          <form method="POST" action="/klaviyo/oauth/select-list">
            <input type="hidden" name="state" value="${state}">
            <input type="hidden" name="list_name" id="list_name" value="">
            <div style="margin: 20px 0;">${options}</div>
            <div style="margin: 20px 0;">
              <label style="display:block;margin-bottom:8px;font-weight:bold;">Source Tag (optional)</label>
              <input type="text" name="source_tag" placeholder="e.g., WiFi-MainStreet" style="width:100%;padding:10px;border:1px solid #ddd;border-radius:4px;box-sizing:border-box;">
            </div>
            <button type="submit" style="width:100%;padding:15px;background:#007bff;color:white;border:none;border-radius:4px;font-size:16px;cursor:pointer;">Complete Setup</button>
          </form>
        </div>
        <script>
          document.querySelectorAll('input[name="list_id"]').forEach((radio) => {
            radio.addEventListener('change', (e) => { document.getElementById('list_name').value = e.target.dataset.name; });
          });
        </script>
      </body></html>
  `);
}

function renderLocationSelectionPage(res, sites, state, accountName, matchMethod) {
  const matchDescription = matchMethod === 'email'
    ? 'We found multiple locations associated with your email address.'
    : 'We found multiple locations matching your account name.';

  const options = sites
    .map((site) => {
      const details = [];
      if (site.address) details.push(site.address);
      if (site.city) details.push(site.city);
      if (site.state) details.push(site.state);
      if (site.hospitality_group) details.push(`Group: ${site.hospitality_group}`);
      const detailsStr = details.length
        ? `<span style="color:#666;font-size:13px;display:block;margin-top:4px;">${details.join(' | ')}</span>`
        : '';
      const count = site.mac_addresses ? site.mac_addresses.length : 0;
      const deviceInfo = count > 0
        ? `<span style="color:#28a745;font-size:12px;">${count} device(s) configured</span>`
        : `<span style="color:#dc3545;font-size:12px;">No devices configured</span>`;
      return `
        <label style="display:block;padding:15px;border:1px solid #ddd;border-radius:4px;margin-bottom:10px;cursor:pointer;text-align:left;">
          <input type="radio" name="site_id" value="${site.id}" required style="margin-right:10px;">
          <strong>${site.restaurant_name}</strong>
          ${detailsStr}
          <span style="display:block;margin-top:6px;">${deviceInfo}</span>
        </label>`;
    })
    .join('');

  res.send(`
    <html><head><title>Select Location - VivaSpot</title></head>
      <body style="font-family: Arial, sans-serif; padding: 40px; background: #f5f5f5;">
        <div style="max-width: 550px; margin: 0 auto; background: white; padding: 40px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
          <h1 style="margin-top: 0;">Select Your Location</h1>
          <p style="color: #666;">Connected to Klaviyo account <strong>${accountName}</strong>.</p>
          <p style="color: #666;">${matchDescription} Please select the location you want to connect:</p>
          <form method="POST" action="/klaviyo/oauth/select-location">
            <input type="hidden" name="state" value="${state}">
            <div style="margin: 20px 0; max-height: 400px; overflow-y: auto;">${options}</div>
            <button type="submit" style="width:100%;padding:15px;background:#007bff;color:white;border:none;border-radius:4px;font-size:16px;cursor:pointer;">Connect This Location</button>
          </form>
          <div style="margin-top:20px;text-align:center;">
            <a href="#" onclick="document.getElementById('manual-entry').style.display='block'; this.style.display='none'; return false;" style="color:#666;font-size:13px;">My location isn't listed</a>
          </div>
          <div id="manual-entry" style="display:none;margin-top:20px;border-top:1px solid #ddd;padding-top:20px;">
            <h3 style="margin-top:0;">Add Your Location</h3>
            <form method="POST" action="/klaviyo/oauth/add-location">
              <input type="hidden" name="state" value="${state}">
              <input type="hidden" name="hospitality_group" value="${sites[0]?.hospitality_group || ''}">
              <div style="margin-bottom:15px;">
                <label style="display:block;margin-bottom:5px;font-weight:bold;">Location Name</label>
                <input type="text" name="location_name" required placeholder="e.g., My Restaurant - Downtown" style="width:100%;padding:10px;border:1px solid #ddd;border-radius:4px;box-sizing:border-box;">
              </div>
              <div style="margin-bottom:15px;">
                <label style="display:block;margin-bottom:5px;font-weight:bold;">Device MAC Address</label>
                <input type="text" name="mac_address" required placeholder="XX:XX:XX:XX:XX:XX" pattern="^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$" style="width:100%;padding:10px;border:1px solid #ddd;border-radius:4px;box-sizing:border-box;">
              </div>
              <button type="submit" style="width:100%;padding:15px;background:#28a745;color:white;border:none;border-radius:4px;font-size:16px;cursor:pointer;">Add &amp; Connect Location</button>
            </form>
          </div>
        </div>
      </body></html>
  `);
}

function renderManualLocationPage(res, state, accountName) {
  res.send(`
    <html><head><title>Add Your Location - VivaSpot</title></head>
      <body style="font-family: Arial, sans-serif; padding: 40px; background: #f5f5f5;">
        <div style="max-width: 500px; margin: 0 auto; background: white; padding: 40px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
          <h1 style="margin-top: 0;">Add Your Location</h1>
          <p style="color: #666;">Connected to Klaviyo account <strong>${accountName}</strong>. We couldn't match your account to an existing VivaSpot location, so please add it:</p>
          <form method="POST" action="/klaviyo/oauth/add-location">
            <input type="hidden" name="state" value="${state}">
            <div style="margin-bottom:15px;">
              <label style="display:block;margin-bottom:5px;font-weight:bold;">Location Name</label>
              <input type="text" name="location_name" required placeholder="e.g., Hill Country BBQ" style="width:100%;padding:10px;border:1px solid #ddd;border-radius:4px;box-sizing:border-box;">
            </div>
            <div style="margin-bottom:15px;">
              <label style="display:block;margin-bottom:5px;font-weight:bold;">Device MAC Address</label>
              <input type="text" name="mac_address" required placeholder="XX:XX:XX:XX:XX:XX" pattern="^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$" style="width:100%;padding:10px;border:1px solid #ddd;border-radius:4px;box-sizing:border-box;">
              <p style="color:#999;font-size:11px;margin-top:4px;">Found on the bottom of your VivaSpot device</p>
            </div>
            <button type="submit" style="width:100%;padding:15px;background:#28a745;color:white;border:none;border-radius:4px;font-size:16px;cursor:pointer;">Add &amp; Connect Location</button>
          </form>
        </div>
      </body></html>
  `);
}

module.exports = router;
