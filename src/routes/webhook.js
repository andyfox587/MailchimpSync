/**
 * Webhook Routes
 * 
 * Receives contact data from n8n CRM Router and syncs to Mailchimp.
 * 
 * POST /webhook/contact
 * {
 *   "mac_address": "XX:XX:XX:XX:XX:XX",
 *   "email": "guest@example.com",
 *   "first_name": "John",
 *   "last_name": "Doe",
 *   "phone": "+1234567890",
 *   "source": "WiFi Portal",
 *   "location_name": "Joe's Pizza - Main St",
 *   "opt_in": true
 * }
 *
 * Consent (decided 1 Oct 2026): a guest who ticked the email box (opt_in true)
 * is added as "subscribed". One who didn't (opt_in false, "", "no"…) is added
 * with marketing not allowed (Mailchimp status "transactional") and the tag
 * NO_CONSENT_TAG, so the merchant sees them but can't email them in campaigns
 * until they decide otherwise. A payload without opt_in at all (an older
 * sender) keeps the old behaviour: subscribed.
 */

const express = require('express');
const crypto = require('crypto');
const router = express.Router();

const db = require('../db');
const mailchimp = require('../services/mailchimp');

const NO_CONSENT_TAG = 'WiFi: no email consent';

/** true / false from the guest's answer, or null when the sender didn't say. */
function consentFrom(body) {
  const raw = body.opt_in !== undefined ? body.opt_in : body.opt_in_email;
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'boolean') return raw;
  return /^(true|1|yes|y|on|checked)$/i.test(String(raw).trim());
}

/** The status, extra tags and options for a guest's consent. */
function consentPlan(optedIn) {
  if (optedIn === false) return { status: 'transactional', tags: [NO_CONSENT_TAG], options: { optedIn: false } };
  if (optedIn === true) return { status: 'subscribed', tags: [], options: { optedIn: true, removeTags: [NO_CONSENT_TAG] } };
  return { status: 'subscribed', tags: [], options: {} };
}

/**
 * Verify webhook signature (if secret is configured)
 */
function verifySignature(req, res, next) {
  const secret = process.env.WEBHOOK_SECRET;
  
  // Skip verification if no secret configured
  if (!secret) {
    return next();
  }
  
  const signature = req.headers['x-webhook-signature'];
  
  if (!signature) {
    return res.status(401).json({ error: 'Missing webhook signature' });
  }
  
  // Calculate expected signature
  const payload = JSON.stringify(req.body);
  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex');
  
  if (signature !== expectedSignature) {
    return res.status(401).json({ error: 'Invalid webhook signature' });
  }
  
  next();
}

/**
 * Main contact sync endpoint
 * POST /webhook/contact
 */
router.post('/contact', verifySignature, async (req, res) => {
  const startTime = Date.now();
  
  try {
    const {
      mac_address,
      email,
      first_name,
      last_name,
      phone,
      source,
      location_name,
      custom_fields = {}
    } = req.body;
    
    // Validate required fields
    if (!mac_address) {
      return res.status(400).json({ 
        error: 'Missing required field: mac_address' 
      });
    }
    
    if (!email) {
      return res.status(400).json({ 
        error: 'Missing required field: email' 
      });
    }
    
    // Normalize MAC address to lowercase for consistent matching
    const normalizedMac = mac_address.toLowerCase();
    
    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ 
        error: 'Invalid email format' 
      });
    }
    
    // Look up connection by MAC address
    let connection = await db.getConnectionByMac(normalizedMac);
    
    // If no direct connection, try auto-mapping by location name
    if (!connection && location_name) {
      connection = await tryAutoMapping(normalizedMac, location_name);
    }
    
    if (!connection) {
      console.log(`No Mailchimp connection for MAC: ${normalizedMac}`);
      
      await db.logSync({
        macAddress: normalizedMac,
        email: email,
        success: false,
        errorMessage: 'No Mailchimp connection found',
        crm: 'mailchimp',
      });
      
      return res.status(404).json({
        error: 'No Mailchimp connection found for this location',
        mac_address: normalizedMac
      });
    }
    
    // Connected from the merchant app but no audience chosen yet: hold off.
    if (!connection.audience_id) {
      await db.logSync({
        macAddress: normalizedMac,
        email: email,
        success: false,
        errorMessage: 'Audience not chosen yet',
        crm: 'mailchimp',
      });
      return res.status(409).json({ error: 'Mailchimp is connected but no audience is chosen yet', mac_address: normalizedMac });
    }

    const consent = consentPlan(consentFrom(req.body));

    // Build contact object
    const contact = {
      email: email,
      firstName: first_name,
      lastName: last_name,
      phone: phone,
      mergeFields: custom_fields,
      status: consent.status
    };
    
    // Build tags array - always include VivaSpot WiFi tag
    const tags = ['VivaSpot WiFi', ...consent.tags];
    if (connection.source_tag) {
      tags.push(connection.source_tag);
    }
    if (source) {
      tags.push(source);
    }
    
    // Sync contact to Mailchimp
    const result = await mailchimp.syncContact(
      connection.access_token,
      connection.data_center,
      connection.audience_id,
      contact,
      tags,
      consent.options
    );
    
    const duration = Date.now() - startTime;
    
    // Log successful sync
    await db.logSync({
      macAddress: normalizedMac,
      email: email,
      success: true,
      errorMessage: null,
      crm: 'mailchimp',
    });
    
    console.log(`Contact synced: ${email} -> ${connection.account_name} (${duration}ms)`);
    
    res.json({
      success: true,
      email: result.email,
      status: result.status,
      account: connection.account_name,
      audience: connection.audience_name,
      tags: tags,
      duration_ms: duration
    });
    
  } catch (error) {
    console.error('Contact sync error:', error);
    
    // Log failed sync
    await db.logSync({
      macAddress: req.body.mac_address,
      email: req.body.email,
      success: false,
      errorMessage: error.message,
      crm: 'mailchimp',
    });
    
    res.status(500).json({
      error: 'Failed to sync contact',
      message: error.message
    });
  }
});

/**
 * Batch contact sync endpoint
 * POST /webhook/contacts/batch
 */
router.post('/contacts/batch', verifySignature, async (req, res) => {
  try {
    const { contacts } = req.body;
    
    if (!Array.isArray(contacts) || contacts.length === 0) {
      return res.status(400).json({ 
        error: 'Request body must contain a non-empty "contacts" array' 
      });
    }
    
    if (contacts.length > 100) {
      return res.status(400).json({ 
        error: 'Maximum 100 contacts per batch' 
      });
    }
    
    const results = {
      total: contacts.length,
      success: 0,
      failed: 0,
      errors: []
    };
    
    // Process contacts in parallel with concurrency limit
    const CONCURRENCY = 5;
    for (let i = 0; i < contacts.length; i += CONCURRENCY) {
      const batch = contacts.slice(i, i + CONCURRENCY);
      
      await Promise.all(batch.map(async (contact, index) => {
        try {
          const connection = await db.getConnectionByMac(contact.mac_address);
          
          if (!connection || !connection.audience_id) {
            results.failed++;
            results.errors.push({
              index: i + index,
              email: contact.email,
              error: connection ? 'Audience not chosen yet' : 'No connection found'
            });
            return;
          }
          
          const consent = consentPlan(consentFrom(contact));
          await mailchimp.syncContact(
            connection.access_token,
            connection.data_center,
            connection.audience_id,
            {
              email: contact.email,
              firstName: contact.first_name,
              lastName: contact.last_name,
              phone: contact.phone,
              status: consent.status
            },
            [...(connection.source_tag ? [connection.source_tag] : []), ...consent.tags],
            consent.options
          );
          
          results.success++;
          
        } catch (error) {
          results.failed++;
          results.errors.push({
            index: i + index,
            email: contact.email,
            error: error.message
          });
        }
      }));
    }
    
    res.json(results);
    
  } catch (error) {
    console.error('Batch sync error:', error);
    res.status(500).json({ error: 'Batch sync failed', message: error.message });
  }
});

/**
 * Test endpoint - verify connection works
 * POST /webhook/test
 */
router.post('/test', async (req, res) => {
  try {
    const { mac_address } = req.body;
    
    if (!mac_address) {
      return res.status(400).json({ error: 'Missing mac_address' });
    }
    
    const connection = await db.getConnectionByMac(mac_address);
    
    if (!connection) {
      return res.status(404).json({ 
        error: 'No connection found',
        mac_address: mac_address
      });
    }
    
    // Test the Mailchimp connection
    const isValid = await mailchimp.pingAccount(
      connection.access_token,
      connection.data_center
    );
    
    if (!isValid) {
      return res.json({
        success: false,
        error: 'Mailchimp connection is invalid or expired',
        account: connection.account_name
      });
    }
    
    // Get audience info to verify it still exists
    const audiences = await mailchimp.getAudiences(
      connection.access_token,
      connection.data_center
    );
    
    const targetAudience = audiences.find(a => a.id === connection.audience_id);
    
    res.json({
      success: true,
      connection: {
        mac_address: connection.mac_address,
        account_name: connection.account_name,
        audience_name: connection.audience_name,
        audience_exists: !!targetAudience,
        audience_member_count: targetAudience?.memberCount || 0,
        source_tag: connection.source_tag,
        connected_at: connection.created_at
      }
    });
    
  } catch (error) {
    console.error('Test endpoint error:', error);
    res.status(500).json({ error: error.message });
  }
});

// =============================================================================
// Auto-Mapping Helper
// =============================================================================

/**
 * Try to auto-map a location to an existing Mailchimp account
 * Uses fuzzy matching on account/location name
 */
async function tryAutoMapping(macAddress, locationName) {
  try {
    // Search for similar account names
    const matches = await db.findConnectionsByAccountName(locationName, 0.3);
    
    if (matches.length === 0) {
      console.log(`No auto-mapping match for: ${locationName}`);
      return null;
    }
    
    // Use the best match
    const bestMatch = matches[0];
    console.log(`Auto-mapped "${locationName}" -> "${bestMatch.account_name}" (score: ${bestMatch.match_score})`);
    
    // Create a connection for this MAC address using the matched account
    const newConnection = await db.upsertConnection({
      macAddress: macAddress,
      accessToken: bestMatch.access_token,
      dataCenter: bestMatch.data_center,
      accountId: bestMatch.account_id,
      accountName: bestMatch.account_name,
      audienceId: bestMatch.audience_id,
      audienceName: bestMatch.audience_name,
      // Use location name as source tag for multi-location groups
      sourceTag: locationName
    });
    
    return newConnection;
    
  } catch (error) {
    console.error('Auto-mapping error:', error);
    return null;
  }
}

module.exports = router;
module.exports.consentFrom = consentFrom;
module.exports.consentPlan = consentPlan;
