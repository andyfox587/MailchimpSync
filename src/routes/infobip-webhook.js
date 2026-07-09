/**
 * Infobip Webhook Routes (mounted at /infobip/webhook)
 *
 * Accepts the SAME payload as /webhook/contact and /klaviyo/webhook/contact,
 * so the n8n CRM Router just needs a parallel HTTP node.
 *
 * POST /infobip/webhook/contact
 *   { mac_address, email, first_name, last_name, phone, source, location_name, custom_fields }
 * POST /infobip/webhook/test
 *   { mac_address }
 */

const express = require('express');
const crypto = require('crypto');
const router = express.Router();

const db = require('../db');
const infobip = require('../services/infobip');

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
 * POST /infobip/webhook/contact — sync a captured contact.
 */
router.post('/contact', verifySignature, async (req, res) => {
  const startTime = Date.now();
  try {
    const { mac_address, email, first_name, last_name, phone, source, location_name, custom_fields = {} } = req.body;

    if (!mac_address) return res.status(400).json({ error: 'Missing required field: mac_address' });
    if (!email) return res.status(400).json({ error: 'Missing required field: email' });

    const normalizedMac = String(mac_address).toLowerCase();

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    const connection = await db.getInfobipConnectionByMac(normalizedMac);
    if (!connection) {
      await db.logSync({
        macAddress: normalizedMac,
        email,
        success: false,
        errorMessage: 'No Infobip connection found',
        crm: 'infobip',
      });
      return res.status(404).json({
        error: 'No Infobip connection found for this location',
        mac_address: normalizedMac,
      });
    }

    // Custom fields would go into Infobip customAttributes; not modeled yet.
    const contact = {
      email,
      firstName: first_name,
      lastName: last_name,
      phone,
    };

    const result = await infobip.syncContact({
      apiKey: connection.api_key,
      baseUrl: connection.base_url,
      contact,
      tagName: connection.source_tag,
      cachedTagId: connection.tag_id,
    });

    // Persist the tag_id if we just resolved/created it, so future syncs skip
    // the tag lookup roundtrip.
    if (result.tagId && result.tagId !== connection.tag_id) {
      try {
        await db.updateInfobipConnectionTagId(connection.id, result.tagId);
      } catch (e) {
        console.warn('Failed to cache Infobip tag_id:', e.message);
      }
    }

    const duration = Date.now() - startTime;
    await db.logSync({
      macAddress: normalizedMac,
      email,
      success: true,
      errorMessage: null,
      crm: 'infobip',
    });

    console.log(`Infobip contact ${result.action}: ${email} -> ${connection.account_name} / ${connection.source_tag} (${duration}ms)`);

    res.json({
      success: true,
      email,
      status: result.action, // 'created' or 'updated'
      account: connection.account_name,
      tag: connection.source_tag,
      person_id: result.id,
      duration_ms: duration,
    });
  } catch (error) {
    console.error('Infobip contact sync error:', error.message);
    await db.logSync({
      macAddress: req.body.mac_address,
      email: req.body.email,
      success: false,
      errorMessage: error.message,
      crm: 'infobip',
    });
    res.status(500).json({ error: 'Failed to sync contact', message: error.message });
  }
});

/**
 * POST /infobip/webhook/test — verify a connection.
 */
router.post('/test', async (req, res) => {
  try {
    const { mac_address } = req.body;
    if (!mac_address) return res.status(400).json({ error: 'Missing mac_address' });

    const connection = await db.getInfobipConnectionByMac(mac_address);
    if (!connection) {
      return res.status(404).json({ error: 'No connection found', mac_address });
    }

    const isValid = await infobip.pingAccount(connection.api_key, connection.base_url);
    res.json({
      success: isValid,
      connection: {
        mac_address: connection.mac_address,
        account_name: connection.account_name,
        source_tag: connection.source_tag,
        tag_id: connection.tag_id,
        base_url: connection.base_url,
        connected_at: connection.created_at,
      },
    });
  } catch (error) {
    console.error('Infobip test error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
