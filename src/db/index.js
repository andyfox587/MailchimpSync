/**
 * Database connection and query helpers
 * Uses PostgreSQL with pg_trgm extension for fuzzy matching
 */

const { Pool } = require('pg');

// Create connection pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' 
    ? { rejectUnauthorized: false } 
    : false,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// Log connection errors
pool.on('error', (err) => {
  console.error('Unexpected database error:', err);
});

/**
 * Test database connection
 */
async function testConnection() {
  const client = await pool.connect();
  try {
    await client.query('SELECT NOW()');
    return true;
  } finally {
    client.release();
  }
}

/**
 * Execute a query with parameters
 */
async function query(text, params) {
  const start = Date.now();
  const result = await pool.query(text, params);
  const duration = Date.now() - start;
  
  if (process.env.DEBUG === 'true') {
    console.log('Query executed:', { text: text.substring(0, 100), duration, rows: result.rowCount });
  }
  
  return result;
}

/**
 * Get a client for transaction support
 */
async function getClient() {
  return await pool.connect();
}

// =============================================================================
// Connection CRUD Operations
// =============================================================================

/**
 * Create or update a Mailchimp connection
 */
async function upsertConnection({
  macAddress,
  accessToken,
  dataCenter,
  accountId,
  accountName,
  audienceId,
  audienceName,
  sourceTag
}) {
  const result = await query(`
    INSERT INTO mailchimp_connections (
      mac_address, access_token, data_center, account_id, 
      account_name, audience_id, audience_name, source_tag, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
    ON CONFLICT (mac_address) 
    DO UPDATE SET
      access_token = EXCLUDED.access_token,
      data_center = EXCLUDED.data_center,
      account_id = EXCLUDED.account_id,
      account_name = EXCLUDED.account_name,
      audience_id = EXCLUDED.audience_id,
      audience_name = EXCLUDED.audience_name,
      source_tag = EXCLUDED.source_tag,
      updated_at = NOW()
    RETURNING *
  `, [macAddress, accessToken, dataCenter, accountId, accountName, audienceId, audienceName, sourceTag]);
  
  return result.rows[0];
}

/**
 * Get connection by MAC address
 */
async function getConnectionByMac(macAddress) {
  const result = await query(
    'SELECT * FROM mailchimp_connections WHERE mac_address = $1',
    [macAddress]
  );
  return result.rows[0] || null;
}

/**
 * Get connection by Mailchimp account ID
 */
async function getConnectionByAccountId(accountId) {
  const result = await query(
    'SELECT * FROM mailchimp_connections WHERE account_id = $1',
    [accountId]
  );
  return result.rows[0] || null;
}

/**
 * Get all connections (for admin)
 */
async function getAllConnections() {
  const result = await query(
    'SELECT id, mac_address, account_name, audience_name, source_tag, created_at, updated_at FROM mailchimp_connections ORDER BY updated_at DESC'
  );
  return result.rows;
}

/**
 * Delete connection by MAC address
 */
async function deleteConnection(macAddress) {
  const result = await query(
    'DELETE FROM mailchimp_connections WHERE mac_address = $1 RETURNING *',
    [macAddress]
  );
  return result.rows[0] || null;
}

/**
 * Find connections by fuzzy matching account name
 * Uses PostgreSQL pg_trgm extension for similarity search
 */
async function findConnectionsByAccountName(searchName, threshold = 0.3) {
  const result = await query(`
    SELECT *, 
           similarity(account_name, $1) as match_score
    FROM mailchimp_connections 
    WHERE similarity(account_name, $1) > $2
    ORDER BY match_score DESC
    LIMIT 5
  `, [searchName, threshold]);
  
  return result.rows;
}

// =============================================================================
// Pending OAuth State Management
// =============================================================================

/**
 * Store pending OAuth state (for linking MAC address to OAuth flow)
 */
async function createPendingOAuth(state, macAddress, redirectUrl = null) {
  const result = await query(`
    INSERT INTO pending_oauth (state, mac_address, redirect_url, expires_at)
    VALUES ($1, $2, $3, NOW() + INTERVAL '10 minutes')
    RETURNING *
  `, [state, macAddress, redirectUrl]);
  
  return result.rows[0];
}

/**
 * Get and delete pending OAuth state
 */
async function consumePendingOAuth(state) {
  const result = await query(`
    DELETE FROM pending_oauth 
    WHERE state = $1 AND expires_at > NOW()
    RETURNING *
  `, [state]);
  
  return result.rows[0] || null;
}

/**
 * Clean up expired pending OAuth states
 */
async function cleanupExpiredOAuth() {
  const result = await query(
    'DELETE FROM pending_oauth WHERE expires_at < NOW()'
  );
  return result.rowCount;
}

// =============================================================================
// Sync Log Operations (for debugging/metrics)
// =============================================================================

/**
 * Log a contact sync operation
 */
async function logSync({ macAddress, email, success, errorMessage = null }) {
  await query(`
    INSERT INTO sync_log (mac_address, email, success, error_message)
    VALUES ($1, $2, $3, $4)
  `, [macAddress, email, success, errorMessage]);
}

/**
 * Get recent sync logs
 */
async function getRecentSyncLogs(limit = 100) {
  const result = await query(`
    SELECT * FROM sync_log 
    ORDER BY created_at DESC 
    LIMIT $1
  `, [limit]);
  
  return result.rows;
}

module.exports = {
  pool,
  query,
  getClient,
  testConnection,
  
  // Connections
  upsertConnection,
  getConnectionByMac,
  getConnectionByAccountId,
  getAllConnections,
  deleteConnection,
  findConnectionsByAccountName,
  
  // OAuth
  createPendingOAuth,
  consumePendingOAuth,
  cleanupExpiredOAuth,
  
  // Sync logs
  logSync,
  getRecentSyncLogs,
};
