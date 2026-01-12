/**
 * Connection Management Routes
 * 
 * Admin endpoints for viewing and managing Mailchimp connections.
 * In production, these should be protected with authentication.
 */

const express = require('express');
const router = express.Router();

const db = require('../db');
const mailchimp = require('../services/mailchimp');

/**
 * Simple auth middleware (replace with proper auth in production)
 */
function adminAuth(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  const expectedKey = process.env.ADMIN_API_KEY;
  
  // Skip auth if no key configured (development)
  if (!expectedKey) {
    return next();
  }
  
  if (apiKey !== expectedKey) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  next();
}

router.use(adminAuth);

/**
 * List all connections
 * GET /connections
 */
router.get('/', async (req, res) => {
  try {
    const connections = await db.getAllConnections();
    
    res.json({
      count: connections.length,
      connections: connections.map(c => ({
        id: c.id,
        mac_address: c.mac_address,
        account_name: c.account_name,
        audience_name: c.audience_name,
        source_tag: c.source_tag,
        created_at: c.created_at,
        updated_at: c.updated_at
      }))
    });
  } catch (error) {
    console.error('List connections error:', error);
    res.status(500).json({ error: 'Failed to list connections' });
  }
});

/**
 * Get connection details
 * GET /connections/:mac_address
 */
router.get('/:mac_address', async (req, res) => {
  try {
    const connection = await db.getConnectionByMac(req.params.mac_address);
    
    if (!connection) {
      return res.status(404).json({ error: 'Connection not found' });
    }
    
    // Test if connection is still valid
    const isValid = await mailchimp.pingAccount(
      connection.access_token,
      connection.data_center
    );
    
    res.json({
      id: connection.id,
      mac_address: connection.mac_address,
      data_center: connection.data_center,
      account_id: connection.account_id,
      account_name: connection.account_name,
      audience_id: connection.audience_id,
      audience_name: connection.audience_name,
      source_tag: connection.source_tag,
      created_at: connection.created_at,
      updated_at: connection.updated_at,
      is_valid: isValid
    });
  } catch (error) {
    console.error('Get connection error:', error);
    res.status(500).json({ error: 'Failed to get connection' });
  }
});

/**
 * Update connection settings (e.g., change audience or source tag)
 * PATCH /connections/:mac_address
 */
router.patch('/:mac_address', async (req, res) => {
  try {
    const { audience_id, audience_name, source_tag } = req.body;
    const macAddress = req.params.mac_address;
    
    const existing = await db.getConnectionByMac(macAddress);
    
    if (!existing) {
      return res.status(404).json({ error: 'Connection not found' });
    }
    
    // If changing audience, verify it exists
    if (audience_id && audience_id !== existing.audience_id) {
      const audiences = await mailchimp.getAudiences(
        existing.access_token,
        existing.data_center
      );
      
      const targetAudience = audiences.find(a => a.id === audience_id);
      if (!targetAudience) {
        return res.status(400).json({ 
          error: 'Audience not found in this Mailchimp account' 
        });
      }
    }
    
    // Update connection
    const updated = await db.upsertConnection({
      macAddress: macAddress,
      accessToken: existing.access_token,
      dataCenter: existing.data_center,
      accountId: existing.account_id,
      accountName: existing.account_name,
      audienceId: audience_id || existing.audience_id,
      audienceName: audience_name || existing.audience_name,
      sourceTag: source_tag !== undefined ? source_tag : existing.source_tag
    });
    
    res.json({
      success: true,
      connection: {
        mac_address: updated.mac_address,
        audience_id: updated.audience_id,
        audience_name: updated.audience_name,
        source_tag: updated.source_tag
      }
    });
  } catch (error) {
    console.error('Update connection error:', error);
    res.status(500).json({ error: 'Failed to update connection' });
  }
});

/**
 * Delete a connection
 * DELETE /connections/:mac_address
 */
router.delete('/:mac_address', async (req, res) => {
  try {
    const deleted = await db.deleteConnection(req.params.mac_address);
    
    if (!deleted) {
      return res.status(404).json({ error: 'Connection not found' });
    }
    
    res.json({
      success: true,
      deleted: {
        mac_address: deleted.mac_address,
        account_name: deleted.account_name
      }
    });
  } catch (error) {
    console.error('Delete connection error:', error);
    res.status(500).json({ error: 'Failed to delete connection' });
  }
});

/**
 * Get available audiences for a connection
 * GET /connections/:mac_address/audiences
 */
router.get('/:mac_address/audiences', async (req, res) => {
  try {
    const connection = await db.getConnectionByMac(req.params.mac_address);
    
    if (!connection) {
      return res.status(404).json({ error: 'Connection not found' });
    }
    
    const audiences = await mailchimp.getAudiences(
      connection.access_token,
      connection.data_center
    );
    
    res.json({
      account_name: connection.account_name,
      current_audience_id: connection.audience_id,
      audiences: audiences
    });
  } catch (error) {
    console.error('Get audiences error:', error);
    res.status(500).json({ error: 'Failed to get audiences' });
  }
});

/**
 * Get sync logs
 * GET /connections/logs/recent
 */
router.get('/logs/recent', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const logs = await db.getRecentSyncLogs(limit);
    
    res.json({
      count: logs.length,
      logs: logs
    });
  } catch (error) {
    console.error('Get logs error:', error);
    res.status(500).json({ error: 'Failed to get logs' });
  }
});

/**
 * Search for connections by account name (fuzzy)
 * GET /connections/search?q=pizza
 */
router.get('/search', async (req, res) => {
  try {
    const searchTerm = req.query.q;
    
    if (!searchTerm) {
      return res.status(400).json({ error: 'Missing search query (q parameter)' });
    }
    
    const matches = await db.findConnectionsByAccountName(searchTerm);
    
    res.json({
      query: searchTerm,
      count: matches.length,
      results: matches.map(m => ({
        mac_address: m.mac_address,
        account_name: m.account_name,
        audience_name: m.audience_name,
        match_score: parseFloat(m.match_score).toFixed(3)
      }))
    });
  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({ error: 'Search failed' });
  }
});

module.exports = router;
