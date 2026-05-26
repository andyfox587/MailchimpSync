/**
 * OAuth Routes
 * 
 * Handles the Mailchimp OAuth 2.0 authorization flow.
 * 
 * Flow:
 * 1. GET /oauth/authorize?mac_address=XX:XX:XX:XX:XX:XX
 *    - Stores MAC address with a state token
 *    - Redirects to Mailchimp login
 * 
 * 2. GET /oauth/callback?code=xxx&state=xxx
 *    - Exchanges code for access token
 *    - Fetches account metadata (data center)
 *    - Redirects to audience selection or saves connection
 */

const express = require('express');
const crypto = require('crypto');
const router = express.Router();

const db = require('../db');
const mailchimp = require('../services/mailchimp');

// =============================================================================
// Diagnostic helpers
// =============================================================================

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
// unfurlers, browser prefetchers). If one of these hits /oauth/callback it
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

/**
 * Start OAuth flow
 * GET /oauth/authorize?mac_address=XX:XX:XX:XX:XX:XX&redirect_url=https://...
 */
router.get('/authorize', async (req, res) => {
  const refId = newRefId();
  try {
    const { mac_address, redirect_url } = req.query;

    // Normalize whatever the caller passed (colons, dashes, dots, or no
    // separator) into the canonical XX:XX:XX:XX:XX:XX lowercase form. The
    // manual setup form already accepts all of these; keep /oauth/authorize
    // consistent.
    let macAddr = 'auto';
    if (mac_address) {
      const clean = String(mac_address).replace(/[:\-.\s]/g, '').toLowerCase();
      if (clean.length === 12 && /^[0-9a-f]+$/.test(clean)) {
        macAddr = clean.match(/.{2}/g).join(':');
      } else {
        return res.status(400).json({
          error: 'Invalid MAC address. Expected 12 hex characters (e.g. XX:XX:XX:XX:XX:XX, XX-XX-XX-XX-XX-XX, or XXXXXXXXXXXX). Omit the parameter entirely to start without a MAC.',
          received: mac_address,
          ref_id: refId,
        });
      }
    }


    // Generate random state token for CSRF protection
    const state = crypto.randomBytes(32).toString('hex');

    // Store the pending OAuth with MAC address
    await db.createPendingOAuth(state, macAddr, redirect_url);

    // Generate authorization URL and redirect
    const authUrl = mailchimp.getAuthorizationUrl(state);

    logEvent('oauth.start', {
      ref_id: refId,
      mac: macAddr,
      state_hash: hashState(state),
      has_redirect_url: !!redirect_url,
      ...requestFingerprint(req),
    });
    res.redirect(authUrl);

  } catch (error) {
    logEvent('oauth.start.error', {
      ref_id: refId,
      message: error.message,
      ...requestFingerprint(req),
    });
    res.status(500).json({ error: 'Failed to start OAuth flow' });
  }
});

/**
 * OAuth callback from Mailchimp
 * GET /oauth/callback?code=xxx&state=xxx
 */
router.get('/callback', async (req, res) => {
  const refId = newRefId();

  // Belt-and-braces: link prefetchers / safe-link scanners get an inert page
  // so they can't consume the single-use state ahead of the real user.
  if (isLinkCheckerUA(req.get('user-agent'))) {
    logEvent('oauth.callback.bot_skipped', {
      ref_id: refId,
      ...requestFingerprint(req),
    });
    return res.status(200).send('<!doctype html><title>VivaSpot OAuth</title>');
  }

  try {
    const { code, state, error: oauthError } = req.query;

    logEvent('oauth.callback', {
      ref_id: refId,
      state_hash: hashState(state),
      has_code: !!code,
      oauth_error: oauthError || null,
      ...requestFingerprint(req),
    });

    // Check for OAuth errors
    if (oauthError) {
      logEvent('oauth.callback.mailchimp_error', { ref_id: refId, oauth_error: oauthError });
      return res.status(400).send(`
        <html>
          <body style="font-family: Arial, sans-serif; padding: 40px; text-align: center;">
            <h1>Authorization Failed</h1>
            <p>Mailchimp returned an error: ${oauthError}</p>
            <p>Please try again or contact support.</p>
            <p style="color:#999;font-size:12px;margin-top:30px;">Ref: ${refId}</p>
          </body>
        </html>
      `);
    }

    if (!code || !state) {
      logEvent('oauth.callback.bad_params', {
        ref_id: refId, has_code: !!code, has_state: !!state,
      });
      return res.status(400).json({
        error: 'Missing required parameters: code and state',
        ref_id: refId,
      });
    }

    // Atomically consume the pending OAuth state. The result tells us *why*
    // a state is unavailable so we can show the right page (and so the next
    // incident is diagnosable from logs).
    const consumeResult = await db.consumePendingOAuth(state);
    logEvent('oauth.consume', {
      ref_id: refId,
      state_hash: hashState(state),
      status: consumeResult.status,
      age_seconds: consumeResult.ageSeconds ?? null,
    });

    if (consumeResult.status !== 'consumed') {
      // For 'recently_used' (prefetch / double-submit), render the success
      // page if we can find a connection that was already created for this
      // state's MAC. This is the idempotent path.
      if (consumeResult.status === 'recently_used' && consumeResult.row) {
        const macFromState = consumeResult.row.mac_address;
        if (macFromState && macFromState !== 'auto') {
          const existing = await db.getConnectionByMac(macFromState);
          if (existing) {
            logEvent('oauth.callback.idempotent_success', {
              ref_id: refId,
              mac: macFromState,
            });
            // Best-effort recover redirect_url; the redirect_url column may
            // hold either a plain URL or the JSON blob the multi-audience
            // flow stuffs in there.
            let originalRedirect = null;
            try {
              const parsed = JSON.parse(consumeResult.row.redirect_url || 'null');
              originalRedirect = (parsed && parsed.redirect_url) || null;
            } catch {
              originalRedirect = consumeResult.row.redirect_url || null;
            }
            return renderSuccessPage(
              res,
              existing.account_name,
              existing.audience_name,
              originalRedirect,
              1,
              existing.source_tag || null
            );
          }
        }
        // recently_used but we can't reconstruct — show a friendly "already
        // connected" page instead of the scary expired one.
        return renderAlreadyConnectedPage(res, refId);
      }

      return renderAuthorizationProblemPage(res, consumeResult.status, refId);
    }

    const pendingOAuth = consumeResult.row;
    const { mac_address, redirect_url } = pendingOAuth;
    
    // Exchange code for access token
    const { accessToken } = await mailchimp.exchangeCodeForToken(code);
    
    // Get account metadata (data center, account name)
    const metadata = await mailchimp.getAccountMetadata(accessToken);
    
    console.log(`OAuth completed for MAC: ${mac_address}, Account: ${metadata.accountName}`);
    
    // Get available audiences for selection
    const audiences = await mailchimp.getAudiences(accessToken, metadata.dataCenter);
    
    if (audiences.length === 0) {
      return res.status(400).send(`
        <html>
          <body style="font-family: Arial, sans-serif; padding: 40px; text-align: center;">
            <h1>No Audiences Found</h1>
            <p>Your Mailchimp account doesn't have any audiences (lists) yet.</p>
            <p>Please create an audience in Mailchimp first, then try again.</p>
          </body>
        </html>
      `);
    }
    
    // If only one audience, use it automatically but still check for site matching
    if (audiences.length === 1) {
      const selectedAudience = audiences[0];

      // Try auto-mapping: find all candidate sites by email and name
      const { sites, matchMethod } = await db.findCandidateSites(
        metadata.accountName,
        metadata.loginEmail
      );

      if (sites.length === 0) {
        // No matches found - use the MAC address from URL if provided
        console.log(`No auto-mapping match for "${metadata.accountName}" with single audience`);

        if (mac_address && mac_address !== 'auto') {
          // Use provided MAC address
          await db.upsertConnection({
            macAddress: mac_address,
            accessToken: accessToken,
            dataCenter: metadata.dataCenter,
            accountId: metadata.accountId,
            accountName: metadata.accountName,
            audienceId: selectedAudience.id,
            audienceName: selectedAudience.name,
            sourceTag: null
          });

          return renderSuccessPage(res, metadata.accountName, selectedAudience.name, redirect_url);
        } else {
          // No MAC and no site match - redirect to manual setup
          const setupUrl = `/setup/${encodeURIComponent(metadata.accountId)}?` +
            `account_name=${encodeURIComponent(metadata.accountName)}` +
            `&audience_id=${encodeURIComponent(selectedAudience.id)}` +
            `&audience_name=${encodeURIComponent(selectedAudience.name)}` +
            `&access_token=${encodeURIComponent(accessToken)}` +
            `&data_center=${encodeURIComponent(metadata.dataCenter)}`;

          return res.redirect(setupUrl);
        }

      } else if (sites.length === 1) {
        // Exactly one match - auto-map all MACs from that site
        const site = sites[0];

        if (site.mac_addresses && site.mac_addresses.length > 0) {
          console.log(`Auto-mapping ${site.mac_addresses.length} MAC(s) for "${site.restaurant_name}" (matched by ${matchMethod}, single audience)`);

          const connections = site.mac_addresses.map(mac => ({
            macAddress: mac.toLowerCase(),
            accessToken: accessToken,
            dataCenter: metadata.dataCenter,
            accountId: metadata.accountId,
            accountName: metadata.accountName,
            audienceId: selectedAudience.id,
            audienceName: selectedAudience.name,
            sourceTag: site.restaurant_name || null
          }));

          await db.bulkUpsertConnections(connections);

          return renderSuccessPage(res, metadata.accountName, selectedAudience.name, redirect_url, site.mac_addresses.length, site.restaurant_name);
        } else {
          // Site found but no MAC addresses configured
          console.log(`Site "${site.restaurant_name}" found but has no MAC addresses (single audience)`);

          const setupUrl = `/setup/${encodeURIComponent(metadata.accountId)}?` +
            `account_name=${encodeURIComponent(metadata.accountName)}` +
            `&audience_id=${encodeURIComponent(selectedAudience.id)}` +
            `&audience_name=${encodeURIComponent(selectedAudience.name)}` +
            `&access_token=${encodeURIComponent(accessToken)}` +
            `&data_center=${encodeURIComponent(metadata.dataCenter)}` +
            `&site_name=${encodeURIComponent(site.restaurant_name)}`;

          return res.redirect(setupUrl);
        }

      } else {
        // Multiple matches found - need user to select location
        console.log(`Multiple sites (${sites.length}) found for "${metadata.accountName}" - showing location selection (single audience)`);

        // Create state for location selection step
        const locationState = crypto.randomBytes(32).toString('hex');

        // Store credentials and selected audience for the location selection step
        await db.query(`
          INSERT INTO pending_oauth (state, mac_address, redirect_url, expires_at)
          VALUES ($1, $2, $3, NOW() + INTERVAL '10 minutes')
        `, [locationState, mac_address || 'auto', JSON.stringify({
          accessToken,
          metadata,
          redirect_url,
          audienceId: selectedAudience.id,
          audienceName: selectedAudience.name,
          sourceTag: null
        })]);

        // Render location selection page
        return renderLocationSelectionPage(res, sites, locationState, metadata.accountName, matchMethod);
      }
    }
    
    // Multiple audiences - show selection page
    // Store credentials temporarily in session/state for the selection step
    const selectionState = crypto.randomBytes(32).toString('hex');
    
    // Store in pending_oauth table with audience selection flag
    await db.query(`
      INSERT INTO pending_oauth (state, mac_address, redirect_url, expires_at)
      VALUES ($1, $2, $3, NOW() + INTERVAL '10 minutes')
    `, [selectionState, mac_address, redirect_url]);
    
    // Also store the token temporarily (in a real app, use Redis or sessions)
    await db.query(`
      UPDATE pending_oauth 
      SET redirect_url = $1 
      WHERE state = $2
    `, [JSON.stringify({ accessToken, metadata, redirect_url }), selectionState]);
    
    // Render audience selection page
    renderAudienceSelectionPage(res, audiences, selectionState, metadata.accountName);
    
  } catch (error) {
    logEvent('oauth.callback.error', {
      ref_id: refId,
      message: error.message,
      stack: error.stack,
    });
    res.status(500).send(`
      <html>
        <body style="font-family: Arial, sans-serif; padding: 40px; text-align: center;">
          <h1>Connection Failed</h1>
          <p>An error occurred while connecting to Mailchimp: ${error.message}</p>
          <p>Please try again or contact support.</p>
          <p style="color:#999;font-size:12px;margin-top:30px;">Ref: ${refId}</p>
        </body>
      </html>
    `);
  }
});

/**
 * Complete audience selection
 * POST /oauth/select-audience
 */
router.post('/select-audience', express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const { state, audience_id, audience_name, source_tag } = req.body;

    if (!state || !audience_id) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }

    // Get pending OAuth data
    const result = await db.query(
      'SELECT * FROM pending_oauth WHERE state = $1 AND expires_at > NOW()',
      [state]
    );

    if (result.rows.length === 0) {
      return res.status(400).send('Session expired. Please start again.');
    }

    const pending = result.rows[0];
    const { accessToken, metadata, redirect_url } = JSON.parse(pending.redirect_url);

    // Try auto-mapping: find all candidate sites by email and name
    const { sites, matchMethod } = await db.findCandidateSites(
      metadata.accountName,
      metadata.loginEmail
    );

    if (sites.length === 0) {
      // No matches found - redirect to manual setup
      console.log(`No auto-mapping match for "${metadata.accountName}" - redirecting to manual setup`);

      // Clean up pending OAuth
      await db.query('DELETE FROM pending_oauth WHERE state = $1', [state]);

      // Redirect to manual setup with credentials in query params
      const setupUrl = `/setup/${encodeURIComponent(metadata.accountId)}?` +
        `account_name=${encodeURIComponent(metadata.accountName)}` +
        `&audience_id=${encodeURIComponent(audience_id)}` +
        `&audience_name=${encodeURIComponent(audience_name)}` +
        `&access_token=${encodeURIComponent(accessToken)}` +
        `&data_center=${encodeURIComponent(metadata.dataCenter)}`;

      res.redirect(setupUrl);

    } else if (sites.length === 1) {
      // Exactly one match - auto-map
      const site = sites[0];

      if (site.mac_addresses && site.mac_addresses.length > 0) {
        console.log(`Auto-mapping ${site.mac_addresses.length} MAC(s) for "${site.restaurant_name}" (matched by ${matchMethod})`);

        const connections = site.mac_addresses.map(mac => ({
          macAddress: mac.toLowerCase(),
          accessToken: accessToken,
          dataCenter: metadata.dataCenter,
          accountId: metadata.accountId,
          accountName: metadata.accountName,
          audienceId: audience_id,
          audienceName: audience_name,
          sourceTag: source_tag || site.restaurant_name || null
        }));

        await db.bulkUpsertConnections(connections);

        // Clean up pending OAuth
        await db.query('DELETE FROM pending_oauth WHERE state = $1', [state]);

        // Show success with device count
        renderSuccessPage(res, metadata.accountName, audience_name, redirect_url, site.mac_addresses.length);
      } else {
        // Site found but no MAC addresses configured
        console.log(`Site "${site.restaurant_name}" found but has no MAC addresses`);

        await db.query('DELETE FROM pending_oauth WHERE state = $1', [state]);

        const setupUrl = `/setup/${encodeURIComponent(metadata.accountId)}?` +
          `account_name=${encodeURIComponent(metadata.accountName)}` +
          `&audience_id=${encodeURIComponent(audience_id)}` +
          `&audience_name=${encodeURIComponent(audience_name)}` +
          `&access_token=${encodeURIComponent(accessToken)}` +
          `&data_center=${encodeURIComponent(metadata.dataCenter)}`;

        res.redirect(setupUrl);
      }

    } else {
      // Multiple matches found - need user to select location
      console.log(`Multiple sites (${sites.length}) found for "${metadata.accountName}" - showing location selection`);

      // Create new state for location selection step
      const locationState = crypto.randomBytes(32).toString('hex');

      // Store credentials and selected audience for the location selection step
      await db.query(`
        INSERT INTO pending_oauth (state, mac_address, redirect_url, expires_at)
        VALUES ($1, $2, $3, NOW() + INTERVAL '10 minutes')
      `, [locationState, pending.mac_address, JSON.stringify({
        accessToken,
        metadata,
        redirect_url,
        audienceId: audience_id,
        audienceName: audience_name,
        sourceTag: source_tag
      })]);

      // Clean up old state
      await db.query('DELETE FROM pending_oauth WHERE state = $1', [state]);

      // Render location selection page
      renderLocationSelectionPage(res, sites, locationState, metadata.accountName, matchMethod);
    }

  } catch (error) {
    console.error('Audience selection error:', error);
    res.status(500).send('Failed to complete setup. Please try again.');
  }
});

/**
 * Complete location selection (when multiple sites match)
 * POST /oauth/select-location
 * Supports selecting multiple locations via checkboxes
 */
router.post('/select-location', express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const { state } = req.body;
    // site_ids can be a single value or an array when multiple checkboxes are selected
    let siteIds = req.body.site_ids;

    if (!state) {
      return res.status(400).send('Session expired. Please start again.');
    }

    if (!siteIds) {
      return res.status(400).send('Please select at least one location.');
    }

    // Normalize to array
    if (!Array.isArray(siteIds)) {
      siteIds = [siteIds];
    }

    // Get pending OAuth data
    const result = await db.query(
      'SELECT * FROM pending_oauth WHERE state = $1 AND expires_at > NOW()',
      [state]
    );

    if (result.rows.length === 0) {
      return res.status(400).send('Session expired. Please start again.');
    }

    const pending = result.rows[0];
    const {
      accessToken,
      metadata,
      redirect_url,
      audienceId,
      audienceName,
      sourceTag
    } = JSON.parse(pending.redirect_url);

    // Fetch all selected sites from VivaSpot database
    const placeholders = siteIds.map((_, i) => `$${i + 1}`).join(', ');
    const siteResult = await db.vivaspotQuery(
      `SELECT * FROM vivaspot_sites WHERE id IN (${placeholders})`,
      siteIds
    );

    if (siteResult.rows.length === 0) {
      return res.status(400).send('Selected location(s) not found. Please try again.');
    }

    const sites = siteResult.rows;
    const sitesWithoutMacs = sites.filter(s => !s.mac_addresses || s.mac_addresses.length === 0);

    // If all selected sites have no MAC addresses, redirect to manual setup
    if (sitesWithoutMacs.length === sites.length) {
      console.log(`All selected sites have no MAC addresses`);

      await db.query('DELETE FROM pending_oauth WHERE state = $1', [state]);

      const siteNames = sites.map(s => s.restaurant_name).join(', ');
      const setupUrl = `/setup/${encodeURIComponent(metadata.accountId)}?` +
        `account_name=${encodeURIComponent(metadata.accountName)}` +
        `&audience_id=${encodeURIComponent(audienceId)}` +
        `&audience_name=${encodeURIComponent(audienceName)}` +
        `&access_token=${encodeURIComponent(accessToken)}` +
        `&data_center=${encodeURIComponent(metadata.dataCenter)}` +
        `&site_name=${encodeURIComponent(siteNames)}`;

      res.redirect(setupUrl);
      return;
    }

    // Build connections for all selected sites that have MAC addresses
    const allConnections = [];
    const connectedSiteNames = [];
    let totalDevices = 0;

    for (const site of sites) {
      if (site.mac_addresses && site.mac_addresses.length > 0) {
        console.log(`Mapping ${site.mac_addresses.length} MAC(s) for selected site "${site.restaurant_name}"`);

        const siteConnections = site.mac_addresses.map(mac => ({
          macAddress: mac.toLowerCase(),
          accessToken: accessToken,
          dataCenter: metadata.dataCenter,
          accountId: metadata.accountId,
          accountName: metadata.accountName,
          audienceId: audienceId,
          audienceName: audienceName,
          sourceTag: site.restaurant_name || null
        }));

        allConnections.push(...siteConnections);
        connectedSiteNames.push(site.restaurant_name);
        totalDevices += site.mac_addresses.length;
      }
    }

    await db.bulkUpsertConnections(allConnections);

    // Clean up pending OAuth
    await db.query('DELETE FROM pending_oauth WHERE state = $1', [state]);

    // Show success with all connected locations
    const locationSummary = connectedSiteNames.join(', ');
    renderSuccessPage(res, metadata.accountName, audienceName, redirect_url, totalDevices, locationSummary);

  } catch (error) {
    console.error('Location selection error:', error);
    res.status(500).send('Failed to complete setup. Please try again.');
  }
});

/**
 * Add a new location manually during OAuth flow
 * POST /oauth/add-location
 */
router.post('/add-location', express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const { state, location_name, mac_address, hospitality_group } = req.body;

    if (!state || !location_name || !mac_address) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }

    // Validate MAC format
    const macRegex = /^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/;
    if (!macRegex.test(mac_address)) {
      return res.status(400).send('Invalid MAC address format. Expected XX:XX:XX:XX:XX:XX');
    }

    // Get pending OAuth data
    const result = await db.query(
      'SELECT * FROM pending_oauth WHERE state = $1 AND expires_at > NOW()',
      [state]
    );

    if (result.rows.length === 0) {
      return res.status(400).send('Session expired. Please start again.');
    }

    const pending = result.rows[0];
    const {
      accessToken,
      metadata,
      redirect_url,
      audienceId,
      audienceName
    } = JSON.parse(pending.redirect_url);

    // Insert new site into vivaspot_sites
    await db.vivaspotQuery(`
      INSERT INTO vivaspot_sites (restaurant_name, hospitality_group, merchant_emails, mac_addresses, created_at, updated_at)
      VALUES ($1, $2, $3, $4, NOW(), NOW())
    `, [
      location_name,
      hospitality_group || null,
      metadata.loginEmail ? [metadata.loginEmail.toLowerCase()] : [],
      [mac_address.toLowerCase()]
    ]);

    console.log(`Manually added site "${location_name}" with MAC ${mac_address}`);

    // Create mailchimp connection for this MAC
    await db.upsertConnection({
      macAddress: mac_address.toLowerCase(),
      accessToken,
      dataCenter: metadata.dataCenter,
      accountId: metadata.accountId,
      accountName: metadata.accountName,
      audienceId,
      audienceName,
      sourceTag: location_name
    });

    // Clean up pending OAuth
    await db.query('DELETE FROM pending_oauth WHERE state = $1', [state]);

    // Show success
    renderSuccessPage(res, metadata.accountName, audienceName, redirect_url, 1, location_name);

  } catch (error) {
    console.error('Add location error:', error);
    res.status(500).send('Failed to add location. Please try again.');
  }
});

/**
 * Get OAuth status for a MAC address
 * GET /oauth/status/:mac_address
 */
router.get('/status/:mac_address', async (req, res) => {
  try {
    const connection = await db.getConnectionByMac(req.params.mac_address);
    
    if (!connection) {
      return res.json({ connected: false });
    }
    
    // Test if the connection is still valid
    const isValid = await mailchimp.pingAccount(
      connection.access_token, 
      connection.data_center
    );
    
    res.json({
      connected: true,
      valid: isValid,
      accountName: connection.account_name,
      audienceName: connection.audience_name,
      sourceTag: connection.source_tag,
      connectedAt: connection.created_at
    });
    
  } catch (error) {
    console.error('Status check error:', error);
    res.status(500).json({ error: 'Failed to check connection status' });
  }
});

/**
 * Disconnect (revoke) a connection
 * DELETE /oauth/disconnect/:mac_address
 */
router.delete('/disconnect/:mac_address', async (req, res) => {
  try {
    const deleted = await db.deleteConnection(req.params.mac_address);
    
    if (!deleted) {
      return res.status(404).json({ error: 'Connection not found' });
    }
    
    res.json({ 
      success: true, 
      message: `Disconnected ${deleted.account_name}` 
    });
    
  } catch (error) {
    console.error('Disconnect error:', error);
    res.status(500).json({ error: 'Failed to disconnect' });
  }
});

// =============================================================================
// Helper Functions
// =============================================================================

function renderSuccessPage(res, accountName, audienceName, redirectUrl, deviceCount = 1, locationName = null) {
  const redirectScript = redirectUrl
    ? `<script>setTimeout(() => window.location.href = '${redirectUrl}', 3000);</script>`
    : '';

  const locationInfo = locationName
    ? `<p style="margin: 10px 0 0 0;"><strong>Location:</strong> ${locationName}</p>`
    : '';

  res.send(`
    <html>
      <head>
        <title>Connected to Mailchimp</title>
        ${redirectScript}
      </head>
      <body style="font-family: Arial, sans-serif; padding: 40px; text-align: center; background: #f5f5f5;">
        <div style="max-width: 500px; margin: 0 auto; background: white; padding: 40px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
          <div style="font-size: 60px; margin-bottom: 20px;">&#10003;</div>
          <h1 style="color: #2e7d32;">Successfully Connected!</h1>
          <p style="color: #666; font-size: 16px;">
            Your WiFi location is now connected to Mailchimp.
          </p>
          <div style="background: #e8f5e9; padding: 20px; border-radius: 4px; margin: 20px 0;">
            <p style="margin: 0;"><strong>Account:</strong> ${accountName}</p>
            ${locationInfo}
            <p style="margin: 10px 0 0 0;"><strong>Audience:</strong> ${audienceName}</p>
            <p style="margin: 10px 0 0 0;"><strong>Devices Mapped:</strong> ${deviceCount}</p>
          </div>
          <p style="color: #999; font-size: 14px;">
            WiFi guest contacts will now sync automatically to your Mailchimp audience.
          </p>
          ${redirectUrl
            ? '<p style="color: #999; font-size: 12px;">Redirecting...</p>'
            : '<a href="https://login.mailchimp.com/" style="display: inline-block; margin-top: 20px; padding: 12px 30px; background: #2e7d32; color: white; text-decoration: none; border-radius: 4px; font-size: 16px;">Return to Mailchimp</a>'
          }
        </div>
      </body>
    </html>
  `);
}

function renderAlreadyConnectedPage(res, refId) {
  res.status(200).send(`
    <html>
      <head><title>Already Connected - VivaSpot</title></head>
      <body style="font-family: Arial, sans-serif; padding: 40px; text-align: center; background: #f5f5f5;">
        <div style="max-width: 500px; margin: 0 auto; background: white; padding: 40px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
          <div style="font-size: 60px; margin-bottom: 20px;">&#10003;</div>
          <h1 style="color: #2e7d32;">You're Already Connected</h1>
          <p style="color: #666; font-size: 16px;">
            This Mailchimp connection has already been completed. WiFi guest contacts will sync automatically.
          </p>
          <a href="https://login.mailchimp.com/" style="display: inline-block; margin-top: 20px; padding: 12px 30px; background: #2e7d32; color: white; text-decoration: none; border-radius: 4px; font-size: 16px;">Return to Mailchimp</a>
          <p style="color:#999;font-size:12px;margin-top:30px;">Ref: ${refId}</p>
        </div>
      </body>
    </html>
  `);
}

function renderAuthorizationProblemPage(res, status, refId) {
  // Status-specific copy so the user (and we) know what to do next.
  const variants = {
    expired: {
      title: 'Authorization Link Expired',
      body: 'This authorization link has expired. Authorization links are valid for 10 minutes after you start the connection. Please start the connection process again.',
    },
    already_used: {
      title: 'Link Already Used',
      body: 'This authorization link has already been used to connect a Mailchimp account. If you need to connect another location, please start a new connection.',
    },
    not_found: {
      title: 'Authorization Link Not Found',
      body: 'We couldn\'t find this authorization request. The link may be from a previous session or have been cleaned up. Please start the connection process again.',
    },
  };
  const { title, body } = variants[status] || variants.not_found;

  res.status(400).send(`
    <html>
      <head><title>${title} - VivaSpot</title></head>
      <body style="font-family: Arial, sans-serif; padding: 40px; text-align: center; background: #f5f5f5;">
        <div style="max-width: 500px; margin: 0 auto; background: white; padding: 40px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
          <h1 style="color: #c62828;">${title}</h1>
          <p style="color: #666; font-size: 16px; margin: 20px 0;">${body}</p>
          <a href="/oauth/authorize" style="display: inline-block; margin-top: 20px; padding: 12px 30px; background: #007bff; color: white; text-decoration: none; border-radius: 4px; font-size: 16px;">Start Over</a>
          <p style="color: #999; font-size: 13px; margin-top: 30px;">
            Need help? Contact <a href="mailto:support@vivaspot.com">support@vivaspot.com</a> and include the reference code below.
          </p>
          <p style="color:#999;font-size:12px;margin-top:10px;">Ref: ${refId}</p>
        </div>
      </body>
    </html>
  `);
}

function renderAudienceSelectionPage(res, audiences, state, accountName) {
  const audienceOptions = audiences.map(a => `
    <label style="display: block; padding: 15px; border: 1px solid #ddd; border-radius: 4px; margin-bottom: 10px; cursor: pointer;">
      <input type="radio" name="audience_id" value="${a.id}" data-name="${a.name}" required style="margin-right: 10px;">
      <strong>${a.name}</strong>
      <span style="color: #999; margin-left: 10px;">(${a.memberCount} contacts)</span>
    </label>
  `).join('');
  
  res.send(`
    <html>
      <head>
        <title>Select Audience - VivaSpot</title>
      </head>
      <body style="font-family: Arial, sans-serif; padding: 40px; background: #f5f5f5;">
        <div style="max-width: 500px; margin: 0 auto; background: white; padding: 40px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
          <h1 style="margin-top: 0;">Select an Audience</h1>
          <p style="color: #666;">
            Connected to <strong>${accountName}</strong>. 
            Choose which audience should receive WiFi guest contacts:
          </p>
          
          <form method="POST" action="/oauth/select-audience">
            <input type="hidden" name="state" value="${state}">
            <input type="hidden" name="audience_name" id="audience_name" value="">
            
            <div style="margin: 20px 0;">
              ${audienceOptions}
            </div>
            
            <div style="margin: 20px 0;">
              <label style="display: block; margin-bottom: 8px; font-weight: bold;">
                Source Tag (optional)
              </label>
              <input 
                type="text" 
                name="source_tag" 
                placeholder="e.g., WiFi-MainStreet"
                style="width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 4px; box-sizing: border-box;"
              >
              <p style="color: #999; font-size: 12px; margin-top: 5px;">
                Contacts will be tagged with this label for easy filtering.
              </p>
            </div>
            
            <button type="submit" style="
              width: 100%;
              padding: 15px;
              background: #007bff;
              color: white;
              border: none;
              border-radius: 4px;
              font-size: 16px;
              cursor: pointer;
            ">
              Complete Setup
            </button>
          </form>
        </div>
        
        <script>
          // Update hidden audience_name when selection changes
          document.querySelectorAll('input[name="audience_id"]').forEach(radio => {
            radio.addEventListener('change', (e) => {
              document.getElementById('audience_name').value = e.target.dataset.name;
            });
          });
        </script>
      </body>
    </html>
  `);
}

function renderLocationSelectionPage(res, sites, state, accountName, matchMethod) {
  const matchDescription = matchMethod === 'email'
    ? 'We found multiple locations associated with your email address.'
    : 'We found multiple locations matching your account name.';

  const locationOptions = sites.map(site => {
    // Build location details string
    const details = [];
    if (site.address) details.push(site.address);
    if (site.city) details.push(site.city);
    if (site.state) details.push(site.state);
    if (site.hospitality_group) details.push(`Group: ${site.hospitality_group}`);

    const detailsStr = details.length > 0
      ? `<span style="color: #666; font-size: 13px; display: block; margin-top: 4px;">${details.join(' | ')}</span>`
      : '';

    const deviceCount = site.mac_addresses ? site.mac_addresses.length : 0;
    const deviceInfo = deviceCount > 0
      ? `<span style="color: #28a745; font-size: 12px;">${deviceCount} device(s) configured</span>`
      : `<span style="color: #dc3545; font-size: 12px;">No devices configured</span>`;

    return `
      <label style="display: block; padding: 15px; border: 1px solid #ddd; border-radius: 4px; margin-bottom: 10px; cursor: pointer; text-align: left;">
        <input type="checkbox" name="site_ids" value="${site.id}" style="margin-right: 10px;">
        <strong>${site.restaurant_name}</strong>
        ${detailsStr}
        <span style="display: block; margin-top: 6px;">${deviceInfo}</span>
      </label>
    `;
  }).join('');

  res.send(`
    <html>
      <head>
        <title>Select Location - VivaSpot</title>
      </head>
      <body style="font-family: Arial, sans-serif; padding: 40px; background: #f5f5f5;">
        <div style="max-width: 550px; margin: 0 auto; background: white; padding: 40px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
          <h1 style="margin-top: 0;">Select Your Location(s)</h1>
          <p style="color: #666;">
            Connected to Mailchimp account <strong>${accountName}</strong>.
          </p>
          <p style="color: #666;">
            ${matchDescription} Select one or more locations to connect:
          </p>

          <form method="POST" action="/oauth/select-location" id="locationForm">
            <input type="hidden" name="state" value="${state}">

            <div style="margin: 20px 0; max-height: 400px; overflow-y: auto;">
              ${locationOptions}
            </div>

            <button type="submit" id="submitBtn" style="
              width: 100%;
              padding: 15px;
              background: #007bff;
              color: white;
              border: none;
              border-radius: 4px;
              font-size: 16px;
              cursor: pointer;
            ">
              Connect Selected Location(s)
            </button>
          </form>

          <div style="margin-top: 20px; text-align: center;">
            <a href="#" onclick="document.getElementById('manual-entry').style.display='block'; this.style.display='none'; return false;"
               style="color: #666; font-size: 13px;">
              My location isn't listed
            </a>
          </div>

          <div id="manual-entry" style="display: none; margin-top: 20px; border-top: 1px solid #ddd; padding-top: 20px;">
            <h3 style="margin-top: 0;">Add Your Location</h3>
            <form method="POST" action="/oauth/add-location">
              <input type="hidden" name="state" value="${state}">
              <input type="hidden" name="hospitality_group" value="${sites[0]?.hospitality_group || ''}">
              <div style="margin-bottom: 15px;">
                <label style="display: block; margin-bottom: 5px; font-weight: bold;">Location Name</label>
                <input type="text" name="location_name" required placeholder="e.g., My Restaurant - Downtown"
                       style="width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 4px; box-sizing: border-box;">
              </div>
              <div style="margin-bottom: 15px;">
                <label style="display: block; margin-bottom: 5px; font-weight: bold;">Device MAC Address</label>
                <input type="text" name="mac_address" required placeholder="XX:XX:XX:XX:XX:XX"
                       pattern="^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$"
                       style="width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 4px; box-sizing: border-box;">
                <p style="color: #999; font-size: 11px; margin-top: 4px;">
                  Found on the bottom of your VivaSpot device
                </p>
              </div>
              <button type="submit" style="width: 100%; padding: 15px; background: #28a745; color: white; border: none; border-radius: 4px; font-size: 16px; cursor: pointer;">
                Add &amp; Connect Location
              </button>
            </form>
          </div>
        </div>
      </body>
    </html>
  `);
}

module.exports = router;
