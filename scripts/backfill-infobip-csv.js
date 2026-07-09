#!/usr/bin/env node
/**
 * Backfill a CSV of historical WiFi captures through the Infobip webhook.
 *
 * Usage:
 *   node scripts/backfill-infobip-csv.js path/to/emails.csv \
 *     --mac 00:18:0a:26:c3:cc \
 *     --location "Roggenart - Baltimore" \
 *     [--url https://integrations.vivaspot.com/infobip/webhook/contact] \
 *     [--source "Historical Backfill 2026-06_to_2026-07"] \
 *     [--dry-run] [--limit N] [--start-at N] [--rate 5]
 *
 * CSV format (Roggenart export):
 *   Column 1: Email
 *   Column 2: Timestamp
 *   Column 3: First name (may have trailing spaces)
 *   Column 4: Phone number (occasionally populated)
 *   Columns 5+: ignored (the sheet has a frequency table on the right)
 *
 * Duplicate emails within the same CSV are deduped (first row wins for
 * first_name/phone). Duplicate emails that already exist in Infobip come
 * back as `status: already_exists` — that's counted as a success, not a
 * failure, since the person is already in the CRM.
 */

const fs = require('fs');

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {
    csvPath: null,
    mac: null,
    location: null,
    url: 'https://integrations.vivaspot.com/infobip/webhook/contact',
    dryRun: false,
    limit: null,
    startAt: 0,
    rate: 5,
    source: 'Historical Backfill',
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--mac') opts.mac = args[++i];
    else if (a === '--location') opts.location = args[++i];
    else if (a === '--url') opts.url = args[++i];
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--limit') opts.limit = parseInt(args[++i], 10);
    else if (a === '--start-at') opts.startAt = parseInt(args[++i], 10);
    else if (a === '--rate') opts.rate = parseFloat(args[++i]);
    else if (a === '--source') opts.source = args[++i];
    else if (!a.startsWith('--') && !opts.csvPath) opts.csvPath = a;
    else {
      console.error('Unknown arg:', a);
      process.exit(2);
    }
  }
  if (!opts.csvPath || !opts.mac || !opts.location) {
    console.error('Usage: node backfill-infobip-csv.js <csv> --mac <mac> --location "<Location Tag>" [--dry-run] [--limit N]');
    process.exit(2);
  }
  return opts;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function splitCsvLine(line) {
  return line.split(',');
}

function parseCsv(csvPath) {
  const text = fs.readFileSync(csvPath, 'utf8');
  const lines = text.split(/\r?\n/);
  const records = [];
  const seen = new Set();
  let skippedInvalid = 0;
  let skippedDup = 0;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    const cols = splitCsvLine(line);
    const email = String(cols[0] || '').trim().toLowerCase();
    const firstName = String(cols[2] || '').trim();
    const phone = String(cols[3] || '').trim();
    if (!email) {
      skippedInvalid++;
      continue;
    }
    if (!EMAIL_RE.test(email)) {
      skippedInvalid++;
      continue;
    }
    if (seen.has(email)) {
      skippedDup++;
      continue;
    }
    seen.add(email);
    records.push({ email, firstName, phone });
  }
  return { records, skippedInvalid, skippedDup };
}

async function pushOne(url, mac, location, source, record) {
  const body = {
    mac_address: mac,
    email: record.email,
    first_name: record.firstName || undefined,
    phone: record.phone || undefined,
    source: source,
    location_name: location,
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { status: res.status, data };
}

async function main() {
  const opts = parseArgs(process.argv);
  console.log('Config:', {
    csv: opts.csvPath,
    mac: opts.mac,
    location: opts.location,
    url: opts.url,
    dryRun: opts.dryRun,
    limit: opts.limit,
    startAt: opts.startAt,
    rate: opts.rate,
  });
  console.log();

  const { records, skippedInvalid, skippedDup } = parseCsv(opts.csvPath);
  console.log(`Parsed CSV: ${records.length} unique emails (skipped ${skippedInvalid} invalid, ${skippedDup} in-CSV duplicates)`);

  let slice = records.slice(opts.startAt);
  if (opts.limit) slice = slice.slice(0, opts.limit);
  console.log(`Will process ${slice.length} record(s)${opts.dryRun ? ' [DRY RUN — no POST]' : ''}`);
  console.log();

  const delayMs = Math.max(0, Math.floor(1000 / (opts.rate || 5)));
  let created = 0;
  let alreadyExists = 0;
  let failed = 0;
  const failures = [];
  const tagCounts = new Map();

  for (let i = 0; i < slice.length; i++) {
    const r = slice[i];
    const label = `${(opts.startAt + i + 1).toString().padStart(4, ' ')}/${records.length}`;
    if (opts.dryRun) {
      console.log(`  ${label}  DRY ${r.email} (${r.firstName || ''}${r.phone ? ' · ' + r.phone : ''})`);
      created++;
      continue;
    }
    try {
      const { status, data } = await pushOne(opts.url, opts.mac, opts.location, opts.source, r);
      if (status === 200 && data.success) {
        const s = data.status || 'created';
        if (s === 'already_exists') {
          alreadyExists++;
          console.log(`  ${label}  ⤳  ${r.email}  already in Infobip`);
        } else {
          created++;
          console.log(`  ${label}  ✓  ${r.email}  →  ${data.account || '?'} / ${data.tag || '?'}${data.person_id ? ' [id ' + data.person_id + ']' : ''}`);
        }
        const tag = data.tag || '(untagged)';
        tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
      } else {
        failed++;
        failures.push({ email: r.email, status, data });
        console.log(`  ${label}  ✗  ${r.email}  status=${status}  ${JSON.stringify(data).slice(0, 200)}`);
      }
    } catch (e) {
      failed++;
      failures.push({ email: r.email, error: e.message });
      console.log(`  ${label}  ✗  ${r.email}  ERR ${e.message}`);
    }
    if (delayMs > 0 && i < slice.length - 1) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  console.log();
  console.log('=== Summary ===');
  console.log(`  Total processed: ${slice.length}`);
  console.log(`  Created new:     ${created}`);
  console.log(`  Already existed: ${alreadyExists}`);
  console.log(`  Failed:          ${failed}`);
  if (tagCounts.size > 0) {
    console.log('  By tag:');
    for (const [k, v] of tagCounts) console.log(`    "${k}": ${v}`);
  }
  if (failures.length > 0 && failures.length <= 10) {
    console.log('  Failures:');
    for (const f of failures) console.log('    -', JSON.stringify(f).slice(0, 200));
  }
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
