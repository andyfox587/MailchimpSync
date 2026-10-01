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

// =============================================================================
// Merchant app (vivaspot-campaigns) connections, keyed by VivaSpot account
// =============================================================================
//
// The merchant app knows the VivaSpot account (acc_id) and its access points'
// MACs. A row belongs to an account when it carries that acc_id, or when it
// has no acc_id yet (made by staff or auto-mapping) and its MAC is one of the
// account's. Rows tagged with a different acc_id are never touched.

const APP_ROW_FILTER = `(acc_id = $1 OR (acc_id IS NULL AND LOWER(mac_address) = ANY($2)))`;

/**
 * Connect an account's access points to one Mailchimp account. `audienceId`
 * may be null: the merchant then chooses it in the app, and the webhook skips
 * contacts until they do.
 */
async function upsertAppConnections(accId, macs, { accessToken, dataCenter, accountId, accountName, audienceId, audienceName }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const rows = [];
    for (const mac of macs) {
      const result = await client.query(`
        INSERT INTO mailchimp_connections (
          mac_address, access_token, data_center, account_id,
          account_name, audience_id, audience_name, source_tag, acc_id, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, $8, NOW())
        ON CONFLICT (mac_address)
        DO UPDATE SET
          access_token = EXCLUDED.access_token,
          data_center = EXCLUDED.data_center,
          account_id = EXCLUDED.account_id,
          account_name = EXCLUDED.account_name,
          audience_id = EXCLUDED.audience_id,
          audience_name = EXCLUDED.audience_name,
          acc_id = EXCLUDED.acc_id,
          updated_at = NOW()
        RETURNING *
      `, [mac, accessToken, dataCenter, accountId, accountName, audienceId, audienceName, accId]);
      rows.push(result.rows[0]);
    }
    await client.query('COMMIT');
    return rows;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** The account's Mailchimp connections (see APP_ROW_FILTER). */
async function getAppConnections(accId, macs) {
  const result = await query(
    `SELECT * FROM mailchimp_connections WHERE ${APP_ROW_FILTER} ORDER BY created_at`,
    [accId, macs.map((m) => m.toLowerCase())]
  );
  return result.rows;
}

/** Point all of the account's connections at one audience, and claim them for the account. */
async function setAppAudience(accId, macs, audienceId, audienceName) {
  const result = await query(
    `UPDATE mailchimp_connections
        SET audience_id = $3, audience_name = $4, acc_id = $1, updated_at = NOW()
      WHERE ${APP_ROW_FILTER}
      RETURNING *`,
    [accId, macs.map((m) => m.toLowerCase()), audienceId, audienceName]
  );
  return result.rows;
}

/** Disconnect the account: delete its connections. */
async function deleteAppConnections(accId, macs) {
  const result = await query(
    `DELETE FROM mailchimp_connections WHERE ${APP_ROW_FILTER} RETURNING mac_address`,
    [accId, macs.map((m) => m.toLowerCase())]
  );
  return result.rowCount;
}

/**
 * The latest Mailchimp send and the latest failure for these MACs since a
 * time (the connection's start, so older "not connected" rows don't count).
 * Never returns guest emails.
 */
async function getLastSyncResults(macs, since) {
  const result = await query(`
    SELECT DISTINCT ON (success) success, error_message, created_at
      FROM sync_log
     WHERE LOWER(mac_address) = ANY($1)
       AND COALESCE(crm, 'mailchimp') = 'mailchimp'
       AND created_at >= $2
     ORDER BY success, created_at DESC
  `, [macs.map((m) => m.toLowerCase()), since]);
  const ok = result.rows.find((r) => r.success);
  const bad = result.rows.find((r) => !r.success);
  return {
    lastSentAt: ok ? ok.created_at : null,
    lastError: bad ? { message: bad.error_message, at: bad.created_at } : null,
  };
}

/** Sends and failures for these MACs since a time. */
async function countSyncs(macs, since) {
  const result = await query(`
    SELECT success, COUNT(*)::int AS n
      FROM sync_log
     WHERE LOWER(mac_address) = ANY($1)
       AND COALESCE(crm, 'mailchimp') = 'mailchimp'
       AND created_at >= $2
     GROUP BY success
  `, [macs.map((m) => m.toLowerCase()), since]);
  return {
    sent: result.rows.find((r) => r.success)?.n ?? 0,
    failed: result.rows.find((r) => !r.success)?.n ?? 0,
  };
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
 * Matches by exact, fuzzy similarity, and contains (in both directions)
 * e.g., accountName "Ma'Luz Mexican Grill" will match hospitality_group "Ma'Luz"
 *       because "Ma'Luz" is contained within "Ma'Luz Mexican Grill"
 */
async function findSitesByHospitalityGroup(groupName) {
  try {
    const result = await vivaspotQuery(`
      SELECT * FROM vivaspot_sites
      WHERE hospitality_group IS NOT NULL
        AND hospitality_group != ''
        AND (
          LOWER(hospitality_group) = LOWER($1)
          OR similarity(hospitality_group, $1) > 0.4
          OR LOWER($1) LIKE '%' || LOWER(hospitality_group) || '%'
          OR LOWER(hospitality_group) LIKE '%' || LOWER($1) || '%'
        )
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
    // 1. Exact matches — if ANY exist, return ONLY exact matches.
    // The fuzzy/contains strategies below are too loose for short, common-word
    // venue names ("Bar", "Grill", "Ave") and were polluting clean matches
    // with unrelated bars. Exact-match-wins keeps fuzzy as a safety net for
    // typos/abbreviations without letting it shadow good matches.
    const exactResult = await vivaspotQuery(`
      SELECT *, 1.0 as match_score, 'exact' as match_type
      FROM vivaspot_sites
      WHERE LOWER(restaurant_name) = LOWER($1)
    `, [restaurantName]);

    if (exactResult.rows.length > 0) {
      console.log(`Found ${exactResult.rows.length} exact site match(es) for "${restaurantName}" — skipping fuzzy/contains`);
      return exactResult.rows;
    }

    // No exact match — fall back to fuzzy + contains as a safety net.
    const matches = new Map(); // dedupe by site id

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
 * Combines email, name, and hospitality group matching strategies
 * Returns { sites: [], matchMethod: 'email'|'name'|'hospitality_group'|'none' }
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

    // Strategy 3: Try hospitality group matching
    // Useful when the Mailchimp account name is the brand name (e.g., "Ma'Luz Mexican Grill")
    // but individual sites are stored as "Ma'Luz - Location Name"
    if (accountName) {
      const groupMatches = await findSitesByHospitalityGroup(accountName);
      if (groupMatches.length > 0) {
        console.log(`Found ${groupMatches.length} site(s) by hospitality group "${accountName}"`);
        return { sites: groupMatches, matchMethod: 'hospitality_group' };
      }
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

// How long a freshly-consumed state remains queryable for idempotent retries
// (browser prefetch / safe-link scanner double-hits the callback). Long enough
// to cover a slow re-load, short enough that it doesn't change CSRF semantics.
const RECENTLY_USED_WINDOW_SECONDS = 60;

/**
 * Atomically consume a pending OAuth state by marking it consumed_at = NOW().
 *
 * Returns { row, status, ageSeconds } where status is one of:
 *   'consumed'      — first legitimate consume; `row` has the pending data
 *   'recently_used' — already consumed within RECENTLY_USED_WINDOW_SECONDS;
 *                      `row` is the original row (so the caller can render the
 *                      success page idempotently)
 *   'already_used'  — consumed longer ago than the grace window
 *   'expired'       — never consumed, but expires_at has passed
 *   'not_found'     — no such state (cleaned up or never existed)
 *
 * `ageSeconds` is the seconds since the row's most relevant timestamp:
 * `consumed_at` for *_used statuses, `expires_at` for expired, undefined otherwise.
 */
async function consumePendingOAuth(state) {
  // Try to atomically claim the row. Only succeeds if it hasn't been
  // consumed yet AND hasn't expired.
  const claim = await query(`
    UPDATE pending_oauth
    SET consumed_at = NOW()
    WHERE state = $1 AND consumed_at IS NULL AND expires_at > NOW()
    RETURNING *
  `, [state]);

  if (claim.rows[0]) {
    return { row: claim.rows[0], status: 'consumed' };
  }

  // Claim failed — classify why.
  const lookup = await query(`
    SELECT *,
           EXTRACT(EPOCH FROM (NOW() - consumed_at)) AS consumed_age_seconds,
           EXTRACT(EPOCH FROM (NOW() - expires_at)) AS expired_age_seconds
    FROM pending_oauth
    WHERE state = $1
  `, [state]);

  if (lookup.rows.length === 0) {
    return { row: null, status: 'not_found' };
  }

  const row = lookup.rows[0];

  if (row.consumed_at) {
    const age = Number(row.consumed_age_seconds);
    if (age <= RECENTLY_USED_WINDOW_SECONDS) {
      return { row, status: 'recently_used', ageSeconds: age };
    }
    return { row, status: 'already_used', ageSeconds: age };
  }

  return {
    row,
    status: 'expired',
    ageSeconds: Number(row.expired_age_seconds),
  };
}

/**
 * Clean up expired or long-consumed pending OAuth states.
 * Keeps consumed rows for 24h so we can render the idempotent success page
 * and grep logs against state_hash for that window.
 */
async function cleanupExpiredOAuth() {
  const result = await query(`
    DELETE FROM pending_oauth
    WHERE (consumed_at IS NULL AND expires_at < NOW())
       OR (consumed_at IS NOT NULL AND consumed_at < NOW() - INTERVAL '24 hours')
  `);
  return result.rowCount;
}

// =============================================================================
// Sync Log Operations (for debugging/metrics)
// =============================================================================

/**
 * Log a contact sync operation. `crm` distinguishes which downstream
 * platform this attempt was for ('mailchimp' | 'klaviyo' | future).
 * Omitted for older callers; NULL is interpreted as 'mailchimp' by the
 * activity aggregation query.
 */
async function logSync({ macAddress, email, success, errorMessage = null, crm = null }) {
  await query(`
    INSERT INTO sync_log (mac_address, email, success, error_message, crm)
    VALUES ($1, $2, $3, $4, $5)
  `, [macAddress, email, success, errorMessage, crm]);
}

/**
 * Fetch per-MAC / per-CRM sync activity for a rolling window (default 30d).
 * Returns Map<mac_address_lower, { mailchimp: {ok, err, lastAt}, klaviyo: {ok, err, lastAt} }>.
 * Missing entries mean zero activity for that MAC.
 */
async function getSyncActivityByMac(macs, sinceDays = 30) {
  const map = new Map();
  if (!macs || macs.length === 0) return map;

  const lowerMacs = macs.map((m) => String(m).toLowerCase());
  const days = Number.isFinite(sinceDays) && sinceDays > 0 ? Math.floor(sinceDays) : 30;

  const result = await query(`
    SELECT LOWER(mac_address) AS mac_address,
           COALESCE(crm, 'mailchimp') AS crm,
           success,
           COUNT(*)::int AS count,
           MAX(created_at) AS last_at
    FROM sync_log
    WHERE LOWER(mac_address) = ANY($1)
      AND created_at >= NOW() - (($2::int || ' days')::interval)
    GROUP BY LOWER(mac_address), COALESCE(crm, 'mailchimp'), success
  `, [lowerMacs, days]);

  for (const row of result.rows) {
    if (!map.has(row.mac_address)) map.set(row.mac_address, {});
    const bucket = map.get(row.mac_address);
    if (!bucket[row.crm]) bucket[row.crm] = { ok: 0, err: 0, lastAt: null };
    const slot = bucket[row.crm];
    if (row.success) slot.ok = row.count;
    else slot.err = row.count;
    if (row.last_at && (!slot.lastAt || row.last_at > slot.lastAt)) {
      slot.lastAt = row.last_at;
    }
  }
  return map;
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

/**
 * Fetch all vivaspot_sites rows with their per-site Mailchimp/Klaviyo
 * connection counts (used by the /admin/sites list page).
 * mailchimp_count = number of the site's MACs that are mapped in mailchimp_connections
 * klaviyo_count   = same for klaviyo_connections
 * connections may live in a different DB than vivaspot_sites, so this
 * fetches sites first then joins connection info in JS.
 */
async function listVivaspotSitesWithConnectionCounts() {
  const sitesResult = await vivaspotQuery(`
    SELECT id, restaurant_name, hospitality_group, mac_addresses,
           merchant_emails, created_at, updated_at
    FROM vivaspot_sites
    ORDER BY updated_at DESC NULLS LAST, restaurant_name ASC
  `);
  const sites = sitesResult.rows;

  // Collect every MAC across every site (lowercased, deduped).
  const macSet = new Set();
  for (const s of sites) {
    for (const mac of s.mac_addresses || []) {
      macSet.add(String(mac).toLowerCase());
    }
  }
  const allMacs = Array.from(macSet);
  const mailchimpMapped = new Set();
  const klaviyoMapped = new Set();
  const infobipMapped = new Set();

  if (allMacs.length > 0) {
    const mcResult = await query(
      'SELECT mac_address FROM mailchimp_connections WHERE LOWER(mac_address) = ANY($1)',
      [allMacs]
    );
    mcResult.rows.forEach((r) => mailchimpMapped.add(r.mac_address.toLowerCase()));

    const kvResult = await query(
      'SELECT mac_address FROM klaviyo_connections WHERE LOWER(mac_address) = ANY($1)',
      [allMacs]
    );
    kvResult.rows.forEach((r) => klaviyoMapped.add(r.mac_address.toLowerCase()));

    const ibResult = await query(
      'SELECT mac_address FROM infobip_connections WHERE LOWER(mac_address) = ANY($1)',
      [allMacs]
    );
    ibResult.rows.forEach((r) => infobipMapped.add(r.mac_address.toLowerCase()));
  }

  // Sync activity for a rolling 30-day window (per-MAC ok/err/lastAt per CRM).
  const activityMap = await getSyncActivityByMac(allMacs, 30);

  // Annotate each site with connection counts + rolled-up sync activity.
  for (const s of sites) {
    const macs = (s.mac_addresses || []).map((m) => String(m).toLowerCase());
    s.total_macs = macs.length;
    s.mailchimp_count = macs.filter((m) => mailchimpMapped.has(m)).length;
    s.klaviyo_count = macs.filter((m) => klaviyoMapped.has(m)).length;
    s.infobip_count = macs.filter((m) => infobipMapped.has(m)).length;

    s.activity = {
      mailchimp: { ok: 0, err: 0, lastAt: null },
      klaviyo: { ok: 0, err: 0, lastAt: null },
      infobip: { ok: 0, err: 0, lastAt: null },
    };
    for (const mac of macs) {
      const bucket = activityMap.get(mac);
      if (!bucket) continue;
      for (const crm of ['mailchimp', 'klaviyo', 'infobip']) {
        if (!bucket[crm]) continue;
        s.activity[crm].ok += bucket[crm].ok || 0;
        s.activity[crm].err += bucket[crm].err || 0;
        const cand = bucket[crm].lastAt;
        if (cand && (!s.activity[crm].lastAt || cand > s.activity[crm].lastAt)) {
          s.activity[crm].lastAt = cand;
        }
      }
    }
  }
  return sites;
}

/**
 * Normalize a MAC to lowercase XX:XX:XX:XX:XX:XX (accepts colons, dashes,
 * dots, or none). Returns null if invalid.
 */
function normalizeMacAddress(raw) {
  const clean = String(raw).replace(/[:\-.\s]/g, '').toLowerCase();
  if (clean.length !== 12 || !/^[0-9a-f]+$/.test(clean)) return null;
  return clean.match(/.{2}/g).join(':');
}

/**
 * Insert a site or append MACs/emails/hospitality_group to an existing row
 * (matched case-insensitively on restaurant_name). Returns
 *   { site, action: 'inserted' | 'updated' | 'unchanged' }.
 */
async function upsertVivaspotSite({
  restaurantName,
  hospitalityGroup,
  macAddresses = [],
  merchantEmails = [],
}) {
  const name = String(restaurantName || '').trim();
  if (!name) throw new Error('restaurant_name is required');

  const normalizedMacs = macAddresses
    .map((m) => normalizeMacAddress(m))
    .filter((m) => m !== null);
  const invalidMacs = macAddresses.filter((m) => normalizeMacAddress(m) === null);
  const normalizedEmails = merchantEmails
    .map((e) => String(e || '').toLowerCase().trim())
    .filter((e) => e.length > 0);

  const existing = await vivaspotQuery(
    'SELECT * FROM vivaspot_sites WHERE LOWER(restaurant_name) = LOWER($1) LIMIT 1',
    [name]
  );

  if (existing.rows[0]) {
    const row = existing.rows[0];
    const currentMacs = (row.mac_addresses || []).map((m) => m.toLowerCase());
    const currentEmails = (row.merchant_emails || []).map((e) => e.toLowerCase());
    const mergedMacs = Array.from(new Set([...currentMacs, ...normalizedMacs]));
    const mergedEmails = Array.from(new Set([...currentEmails, ...normalizedEmails]));

    const group = hospitalityGroup?.trim() || row.hospitality_group || null;

    const changed =
      mergedMacs.length !== currentMacs.length ||
      mergedEmails.length !== currentEmails.length ||
      group !== row.hospitality_group;

    if (!changed) return { site: row, action: 'unchanged', invalidMacs };

    const updated = await vivaspotQuery(
      `UPDATE vivaspot_sites
       SET mac_addresses = $1,
           merchant_emails = $2,
           hospitality_group = $3,
           updated_at = NOW()
       WHERE id = $4
       RETURNING *`,
      [mergedMacs, mergedEmails, group, row.id]
    );
    return { site: updated.rows[0], action: 'updated', invalidMacs };
  }

  const inserted = await vivaspotQuery(
    `INSERT INTO vivaspot_sites
       (restaurant_name, hospitality_group, merchant_emails, mac_addresses, created_at, updated_at)
     VALUES ($1, $2, $3, $4, NOW(), NOW())
     RETURNING *`,
    [name, hospitalityGroup?.trim() || null, normalizedEmails, normalizedMacs]
  );
  return { site: inserted.rows[0], action: 'inserted', invalidMacs };
}

/**
 * Delete a vivaspot_sites row by id. Returns the deleted row or null.
 */
async function deleteVivaspotSiteById(id) {
  const result = await vivaspotQuery(
    'DELETE FROM vivaspot_sites WHERE id = $1 RETURNING *',
    [id]
  );
  return result.rows[0] || null;
}

/**
 * Append an email to a vivaspot_sites row's merchant_emails (lowercased,
 * deduped). Used after a successful OAuth match to self-populate the site's
 * merchant emails so future reconnects auto-map by email cleanly without
 * relying on the looser name-fuzzy fallback. Returns true if a row was
 * actually updated (i.e. the email was new), false if already present or
 * the site doesn't exist.
 */
async function appendSiteMerchantEmail(siteId, email) {
  if (!email || !siteId) return false;
  const normalized = String(email).toLowerCase().trim();
  if (!normalized) return false;
  const result = await vivaspotQuery(`
    UPDATE vivaspot_sites
    SET merchant_emails = array_append(COALESCE(merchant_emails, ARRAY[]::text[]), $1),
        updated_at = NOW()
    WHERE id = $2
      AND NOT ($1 = ANY(COALESCE(merchant_emails, ARRAY[]::text[])))
  `, [normalized, siteId]);
  return result.rowCount > 0;
}

// =============================================================================
// Klaviyo Connection Operations
// =============================================================================

/**
 * Store a pending OAuth that carries a PKCE code_verifier (Klaviyo flow).
 * Mirrors createPendingOAuth but persists the verifier so the callback can
 * complete the token exchange.
 */
async function createPendingKlaviyoOAuth(state, macAddress, redirectUrl, codeVerifier) {
  const result = await query(`
    INSERT INTO pending_oauth (state, mac_address, redirect_url, code_verifier, expires_at)
    VALUES ($1, $2, $3, $4, NOW() + INTERVAL '10 minutes')
    RETURNING *
  `, [state, macAddress, redirectUrl, codeVerifier]);

  return result.rows[0];
}

/**
 * Create or update a Klaviyo connection for a MAC address.
 */
async function upsertKlaviyoConnection({
  macAddress,
  accessToken,
  refreshToken,
  tokenExpiresAt,
  accountId,
  accountName,
  loginEmail,
  listId,
  listName,
  sourceTag,
}) {
  const result = await query(`
    INSERT INTO klaviyo_connections (
      mac_address, access_token, refresh_token, token_expires_at,
      account_id, account_name, login_email, list_id, list_name, source_tag, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
    ON CONFLICT (mac_address)
    DO UPDATE SET
      access_token = EXCLUDED.access_token,
      refresh_token = EXCLUDED.refresh_token,
      token_expires_at = EXCLUDED.token_expires_at,
      account_id = EXCLUDED.account_id,
      account_name = EXCLUDED.account_name,
      login_email = EXCLUDED.login_email,
      list_id = EXCLUDED.list_id,
      list_name = EXCLUDED.list_name,
      source_tag = EXCLUDED.source_tag,
      updated_at = NOW()
    RETURNING *
  `, [
    macAddress, accessToken, refreshToken, tokenExpiresAt,
    accountId, accountName, loginEmail, listId, listName, sourceTag,
  ]);

  return result.rows[0];
}

/**
 * Bulk upsert Klaviyo connections (one per MAC) in a transaction.
 */
async function bulkUpsertKlaviyoConnections(connections) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const results = [];
    for (const conn of connections) {
      const result = await client.query(`
        INSERT INTO klaviyo_connections (
          mac_address, access_token, refresh_token, token_expires_at,
          account_id, account_name, login_email, list_id, list_name, source_tag, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
        ON CONFLICT (mac_address)
        DO UPDATE SET
          access_token = EXCLUDED.access_token,
          refresh_token = EXCLUDED.refresh_token,
          token_expires_at = EXCLUDED.token_expires_at,
          account_id = EXCLUDED.account_id,
          account_name = EXCLUDED.account_name,
          login_email = EXCLUDED.login_email,
          list_id = EXCLUDED.list_id,
          list_name = EXCLUDED.list_name,
          source_tag = EXCLUDED.source_tag,
          updated_at = NOW()
        RETURNING *
      `, [
        conn.macAddress, conn.accessToken, conn.refreshToken, conn.tokenExpiresAt,
        conn.accountId, conn.accountName, conn.loginEmail, conn.listId, conn.listName, conn.sourceTag,
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
 * Get Klaviyo connection by MAC address (case-insensitive).
 */
async function getKlaviyoConnectionByMac(macAddress) {
  const result = await query(
    'SELECT * FROM klaviyo_connections WHERE LOWER(mac_address) = LOWER($1)',
    [macAddress]
  );
  return result.rows[0] || null;
}

/**
 * Update stored tokens after a refresh. Updates every MAC row that shares the
 * same Klaviyo account (one OAuth install can map to many devices).
 */
async function updateKlaviyoTokens(accountId, { accessToken, refreshToken, tokenExpiresAt }) {
  const result = await query(`
    UPDATE klaviyo_connections
    SET access_token = $1,
        refresh_token = $2,
        token_expires_at = $3,
        updated_at = NOW()
    WHERE account_id = $4
    RETURNING *
  `, [accessToken, refreshToken, tokenExpiresAt, accountId]);

  return result.rows;
}

/**
 * All Klaviyo connections (admin listing).
 */
async function getAllKlaviyoConnections() {
  const result = await query(
    `SELECT id, mac_address, account_name, list_name, source_tag, token_expires_at, created_at, updated_at
     FROM klaviyo_connections ORDER BY updated_at DESC`
  );
  return result.rows;
}

/**
 * Delete a Klaviyo connection by MAC address.
 */
async function deleteKlaviyoConnection(macAddress) {
  const result = await query(
    'DELETE FROM klaviyo_connections WHERE mac_address = $1 RETURNING *',
    [macAddress]
  );
  return result.rows[0] || null;
}

/**
 * Fuzzy-match Klaviyo connections by account name (webhook auto-mapping).
 */
async function findKlaviyoConnectionsByAccountName(searchName, threshold = 0.3) {
  const result = await query(`
    SELECT *,
           similarity(account_name, $1) as match_score
    FROM klaviyo_connections
    WHERE similarity(account_name, $1) > $2
    ORDER BY match_score DESC
    LIMIT 5
  `, [searchName, threshold]);

  return result.rows;
}

// =============================================================================
// Infobip Connection Operations
// =============================================================================

async function upsertInfobipConnection({
  macAddress,
  apiKey,
  baseUrl,
  accountName,
  contactEmail,
  sourceTag,
  tagId,
}) {
  const result = await query(`
    INSERT INTO infobip_connections (
      mac_address, api_key, base_url, account_name, contact_email,
      source_tag, tag_id, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
    ON CONFLICT (mac_address)
    DO UPDATE SET
      api_key = EXCLUDED.api_key,
      base_url = EXCLUDED.base_url,
      account_name = EXCLUDED.account_name,
      contact_email = EXCLUDED.contact_email,
      source_tag = EXCLUDED.source_tag,
      tag_id = COALESCE(EXCLUDED.tag_id, infobip_connections.tag_id),
      updated_at = NOW()
    RETURNING *
  `, [macAddress, apiKey, baseUrl, accountName, contactEmail, sourceTag, tagId]);
  return result.rows[0];
}

async function getInfobipConnectionByMac(macAddress) {
  const result = await query(
    'SELECT * FROM infobip_connections WHERE LOWER(mac_address) = LOWER($1)',
    [macAddress]
  );
  return result.rows[0] || null;
}

async function getAllInfobipConnections() {
  const result = await query(
    `SELECT id, mac_address, account_name, contact_email, source_tag, tag_id,
            base_url, created_at, updated_at
     FROM infobip_connections
     ORDER BY account_name ASC, source_tag ASC`
  );
  return result.rows;
}

async function getInfobipAccountsWithCredentials() {
  // Distinct accounts with a sample of their credentials for the "add new
  // location to existing account" dropdown in the admin UI.
  const result = await query(`
    SELECT DISTINCT ON (account_name)
      account_name, api_key, base_url, contact_email
    FROM infobip_connections
    ORDER BY account_name ASC, created_at ASC
  `);
  return result.rows;
}

async function deleteInfobipConnectionById(id) {
  const result = await query(
    'DELETE FROM infobip_connections WHERE id = $1 RETURNING *',
    [id]
  );
  return result.rows[0] || null;
}

async function updateInfobipConnectionTagId(id, tagId) {
  await query(
    'UPDATE infobip_connections SET tag_id = $1, updated_at = NOW() WHERE id = $2',
    [tagId, id]
  );
}

/**
 * Rotate credentials across every row for one account (single query).
 */
async function rotateInfobipCredentials(accountName, { apiKey, baseUrl }) {
  const result = await query(
    `UPDATE infobip_connections
     SET api_key = COALESCE($1, api_key),
         base_url = COALESCE($2, base_url),
         updated_at = NOW()
     WHERE account_name = $3
     RETURNING id`,
    [apiKey || null, baseUrl || null, accountName]
  );
  return result.rowCount;
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

  // Merchant app (by VivaSpot account)
  upsertAppConnections,
  getAppConnections,
  setAppAudience,
  deleteAppConnections,
  getLastSyncResults,
  countSyncs,

  // VivaSpot Sites
  findSiteByRestaurantName,
  findSitesByHospitalityGroup,
  findSiteByEmail,
  findAllSitesByEmail,
  findAllSitesByRestaurantName,
  findCandidateSites,
  appendSiteMerchantEmail,
  listVivaspotSitesWithConnectionCounts,
  upsertVivaspotSite,
  deleteVivaspotSiteById,
  normalizeMacAddress,

  // Infobip
  upsertInfobipConnection,
  getInfobipConnectionByMac,
  getAllInfobipConnections,
  getInfobipAccountsWithCredentials,
  deleteInfobipConnectionById,
  updateInfobipConnectionTagId,
  rotateInfobipCredentials,

  // OAuth
  createPendingOAuth,
  consumePendingOAuth,
  cleanupExpiredOAuth,

  // Klaviyo
  createPendingKlaviyoOAuth,
  upsertKlaviyoConnection,
  bulkUpsertKlaviyoConnections,
  getKlaviyoConnectionByMac,
  updateKlaviyoTokens,
  getAllKlaviyoConnections,
  deleteKlaviyoConnection,
  findKlaviyoConnectionsByAccountName,

  // Sync logs
  logSync,
  getRecentSyncLogs,
  getSyncActivityByMac,
};
