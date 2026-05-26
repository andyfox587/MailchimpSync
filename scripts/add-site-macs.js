#!/usr/bin/env node
/**
 * Add (or append) MAC addresses to a vivaspot_sites row.
 *
 * Usage:
 *   node scripts/add-site-macs.js "Hill Country BBQ" \
 *     d8:b3:70:f8:a4:8b d8:b3:70:f8:be:eb d8:b3:70:f8:a4:a7 d8:b3:70:f8:a5:a7
 *
 * Optional flags (must come BEFORE the restaurant name):
 *   --email merchant@example.com          add to merchant_emails (repeatable)
 *   --group "Hospitality Group Name"      set hospitality_group on insert
 *
 * Behavior:
 *   - Looks up vivaspot_sites by case-insensitive exact match on restaurant_name.
 *   - If a row exists: appends MACs and emails (deduped), does NOT overwrite
 *     hospitality_group if it's already set.
 *   - If no row: inserts a new one with the provided fields.
 *
 * Reads VIVASPOT_DATABASE_URL (falls back to DATABASE_URL).
 */

require('dotenv').config();
const { Pool } = require('pg');

function parseArgs(argv) {
  const args = argv.slice(2);
  const emails = [];
  let group = null;
  const positional = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--email') {
      emails.push(String(args[++i] || '').toLowerCase());
    } else if (args[i] === '--group') {
      group = args[++i] || null;
    } else {
      positional.push(args[i]);
    }
  }

  const [restaurantName, ...macInputs] = positional;
  return { restaurantName, macInputs, emails, group };
}

function normalizeMac(raw) {
  const clean = String(raw).replace(/[:\-.\s]/g, '').toLowerCase();
  if (clean.length !== 12 || !/^[0-9a-f]+$/.test(clean)) {
    return null;
  }
  return clean.match(/.{2}/g).join(':');
}

async function main() {
  const { restaurantName, macInputs, emails, group } = parseArgs(process.argv);

  if (!restaurantName || macInputs.length === 0) {
    console.error('Usage: node scripts/add-site-macs.js [--email X] [--group X] "<restaurant_name>" <mac1> <mac2> ...');
    process.exit(2);
  }

  const macs = macInputs.map(normalizeMac);
  const invalid = macs.map((m, i) => (m === null ? macInputs[i] : null)).filter(Boolean);
  if (invalid.length > 0) {
    console.error('Invalid MAC addresses:', invalid);
    process.exit(2);
  }
  const validMacs = [...new Set(macs)];

  const connectionString = process.env.VIVASPOT_DATABASE_URL || process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('VIVASPOT_DATABASE_URL (or DATABASE_URL) not set');
    process.exit(2);
  }

  const pool = new Pool({
    connectionString,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const existing = await client.query(
      `SELECT id, restaurant_name, hospitality_group, mac_addresses, merchant_emails
       FROM vivaspot_sites
       WHERE LOWER(restaurant_name) = LOWER($1)
       LIMIT 1`,
      [restaurantName]
    );

    let action;
    let resultRow;

    if (existing.rows[0]) {
      const row = existing.rows[0];
      const existingMacs = Array.isArray(row.mac_addresses) ? row.mac_addresses : [];
      const existingEmails = Array.isArray(row.merchant_emails) ? row.merchant_emails : [];

      const mergedMacs = [...new Set([...existingMacs.map((m) => m.toLowerCase()), ...validMacs])];
      const mergedEmails = [...new Set([...existingEmails.map((e) => e.toLowerCase()), ...emails])];

      const updated = await client.query(
        `UPDATE vivaspot_sites
         SET mac_addresses = $1,
             merchant_emails = $2,
             updated_at = NOW()
         WHERE id = $3
         RETURNING id, restaurant_name, hospitality_group, mac_addresses, merchant_emails`,
        [mergedMacs, mergedEmails, row.id]
      );
      action = 'updated';
      resultRow = updated.rows[0];
    } else {
      const inserted = await client.query(
        `INSERT INTO vivaspot_sites
           (restaurant_name, hospitality_group, merchant_emails, mac_addresses, created_at, updated_at)
         VALUES ($1, $2, $3, $4, NOW(), NOW())
         RETURNING id, restaurant_name, hospitality_group, mac_addresses, merchant_emails`,
        [restaurantName, group, emails, validMacs]
      );
      action = 'inserted';
      resultRow = inserted.rows[0];
    }

    await client.query('COMMIT');

    console.log(JSON.stringify({
      action,
      id: resultRow.id,
      restaurant_name: resultRow.restaurant_name,
      hospitality_group: resultRow.hospitality_group,
      mac_addresses: resultRow.mac_addresses,
      merchant_emails: resultRow.merchant_emails,
    }, null, 2));
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
