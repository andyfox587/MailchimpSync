/**
 * Database Migration Script
 * 
 * Run with: npm run db:migrate
 * 
 * Creates all necessary tables and indexes for the Mailchimp integration.
 */

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' 
    ? { rejectUnauthorized: false } 
    : false,
});

const migrations = [
  // Enable pg_trgm extension for fuzzy matching
  {
    name: 'enable_pg_trgm',
    sql: `CREATE EXTENSION IF NOT EXISTS pg_trgm;`
  },
  
  // Main connections table
  {
    name: 'create_mailchimp_connections',
    sql: `
      CREATE TABLE IF NOT EXISTS mailchimp_connections (
        id SERIAL PRIMARY KEY,
        
        -- VivaSpot location identifier (unique per connection)
        mac_address VARCHAR(17) NOT NULL UNIQUE,
        
        -- Mailchimp OAuth credentials
        access_token TEXT NOT NULL,
        data_center VARCHAR(10) NOT NULL,  -- e.g., 'us6', 'us19'
        
        -- Account info (from /oauth2/metadata)
        account_id VARCHAR(50),
        account_name VARCHAR(255),
        
        -- Target audience for syncing contacts
        audience_id VARCHAR(50),
        audience_name VARCHAR(255),
        
        -- Optional tag for multi-restaurant groups
        source_tag VARCHAR(100),
        
        -- Timestamps
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `
  },
  
  // Index for fuzzy matching on account name
  {
    name: 'create_account_name_trgm_index',
    sql: `
      CREATE INDEX IF NOT EXISTS idx_mailchimp_account_name_trgm 
      ON mailchimp_connections USING gin(account_name gin_trgm_ops);
    `
  },
  
  // Index for account_id lookups
  {
    name: 'create_account_id_index',
    sql: `
      CREATE INDEX IF NOT EXISTS idx_mailchimp_account_id 
      ON mailchimp_connections(account_id);
    `
  },
  
  // Pending OAuth states (for linking MAC address through OAuth flow)
  {
    name: 'create_pending_oauth',
    sql: `
      CREATE TABLE IF NOT EXISTS pending_oauth (
        id SERIAL PRIMARY KEY,
        state VARCHAR(64) NOT NULL UNIQUE,
        mac_address VARCHAR(17) NOT NULL,
        redirect_url TEXT,
        expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `
  },
  
  // Index for state lookups
  {
    name: 'create_pending_oauth_state_index',
    sql: `
      CREATE INDEX IF NOT EXISTS idx_pending_oauth_state 
      ON pending_oauth(state);
    `
  },
  
  // Sync log for debugging and metrics
  {
    name: 'create_sync_log',
    sql: `
      CREATE TABLE IF NOT EXISTS sync_log (
        id SERIAL PRIMARY KEY,
        mac_address VARCHAR(17) NOT NULL,
        email VARCHAR(255),
        success BOOLEAN NOT NULL,
        error_message TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `
  },
  
  // Index for recent sync lookups
  {
    name: 'create_sync_log_index',
    sql: `
      CREATE INDEX IF NOT EXISTS idx_sync_log_created 
      ON sync_log(created_at DESC);
    `
  },
  
  // Auto-mapping table for hospitality groups
  {
    name: 'create_auto_mappings',
    sql: `
      CREATE TABLE IF NOT EXISTS auto_mappings (
        id SERIAL PRIMARY KEY,
        
        -- Account-level info (one entry per Mailchimp account)
        account_id VARCHAR(50) NOT NULL,
        account_name VARCHAR(255),
        data_center VARCHAR(10) NOT NULL,
        access_token TEXT NOT NULL,
        
        -- Default audience for this account
        default_audience_id VARCHAR(50),
        default_audience_name VARCHAR(255),
        
        -- Whether auto-mapping is enabled for this account
        enabled BOOLEAN DEFAULT true,
        
        -- Timestamps
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        
        UNIQUE(account_id)
      );
    `
  },
  
  // Index for auto-mapping lookups
  {
    name: 'create_auto_mappings_index',
    sql: `
      CREATE INDEX IF NOT EXISTS idx_auto_mappings_account_name_trgm 
      ON auto_mappings USING gin(account_name gin_trgm_ops);
    `
  },
  
  // Fix: Ensure redirect_url can hold JSON data with tokens
  {
    name: 'alter_pending_oauth_redirect_url',
    sql: `
      ALTER TABLE pending_oauth 
      ALTER COLUMN redirect_url TYPE TEXT;
    `
  },
  
  // Fix: Ensure account_name can hold long names
  {
    name: 'alter_connections_account_name',
    sql: `
      ALTER TABLE mailchimp_connections 
      ALTER COLUMN account_name TYPE TEXT;
    `
  },
  
  // Fix: Ensure audience_name can hold long names
  {
    name: 'alter_connections_audience_name',
    sql: `
      ALTER TABLE mailchimp_connections
      ALTER COLUMN audience_name TYPE TEXT;
    `
  },

  // Track state consumption (soft-delete) so we can distinguish
  // recently-used / expired / not-found in the callback error page.
  {
    name: 'add_pending_oauth_consumed_at',
    sql: `
      ALTER TABLE pending_oauth
      ADD COLUMN IF NOT EXISTS consumed_at TIMESTAMP WITH TIME ZONE;
    `
  },

  // Index to make the "did we recently consume this state?" lookup cheap
  {
    name: 'create_pending_oauth_consumed_at_index',
    sql: `
      CREATE INDEX IF NOT EXISTS idx_pending_oauth_consumed_at
      ON pending_oauth(consumed_at);
    `
  },

  // PKCE code_verifier for the Klaviyo OAuth flow (Klaviyo requires PKCE).
  // Nullable so the existing Mailchimp flow is unaffected.
  {
    name: 'add_pending_oauth_code_verifier',
    sql: `
      ALTER TABLE pending_oauth
      ADD COLUMN IF NOT EXISTS code_verifier TEXT;
    `
  },

  // Klaviyo connections — parallel to mailchimp_connections, but Klaviyo
  // access tokens expire (~1h) so we also store a refresh token and expiry.
  {
    name: 'create_klaviyo_connections',
    sql: `
      CREATE TABLE IF NOT EXISTS klaviyo_connections (
        id SERIAL PRIMARY KEY,

        -- VivaSpot location identifier (unique per connection)
        mac_address VARCHAR(17) NOT NULL UNIQUE,

        -- Klaviyo OAuth credentials
        access_token TEXT NOT NULL,
        refresh_token TEXT NOT NULL,
        token_expires_at TIMESTAMP WITH TIME ZONE NOT NULL,

        -- Klaviyo account info (from GET /api/accounts)
        account_id VARCHAR(50),
        account_name TEXT,
        login_email VARCHAR(255),

        -- Target list for syncing contacts
        list_id VARCHAR(50),
        list_name TEXT,

        -- Optional tag for multi-restaurant groups (sent as custom_source)
        source_tag VARCHAR(100),

        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `
  },

  // Fuzzy match on Klaviyo account name (used for webhook auto-mapping)
  {
    name: 'create_klaviyo_account_name_trgm_index',
    sql: `
      CREATE INDEX IF NOT EXISTS idx_klaviyo_account_name_trgm
      ON klaviyo_connections USING gin(account_name gin_trgm_ops);
    `
  },

  // Account ID lookups
  {
    name: 'create_klaviyo_account_id_index',
    sql: `
      CREATE INDEX IF NOT EXISTS idx_klaviyo_account_id
      ON klaviyo_connections(account_id);
    `
  }
];

async function runMigrations() {
  console.log('Starting database migrations...\n');
  
  const client = await pool.connect();
  
  try {
    for (const migration of migrations) {
      console.log(`Running: ${migration.name}`);
      await client.query(migration.sql);
      console.log(`  ✓ Complete\n`);
    }
    
    console.log('All migrations completed successfully!');
    
    // Show table info
    const tablesResult = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      ORDER BY table_name
    `);
    
    console.log('\nTables created:');
    tablesResult.rows.forEach(row => {
      console.log(`  - ${row.table_name}`);
    });
    
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

runMigrations();
