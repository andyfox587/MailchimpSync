/**
 * Manual Setup Routes
 * 
 * Fallback when auto-mapping fails - allows users to manually enter MAC addresses.
 */

const express = require('express');
const router = express.Router();

const db = require('../db');

/**
 * GET /setup/:accountId
 * 
 * Display the manual MAC address entry form
 */
router.get('/:accountId', async (req, res) => {
  const { accountId } = req.params;
  const { account_name, audience_id, audience_name, access_token, data_center } = req.query;
  
  if (!accountId) {
    return res.status(400).send('Missing account ID');
  }
  
  // Get existing mappings for this account
  let existingMappings = [];
  try {
    const result = await db.query(
      'SELECT mac_address, source_tag, created_at FROM mailchimp_connections WHERE account_id = $1',
      [accountId]
    );
    existingMappings = result.rows;
  } catch (err) {
    console.error('Error fetching existing mappings:', err);
  }
  
  const displayName = account_name || 'Your Account';
  
  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>Setup WiFi Devices - ${displayName}</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; 
            padding: 20px; 
            max-width: 600px; 
            margin: 0 auto;
            background: #f5f5f5;
          }
          .container {
            background: white;
            padding: 30px;
            border-radius: 12px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
          }
          h1 { 
            color: #1f2937; 
            margin-bottom: 10px;
            font-size: 24px;
          }
          .subtitle { 
            color: #6b7280; 
            margin-bottom: 25px;
            font-size: 14px;
          }
          .info-box {
            background: #fef3c7;
            border: 1px solid #f59e0b;
            border-radius: 8px;
            padding: 15px;
            margin-bottom: 25px;
          }
          .info-box h3 {
            color: #92400e;
            margin: 0 0 8px 0;
            font-size: 14px;
          }
          .info-box p {
            color: #78350f;
            margin: 0;
            font-size: 13px;
          }
          .form-group { 
            margin-bottom: 20px; 
          }
          label { 
            display: block; 
            font-weight: 600; 
            margin-bottom: 8px; 
            color: #374151;
            font-size: 14px;
          }
          textarea { 
            width: 100%; 
            padding: 12px; 
            border: 1px solid #d1d5db; 
            border-radius: 8px; 
            font-family: 'SF Mono', Monaco, monospace;
            font-size: 13px;
            min-height: 100px;
            resize: vertical;
            box-sizing: border-box;
          }
          textarea:focus { 
            outline: none; 
            border-color: #3b82f6; 
            box-shadow: 0 0 0 3px rgba(59,130,246,0.1); 
          }
          .help-text { 
            font-size: 12px; 
            color: #6b7280; 
            margin-top: 8px;
          }
          .btn { 
            background: #3b82f6; 
            color: white; 
            padding: 14px 24px; 
            border: none;
            border-radius: 8px; 
            font-size: 16px;
            font-weight: 600;
            cursor: pointer;
            width: 100%;
            transition: background 0.2s;
          }
          .btn:hover { 
            background: #2563eb; 
          }
          .btn:disabled { 
            background: #9ca3af; 
            cursor: not-allowed; 
          }
          .existing { 
            background: #f0fdf4; 
            border: 1px solid #86efac; 
            border-radius: 8px; 
            padding: 15px; 
            margin-bottom: 25px;
          }
          .existing h3 { 
            color: #166534; 
            margin: 0 0 10px 0; 
            font-size: 14px;
            font-weight: 600;
          }
          .existing-mac { 
            font-family: 'SF Mono', Monaco, monospace;
            font-size: 13px;
            background: #dcfce7;
            padding: 4px 8px;
            border-radius: 4px;
            display: inline-block;
            margin: 2px 4px 2px 0;
          }
          .error {
            background: #fef2f2;
            border: 1px solid #fecaca;
            color: #991b1b;
            padding: 12px;
            border-radius: 8px;
            margin-bottom: 20px;
            font-size: 14px;
          }
          .success {
            background: #f0fdf4;
            border: 1px solid #86efac;
            color: #166534;
            padding: 12px;
            border-radius: 8px;
            margin-bottom: 20px;
            font-size: 14px;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>Setup WiFi Devices</h1>
          <p class="subtitle">Connect your WiFi access points to <strong>${displayName}</strong></p>
          
          <div class="info-box">
            <h3>⚠️ Auto-mapping couldn't find your location</h3>
            <p>We couldn't automatically match your Mailchimp account to our records. Please enter your WiFi device MAC addresses manually below.</p>
          </div>
          
          ${existingMappings.length > 0 ? `
            <div class="existing">
              <h3>✓ Already Connected (${existingMappings.length} device${existingMappings.length > 1 ? 's' : ''})</h3>
              <div>
                ${existingMappings.map(m => `<span class="existing-mac">${m.mac_address}</span>`).join('')}
              </div>
            </div>
          ` : ''}
          
          <div id="message"></div>
          
          <form id="setup-form">
            <input type="hidden" name="account_id" value="${accountId}">
            <input type="hidden" name="account_name" value="${account_name || ''}">
            <input type="hidden" name="audience_id" value="${audience_id || ''}">
            <input type="hidden" name="audience_name" value="${audience_name || ''}">
            <input type="hidden" name="access_token" value="${access_token || ''}">
            <input type="hidden" name="data_center" value="${data_center || ''}">
            
            <div class="form-group">
              <label for="mac_addresses">MAC Addresses</label>
              <textarea 
                id="mac_addresses" 
                name="mac_addresses" 
                placeholder="00:18:0a:36:1a:f8&#10;00:18:0a:36:1a:f9"
                required
              ></textarea>
              <p class="help-text">
                Enter one MAC address per line. You can find these in your router or access point settings.
                <br>Accepted formats: 00:18:0a:36:1a:f8 or 00-18-0a-36-1a-f8 or 00180a361af8
              </p>
            </div>
            
            <div class="form-group">
              <label for="source_tag">Source Tag (optional)</label>
              <input 
                type="text" 
                id="source_tag" 
                name="source_tag" 
                placeholder="e.g., Main-Dining, Bar-Area"
                style="width: 100%; padding: 12px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 14px; box-sizing: border-box;"
              >
              <p class="help-text">
                Contacts from these devices will be tagged with this label in Mailchimp.
              </p>
            </div>
            
            <button type="submit" class="btn">Save MAC Addresses</button>
          </form>
          
          <p style="text-align: center; margin-top: 20px; font-size: 13px; color: #6b7280;">
            Need help? Contact <a href="mailto:support@vivaspot.com">support@vivaspot.com</a>
          </p>
        </div>
        
        <script>
          document.getElementById('setup-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            
            const form = e.target;
            const btn = form.querySelector('button');
            const msgDiv = document.getElementById('message');
            
            btn.disabled = true;
            btn.textContent = 'Saving...';
            msgDiv.innerHTML = '';
            
            try {
              const formData = new FormData(form);
              const response = await fetch('/setup/save', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(Object.fromEntries(formData))
              });
              
              const result = await response.json();
              
              if (result.success) {
                msgDiv.innerHTML = '<div class="success">✓ ' + result.message + '</div>';
                form.querySelector('textarea').value = '';
                // Reload to show new mappings
                setTimeout(() => window.location.reload(), 1500);
              } else {
                msgDiv.innerHTML = '<div class="error">' + (result.error || 'Failed to save') + '</div>';
              }
            } catch (error) {
              msgDiv.innerHTML = '<div class="error">Error: ' + error.message + '</div>';
            } finally {
              btn.disabled = false;
              btn.textContent = 'Save MAC Addresses';
            }
          });
        </script>
      </body>
    </html>
  `);
});

/**
 * POST /setup/save
 * 
 * Save manually entered MAC addresses
 */
router.post('/save', express.json(), async (req, res) => {
  try {
    const { 
      account_id, 
      account_name, 
      audience_id, 
      audience_name, 
      access_token, 
      data_center,
      mac_addresses, 
      source_tag 
    } = req.body;
    
    if (!account_id || !mac_addresses) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    if (!access_token || !data_center) {
      return res.status(400).json({ error: 'Missing Mailchimp credentials. Please re-authorize.' });
    }
    
    // Parse MAC addresses (one per line, various formats accepted)
    const rawMacs = mac_addresses.split(/[\n,]+/).map(m => m.trim()).filter(m => m);
    
    // Normalize MAC addresses to lowercase colon format
    const normalizedMacs = rawMacs.map(mac => {
      // Remove all separators and convert to lowercase
      const clean = mac.replace(/[:\-\s]/g, '').toLowerCase();
      
      // Validate length
      if (clean.length !== 12 || !/^[0-9a-f]+$/.test(clean)) {
        return null;
      }
      
      // Format as XX:XX:XX:XX:XX:XX
      return clean.match(/.{2}/g).join(':');
    });
    
    // Filter out invalid MACs
    const validMacs = normalizedMacs.filter(m => m !== null);
    const invalidCount = normalizedMacs.length - validMacs.length;
    
    if (validMacs.length === 0) {
      return res.status(400).json({ 
        error: 'No valid MAC addresses found. Please check the format.' 
      });
    }
    
    // Create connection for each MAC address
    const connections = validMacs.map(mac => ({
      macAddress: mac,
      accessToken: access_token,
      dataCenter: data_center,
      accountId: account_id,
      accountName: account_name,
      audienceId: audience_id,
      audienceName: audience_name,
      sourceTag: source_tag || null
    }));
    
    await db.bulkUpsertConnections(connections);
    
    console.log(`Manual setup: ${validMacs.length} MAC(s) mapped to account ${account_name}`);
    
    let message = `Successfully mapped ${validMacs.length} device(s)`;
    if (invalidCount > 0) {
      message += ` (${invalidCount} invalid MAC address${invalidCount > 1 ? 'es' : ''} skipped)`;
    }
    
    res.json({ 
      success: true, 
      message,
      mapped: validMacs
    });
    
  } catch (error) {
    console.error('Manual setup error:', error);
    res.status(500).json({ error: 'Failed to save MAC addresses' });
  }
});

module.exports = router;
