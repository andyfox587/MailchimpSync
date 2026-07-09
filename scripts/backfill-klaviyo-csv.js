#!/usr/bin/env node
/**
 * Backfill a CSV of historical WiFi captures through the Klaviyo webhook.
 *
 * Usage:
 *   node scripts/backfill-klaviyo-csv.js path/to/emails.csv \
 *     --mac 74:83:c2:23:88:e3 \
 *     --location "Mission Ave Bar and Grill" \
 *     [--url https://integrations.vivaspot.com/klaviyo/webhook/contact] \
 *     [--dry-run] \
 *     [--limit N] \
 *     [--start-at N] \
 *     [--rate 5]        # requests per second, default 5
 *
 * CSV format (from Mission Ave export):
 *   Column 1: Email
 *   Column 2: Timestamp
 *   Column 3: First name
 *   Columns 4+: ignored (the sheet has a separate frequency table on the right)
 *
 * Behavior:
 *   - Dedupes by email (case-insensitive, first row wins for first_name)
 *   - Skips rows with invalid emails
 *   - Rate-limits to `--rate` req/sec (default 5) so we do not hit Klaviyo bursts
 *   - Prints ✓/✗ per record and a summary at the end
 *   - --dry-run does everything except the actual POST
 */

const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {
    csvPath: null,
    mac: null,
    location: 'Mission Ave Bar and Grill',
    url: 'https://integrations.vivaspot.com/klaviyo/webhook/contact',
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
  if (!opts.csvPath || !opts.mac) {
    console.error('Usage: node backfill-klaviyo-csv.js <csv> --mac <mac> [--location ...] [--dry-run] [--limit N]');
    process.exit(2);
  }
  return opts;
}

// Naive CSV row splitter — the Mission Ave export doesn't quote values,
// so simple comma-split is safe. If you get an export with quoted fields,
// swap this for `csv-parse`.
function splitCsvLine(line) {
  return line.split(',');
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function parseCsv(csvPath) {
  const text = fs.readFileSync(csvPath, 'utf8');
  const lines = text.split(/\r?\n/);
  const records = [];
  const seen = new Set();
  let skippedInvalid = 0;
  let skippedDup = 0;

  // Skip header (line 0). Real data starts on line 1.
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    const cols = splitCsvLine(line);
    const email = String(cols[0] || '').trim().toLowerCase();
    const firstName = String(cols[2] || '').trim();
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
    records.push({ email, firstName });
  }
  return { records, skippedInvalid, skippedDup };
}

async function pushOne(url, mac, location, source, record) {
  const body = {
    mac_address: mac,
    email: record.email,
    first_name: record.firstName || undefined,
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
  console.log(`Parsed CSV: ${records.length} unique emails (skipped ${skippedInvalid} invalid, ${skippedDup} duplicates)`);

  let slice = records.slice(opts.startAt);
  if (opts.limit) slice = slice.slice(0, opts.limit);
  console.log(`Will process ${slice.length} record(s)${opts.dryRun ? ' [DRY RUN — no POST will happen]' : ''}`);
  console.log();

  const delayMs = Math.max(0, Math.floor(1000 / (opts.rate || 5)));
  let ok = 0, fail = 0;
  const failures = [];
  const listCounts = new Map();
  const accountCounts = new Map();

  for (let i = 0; i < slice.length; i++) {
    const r = slice[i];
    const label = `${(opts.startAt + i + 1).toString().padStart(4, ' ')}/${records.length}`;
    if (opts.dryRun) {
      console.log(`  ${label}  DRY ${r.email} (${r.firstName || ''})`);
      ok++;
      continue;
    }
    try {
      const { status, data } = await pushOne(opts.url, opts.mac, opts.location, opts.source, r);
      if (status === 200 && data.success) {
        ok++;
        const list = data.list || '(unnamed)';
        const account = data.account || '(unknown)';
        listCounts.set(list, (listCounts.get(list) || 0) + 1);
        accountCounts.set(account, (accountCounts.get(account) || 0) + 1);
        console.log(`  ${label}  ✓  ${r.email}  →  ${account} / ${list}`);
      } else {
        fail++;
        failures.push({ email: r.email, status, data });
        console.log(`  ${label}  ✗  ${r.email}  status=${status}  ${JSON.stringify(data).slice(0, 200)}`);
      }
    } catch (e) {
      fail++;
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
  console.log(`  Success: ${ok}`);
  console.log(`  Failed:  ${fail}`);
  if (accountCounts.size > 0) {
    console.log('  By account:');
    for (const [k, v] of accountCounts) console.log(`    ${k}: ${v}`);
  }
  if (listCounts.size > 0) {
    console.log('  By list:');
    for (const [k, v] of listCounts) console.log(`    "${k}": ${v}`);
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
