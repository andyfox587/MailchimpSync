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

/**
 * Start OAuth flow
 * GET /oauth/authorize?mac_address=XX:XX:XX:XX:XX:XX&redirect_url=https://...
 */
router.get('/authorize', async (req, res) => {
  try {
    const { mac_address, redirect_url } = req.query;
    
    if (!mac_address) {
      return res.status(400).json({ 
        error: 'Missing required parameter: mac_address' 
      });
    }
    
    // Validate MAC address format
    const macRegex = /^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/;
    if (!macRegex.test(mac_address)) {
      return res.status(400).json({ 
        error: 'Invalid MAC address format. Expected XX:XX:XX:XX:XX:XX' 
      });
    }
    
    // Generate random state token for CSRF protection
    const state = crypto.randomBytes(32).toString('hex');
    
    // Store the pending OAuth with MAC address
    await db.createPendingOAuth(state, mac_address, redirect_url);
    
    // Generate authorization URL and redirect
    const authUrl = mailchimp.getAuthorizationUrl(state);
    
    console.log(`OAuth started for MAC: ${mac_address}`);
    res.redirect(authUrl);
    
  } catch (error) {
    console.error('OAuth authorize error:', error);
    res.status(500).json({ error: 'Failed to start OAuth flow' });
  }
});

/**
 * OAuth callback from Mailchimp
 * GET /oauth/callback?code=xxx&state=xxx
 */
router.get('/callback', async (req, res) => {
  try {
    const { code, state, error: oauthError } = req.query;
    
    // Check for OAuth errors
    if (oauthError) {
      console.error('OAuth error from Mailchimp:', oauthError);
      return res.status(400).send(`
        <html>
          <body style="font-family: Arial, sans-serif; padding: 40px; text-align: center;">
            <h1>Authorization Failed</h1>
            <p>Mailchimp returned an error: ${oauthError}</p>
            <p>Please try again or contact support.</p>
          </body>
        </html>
      `);
    }
    
    if (!code || !state) {
      return res.status(400).json({ 
        error: 'Missing required parameters: code and state' 
      });
    }
    
    // Retrieve and validate the pending OAuth state
    const pendingOAuth = await db.consumePendingOAuth(state);
    
    if (!pendingOAuth) {
      return res.status(400).send(`
        <html>
          <body style="font-family: Arial, sans-serif; padding: 40px; text-align: center;">
            <h1>Authorization Expired</h1>
            <p>This authorization link has expired or was already used.</p>
            <p>Please start the connection process again.</p>
          </body>
        </html>
      `);
    }
    
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
    
    // If only one audience, use it automatically
    if (audiences.length === 1) {
      await db.upsertConnection({
        macAddress: mac_address,
        accessToken: accessToken,
        dataCenter: metadata.dataCenter,
        accountId: metadata.accountId,
        accountName: metadata.accountName,
        audienceId: audiences[0].id,
        audienceName: audiences[0].name,
        sourceTag: null
      });
      
      return renderSuccessPage(res, metadata.accountName, audiences[0].name, redirect_url);
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
    console.error('OAuth callback error:', error);
    res.status(500).send(`
      <html>
        <body style="font-family: Arial, sans-serif; padding: 40px; text-align: center;">
          <h1>Connection Failed</h1>
          <p>An error occurred while connecting to Mailchimp: ${error.message}</p>
          <p>Please try again or contact support.</p>
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
    
    // Save the connection
    await db.upsertConnection({
      macAddress: pending.mac_address,
      accessToken: accessToken,
      dataCenter: metadata.dataCenter,
      accountId: metadata.accountId,
      accountName: metadata.accountName,
      audienceId: audience_id,
      audienceName: audience_name,
      sourceTag: source_tag || null
    });
    
    // Clean up pending OAuth
    await db.query('DELETE FROM pending_oauth WHERE state = $1', [state]);
    
    renderSuccessPage(res, metadata.accountName, audience_name, redirect_url);
    
  } catch (error) {
    console.error('Audience selection error:', error);
    res.status(500).send('Failed to complete setup. Please try again.');
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

function renderSuccessPage(res, accountName, audienceName, redirectUrl) {
  const redirectScript = redirectUrl 
    ? `<script>setTimeout(() => window.location.href = '${redirectUrl}', 3000);</script>`
    : '';
  
  res.send(`
    <html>
      <head>
        <title>Connected to Mailchimp</title>
        ${redirectScript}
      </head>
      <body style="font-family: Arial, sans-serif; padding: 40px; text-align: center; background: #f5f5f5;">
        <div style="max-width: 500px; margin: 0 auto; background: white; padding: 40px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
          <div style="font-size: 60px; margin-bottom: 20px;">✓</div>
          <h1 style="color: #2e7d32;">Successfully Connected!</h1>
          <p style="color: #666; font-size: 16px;">
            Your WiFi location is now connected to Mailchimp.
          </p>
          <div style="background: #e8f5e9; padding: 20px; border-radius: 4px; margin: 20px 0;">
            <p style="margin: 0;"><strong>Account:</strong> ${accountName}</p>
            <p style="margin: 10px 0 0 0;"><strong>Audience:</strong> ${audienceName}</p>
          </div>
          <p style="color: #999; font-size: 14px;">
            WiFi guest contacts will now sync automatically to your Mailchimp audience.
          </p>
          ${redirectUrl ? '<p style="color: #999; font-size: 12px;">Redirecting...</p>' : ''}
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
      <input type="hidden" name="audience_name" value="${a.name}">
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
              document.querySelector('input[name="audience_name"]').value = e.target.dataset.name;
            });
          });
        </script>
      </body>
    </html>
  `);
}

module.exports = router;
