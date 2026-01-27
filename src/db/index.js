/**
 * Database connection and query helpers
 * Uses PostgreSQL with pg_trgm extension for fuzzy matching
 * 
 * Note: This app connects to TWO databases:
 * 1. Mailchimp database (DATABASE_URL) - for storing Mailchimp connections
 * 2. VivaSpot/GHL database (VIVASPOT_DATABASE_URL) - for looking up customer sites/MACs
 */

const { Pool } = require('pg');

// Mailchimp database pool (primary)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' 
    ? { rejectUnauthorized: false } 
    : false,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// VivaSpot/GHL database pool (for site lookups)
// If not configured, falls back to primary database
const vivaspotPool = new Pool({
  connectionString: process.env.VIVASPOT_DATABASE_URL || process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' 
    ? { rejectUnauthorized: false } 
    : false,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// Log connection errors
pool.on('error', (err) => {
  console.error('Unexpected database error (mailchimp):', err);
});

vivaspotPool.on('error', (err) => {
  console.error('Unexpected database error (vivaspot):', err);
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
 * Execute a query with parameters (Mailchimp DB)
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
 * Execute a query on VivaSpot database
 */
async function vivaspotQuery(text, params) {
  const start = Date.now();
  const result = await vivaspotPool.query(text, params);
  const duration = Date.now() - start;
  
  if (process.env.DEBUG === 'true') {
    console.log('VivaSpot query:', { text: text.substring(0, 100), duration, rows: result.rowCount });
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
 * Bulk insert multiple MAC address connections
 */
async function bulkUpsertConnections(connections) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    const results = [];
    for (const conn of connections) {
      const result = await client.query(`
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
      `, [
        conn.macAddress, conn.accessToken, conn.dataCenter, conn.accountId,
        conn.accountName, conn.audienceId, conn.audienceName, conn.sourceTag
      ]);
      results.push(result.rows[0]);
    }
    
    await client.query('COMMIT');
    return results;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Get connection by MAC address (case-insensitive)
 */
async function getConnectionByMac(macAddress) {
  const result = await query(
    'SELECT * FROM mailchimp_connections WHERE LOWER(mac_address) = LOWER($1)',
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
// VivaSpot Sites Lookup (from GHL database)
// =============================================================================

/**
 * Find VivaSpot site by restaurant name (fuzzy match)
 * Returns site with MAC addresses
 */
async function findSiteByRestaurantName(restaurantName) {
  try {
    // First try exact match
    let result = await vivaspotQuery(`
      SELECT * FROM vivaspot_sites 
      WHERE LOWER(restaurant_name) = LOWER($1)
      LIMIT 1
    `, [restaurantName]);
    
    if (result.rows.length > 0) {
      console.log(`Found exact match for "${restaurantName}"`);
      return result.rows[0];
    }
    
    // Try fuzzy match with pg_trgm
    result = await vivaspotQuery(`
      SELECT *, 
             similarity(restaurant_name, $1) as match_score
      FROM vivaspot_sites 
      WHERE similarity(restaurant_name, $1) > 0.3
      ORDER BY match_score DESC
      LIMIT 1
    `, [restaurantName]);
    
    if (result.rows.length > 0) {
      console.log(`Found fuzzy match for "${restaurantName}": "${result.rows[0].restaurant_name}" (score: ${result.rows[0].match_score})`);
      return result.rows[0];
    }
    
    // Try contains match
    result = await vivaspotQuery(`
      SELECT * FROM vivaspot_sites 
      WHERE LOWER(restaurant_name) LIKE LOWER($1)
      OR LOWER($2) LIKE '%' || LOWER(restaurant_name) || '%'
      LIMIT 1
    `, [`%${restaurantName}%`, restaurantName]);
    
    if (result.rows.length > 0) {
      console.log(`Found contains match for "${restaurantName}": "${result.rows[0].restaurant_name}"`);
      return result.rows[0];
    }
    
    console.log(`No match found for "${restaurantName}"`);
    return null;
  } catch (error) {
    console.error('Error finding site by restaurant name:', error);
    return null;
  }
}

/**
 * Find all sites for a hospitality group
 */
async function findSitesByHospitalityGroup(groupName) {
  try {
    const result = await vivaspotQuery(`
      SELECT * FROM vivaspot_sites 
      WHERE LOWER(hospitality_group) = LOWER($1)
      OR similarity(hospitality_group, $1) > 0.5
      ORDER BY restaurant_name
    `, [groupName]);
    
    return result.rows;
  } catch (error) {
    console.error('Error finding sites by hospitality group:', error);
    return [];
  }
}

/**
 * Find site by email address
 */
async function findSiteByEmail(email) {
  try {
    const result = await vivaspotQuery(`
      SELECT * FROM vivaspot_sites
      WHERE $1 = ANY(merchant_emails)
      LIMIT 1
    `, [email.toLowerCase()]);

    return result.rows[0] || null;
  } catch (error) {
    console.error('Error finding site by email:', error);
    return null;
  }
}

/**
 * Find ALL sites matching by email address
 * Used when one email manages multiple locations (hospitality groups)
 */
async function findAllSitesByEmail(email) {
  try {
    const result = await vivaspotQuery(`
      SELECT * FROM vivaspot_sites
      WHERE $1 = ANY(merchant_emails)
      ORDER BY restaurant_name
    `, [email.toLowerCase()]);

    return result.rows;
  } catch (error) {
    console.error('Error finding sites by email:', error);
    return [];
  }
}

/**
 * Find ALL sites matching by restaurant name (fuzzy match)
 * Returns all potential matches above threshold, not just the best one
 */
async function findAllSitesByRestaurantName(restaurantName, threshold = 0.3) {
  try {
    // Collect matches from different strategies
    const matches = new Map(); // Use Map to dedupe by site id

    // 1. Exact matches
    const exactResult = await vivaspotQuery(`
      SELECT *, 1.0 as match_score, 'exact' as match_type
      FROM vivaspot_sites
      WHERE LOWER(restaurant_name) = LOWER($1)
    `, [restaurantName]);

    exactResult.rows.forEach(row => matches.set(row.id, row));

    // 2. Fuzzy matches with pg_trgm
    const fuzzyResult = await vivaspotQuery(`
      SELECT *,
             similarity(restaurant_name, $1) as match_score,
             'fuzzy' as match_type
      FROM vivaspot_sites
      WHERE similarity(restaurant_name, $1) > $2
      ORDER BY match_score DESC
    `, [restaurantName, threshold]);

    fuzzyResult.rows.forEach(row => {
      if (!matches.has(row.id)) {
        matches.set(row.id, row);
      }
    });

    // 3. Contains matches (name contains search term or vice versa)
    const containsResult = await vivaspotQuery(`
      SELECT *, 0.5 as match_score, 'contains' as match_type
      FROM vivaspot_sites
      WHERE LOWER(restaurant_name) LIKE LOWER($1)
      OR LOWER($2) LIKE '%' || LOWER(restaurant_name) || '%'
    `, [`%${restaurantName}%`, restaurantName]);

    containsResult.rows.forEach(row => {
      if (!matches.has(row.id)) {
        matches.set(row.id, row);
      }
    });

    // Convert to array and sort by match score
    const results = Array.from(matches.values())
      .sort((a, b) => b.match_score - a.match_score);

    console.log(`Found ${results.length} potential site matches for "${restaurantName}"`);
    return results;
  } catch (error) {
    console.error('Error finding sites by restaurant name:', error);
    return [];
  }
}

/**
 * Find all candidate sites for auto-mapping
 * Combines email and name matching strategies
 * Returns { sites: [], matchMethod: 'email'|'name'|'none' }
 */
async function findCandidateSites(accountName, loginEmail) {
  try {
    // Strategy 1: Try email match first (most reliable for hospitality groups)
    if (loginEmail) {
      const emailMatches = await findAllSitesByEmail(loginEmail);
      if (emailMatches.length > 0) {
        console.log(`Found ${emailMatches.length} site(s) by email "${loginEmail}"`);
        return { sites: emailMatches, matchMethod: 'email' };
      }
    }

    // Strategy 2: Try name matching
    const nameMatches = await findAllSitesByRestaurantName(accountName);
    if (nameMatches.length > 0) {
      console.log(`Found ${nameMatches.length} site(s) by name "${accountName}"`);
      return { sites: nameMatches, matchMethod: 'name' };
    }

    // No matches found
    console.log(`No site matches found for account "${accountName}" (email: ${loginEmail})`);
    return { sites: [], matchMethod: 'none' };
  } catch (error) {
    console.error('Error finding candidate sites:', error);
    return { sites: [], matchMethod: 'none' };
  }
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
  vivaspotPool,
  query,
  vivaspotQuery,
  getClient,
  testConnection,
  
  // Connections
  upsertConnection,
  bulkUpsertConnections,
  getConnectionByMac,
  getConnectionByAccountId,
  getAllConnections,
  deleteConnection,
  findConnectionsByAccountName,
  
  // VivaSpot Sites
  findSiteByRestaurantName,
  findSitesByHospitalityGroup,
  findSiteByEmail,
  findAllSitesByEmail,
  findAllSitesByRestaurantName,
  findCandidateSites,
  
  // OAuth
  createPendingOAuth,
  consumePendingOAuth,
  cleanupExpiredOAuth,
  
  // Sync logs
  logSync,
  getRecentSyncLogs,
};
