/**
 * Admin Infobip Console (mounted at /admin/infobip)
 *
 * CRUD panel for infobip_connections rows. Same HTTP Basic Auth as
 * /admin/sites (password = ADMIN_API_KEY).
 *
 * Two flows:
 *   1. Add a NEW customer (fresh account_name + credentials + one location)
 *   2. Add a NEW LOCATION for an EXISTING customer (dropdown picks the
 *      account_name; credentials get auto-filled from an existing row)
 */

const express = require('express');
const router = express.Router();
const db = require('../db');
const infobip = require('../services/infobip');

function basicAuth(req, res, next) {
  const expected = process.env.ADMIN_API_KEY;
  if (!expected) return res.status(500).send('ADMIN_API_KEY is not configured on the server.');
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="VivaSpot Admin"');
    return res.status(401).send('Authentication required.');
  }
  let decoded;
  try { decoded = Buffer.from(header.slice(6), 'base64').toString('utf8'); }
  catch { res.set('WWW-Authenticate', 'Basic realm="VivaSpot Admin"'); return res.status(401).send('Invalid credentials.'); }
  const idx = decoded.indexOf(':');
  const password = idx >= 0 ? decoded.slice(idx + 1) : '';
  if (password !== expected) {
    res.set('WWW-Authenticate', 'Basic realm="VivaSpot Admin"');
    return res.status(401).send('Invalid credentials.');
  }
  next();
}

router.use(basicAuth);
router.use(express.urlencoded({ extended: true }));

function escapeHtml(v) {
  return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function maskKey(key) {
  if (!key) return '';
  const s = String(key);
  if (s.length <= 12) return '••••';
  return s.slice(0, 4) + '••••••••••' + s.slice(-4);
}

function normalizeMac(raw) {
  return db.normalizeMacAddress(raw);
}

function renderPage(connections, accounts, flash) {
  const flashBanner = flash
    ? `<div style="background:${flash.error ? '#f8d7da' : '#d4edda'};color:${flash.error ? '#721c24' : '#155724'};padding:10px 15px;border-radius:6px;margin-bottom:15px;">${escapeHtml(flash.message)}</div>`
    : '';

  const rows = connections
    .map((c) => `
      <tr>
        <td><strong>${escapeHtml(c.account_name)}</strong></td>
        <td>${escapeHtml(c.source_tag || '')}<div style="color:#666;font-size:12px;">${escapeHtml(c.contact_email || '')}</div></td>
        <td style="font-family:monospace;font-size:12px;">${escapeHtml(c.mac_address)}</td>
        <td style="font-family:monospace;font-size:12px;">${escapeHtml(c.base_url)}</td>
        <td>${c.tag_id ? `<span style="background:#d4edda;color:#155724;padding:2px 8px;border-radius:12px;font-size:12px;">tag #${c.tag_id}</span>` : `<span style="background:#fff3cd;color:#856404;padding:2px 8px;border-radius:12px;font-size:12px;">not yet resolved</span>`}</td>
        <td>
          <form method="POST" action="/admin/infobip/${c.id}/test" style="margin:0;display:inline;">
            <button type="submit" style="background:#6c757d;color:#fff;border:none;padding:4px 10px;border-radius:4px;cursor:pointer;font-size:12px;">Test</button>
          </form>
          <form method="POST" action="/admin/infobip/${c.id}/delete" onsubmit="return confirm('Delete Infobip connection for MAC ${escapeHtml(c.mac_address)}?');" style="margin:0;display:inline;">
            <button type="submit" style="background:#dc3545;color:#fff;border:none;padding:4px 10px;border-radius:4px;cursor:pointer;font-size:12px;margin-left:4px;">Delete</button>
          </form>
        </td>
      </tr>`)
    .join('');

  const accountDatalist = accounts
    .map((a) => `<option value="${escapeHtml(a.account_name)}">`)
    .join('');

  const existingAccountsSummary = accounts.length > 0
    ? `<div class="help">Existing customers: ${accounts.map((a) => `<code>${escapeHtml(a.account_name)}</code>`).join(' · ')} &nbsp;— type one of those in the Account field to reuse its stored credentials.</div>`
    : `<div class="help">No customers yet.</div>`;

  return `<!doctype html>
<html>
<head>
  <title>VivaSpot Infobip Admin</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; max-width: 1300px; margin: 30px auto; padding: 0 20px; color: #222; background:#f5f5f5; }
    h1 { margin: 0 0 4px 0; }
    .sub { color:#666; margin-bottom: 20px; font-size: 14px; }
    .card { background:#fff; padding: 20px; border-radius: 8px; box-shadow: 0 1px 4px rgba(0,0,0,0.08); margin-bottom: 20px; }
    fieldset { border:1px solid #ddd; border-radius:6px; padding: 15px; }
    legend { padding: 0 8px; font-weight: 600; }
    label { display:block; margin: 10px 0 4px 0; font-weight:500; font-size:14px; }
    input[type=text], input[type=password], input[type=email], select { width:100%; padding:8px; border:1px solid #ccc; border-radius:4px; box-sizing:border-box; font-family:inherit; font-size:14px; }
    .help { color:#666; font-size:12px; margin-top:4px; }
    .help code { background:#eef; padding:1px 4px; border-radius:3px; font-size:12px; }
    button.primary { background:#007bff; color:#fff; border:none; padding:10px 24px; border-radius:4px; cursor:pointer; font-size:15px; margin-top:15px; }
    button.primary:hover { background:#0056b3; }
    table { width:100%; border-collapse: collapse; font-size:14px; }
    th { text-align:left; padding:10px; background:#fafafa; border-bottom:2px solid #eee; font-size:12px; text-transform:uppercase; color:#666; letter-spacing:0.5px; }
    td { padding:10px; border-bottom:1px solid #eee; vertical-align: top; }
    tr:hover td { background:#fafafa; }
    .search { margin-bottom: 15px; }
    .search input { max-width:400px; }
    .grid { display:grid; grid-template-columns: 1fr 1fr; gap:15px; }
    @media (max-width: 700px) { .grid { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <h1>Infobip Admin</h1>
  <div class="sub"><a href="/admin/sites">/admin/sites</a> &nbsp;·&nbsp; This page manages <code>infobip_connections</code>. Each row = one AP MAC.</div>

  ${flashBanner}

  <div class="card">
    <fieldset>
      <legend>Add a Connection</legend>
      <p style="color:#666;font-size:13px;margin:0 0 10px 0;">
        Adds one AP MAC as a new Infobip connection. If the Account Name matches an existing customer, the API key + base URL are reused automatically — you only need to fill in the Location Tag and MAC.
      </p>

      <form method="POST" action="/admin/infobip">
        <label>Account Name <span style="color:#c00">*</span></label>
        <input type="text" name="account_name" list="accounts-list" required placeholder="Roggenart" autocomplete="off">
        <datalist id="accounts-list">${accountDatalist}</datalist>
        ${existingAccountsSummary}

        <div class="grid">
          <div>
            <label>Location Tag <span style="color:#c00">*</span></label>
            <input type="text" name="source_tag" required placeholder="Roggenart - Baltimore" autocomplete="off">
            <div class="help">Per-venue tag. Created in Infobip if it doesn't exist.</div>
          </div>
          <div>
            <label>Device MAC Address <span style="color:#c00">*</span></label>
            <input type="text" name="mac_address" required placeholder="00:18:0a:26:c3:cc" autocomplete="off">
            <div class="help">Colons, dashes, dots, or none — normalized.</div>
          </div>
        </div>

        <fieldset style="margin-top:15px;padding:12px;background:#fafafa;">
          <legend style="font-size:13px;color:#666;">Credentials <span style="font-weight:400;">— only required for a NEW customer; leave blank to reuse for existing.</span></legend>

          <div class="grid">
            <div>
              <label>Contact Email</label>
              <input type="email" name="contact_email" placeholder="andy@roggenart.com" autocomplete="off">
            </div>
            <div>
              <label>Infobip Base URL</label>
              <input type="text" name="base_url" placeholder="e53je3.api-us.infobip.com" autocomplete="off">
            </div>
          </div>

          <label>Infobip API Key</label>
          <input type="password" name="api_key" autocomplete="new-password" placeholder="8c63b3819c3897c83c97cf...">
          <div class="help">Sent as <code>Authorization: App &lt;key&gt;</code>. Reused from existing account if left blank.</div>
        </fieldset>

        <button type="submit" class="primary">Save Connection</button>
      </form>
    </fieldset>
  </div>

  <div class="card">
    <h2 style="margin-top:0;">Connections (${connections.length})</h2>
    <div class="search"><input id="conn-filter" type="text" placeholder="Filter by name, tag, MAC, email..." oninput="filterConns(this.value)"></div>
    <div style="overflow-x:auto;">
      <table>
        <thead>
          <tr><th>Account</th><th>Location / Contact</th><th>MAC</th><th>Base URL</th><th>Tag</th><th></th></tr>
        </thead>
        <tbody id="conn-rows">
          ${rows || `<tr><td colspan="6" style="text-align:center;color:#999;padding:30px;">No connections yet. Add one above.</td></tr>`}
        </tbody>
      </table>
    </div>
  </div>

  <script>
    function filterConns(q) {
      q = q.toLowerCase().trim();
      const rows = document.querySelectorAll('#conn-rows tr');
      rows.forEach(r => {
        r.style.display = !q || r.textContent.toLowerCase().includes(q) ? '' : 'none';
      });
    }
  </script>
</body>
</html>`;
}

router.get('/', async (req, res) => {
  try {
    const [connections, accounts] = await Promise.all([
      db.getAllInfobipConnections(),
      db.getInfobipAccountsWithCredentials(),
    ]);
    const flash = req.query.flash ? { message: req.query.flash, error: req.query.err === '1' } : null;
    res.send(renderPage(connections, accounts, flash));
  } catch (error) {
    console.error('admin-infobip list error:', error);
    res.status(500).send(`<pre>Error: ${escapeHtml(error.message)}</pre>`);
  }
});

router.post('/', async (req, res) => {
  try {
    const rawAccount = String(req.body.account_name || '').trim();
    const rawTag = String(req.body.source_tag || '').trim();
    const rawMac = String(req.body.mac_address || '').trim();
    const rawEmail = String(req.body.contact_email || '').trim();
    const rawKey = String(req.body.api_key || '').trim();
    const rawBase = String(req.body.base_url || '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');

    if (!rawAccount) return res.redirect(`/admin/infobip?err=1&flash=${encodeURIComponent('Account Name is required.')}`);
    if (!rawTag) return res.redirect(`/admin/infobip?err=1&flash=${encodeURIComponent('Location Tag is required.')}`);
    const mac = normalizeMac(rawMac);
    if (!mac) return res.redirect(`/admin/infobip?err=1&flash=${encodeURIComponent(`Invalid MAC: ${rawMac || '(empty)'}`)}`);

    // Determine credentials: reuse from existing account rows if fields are blank.
    let accountName = rawAccount;
    let apiKey = rawKey;
    let baseUrl = rawBase;
    let contactEmail = rawEmail || null;

    if (!apiKey || !baseUrl) {
      const rows = await db.getInfobipAccountsWithCredentials();
      const acct = rows.find((r) => r.account_name.toLowerCase() === rawAccount.toLowerCase());
      if (acct) {
        // Match found — reuse (and canonicalize the account_name spelling)
        accountName = acct.account_name;
        apiKey = apiKey || acct.api_key;
        baseUrl = baseUrl || acct.base_url;
        contactEmail = contactEmail || acct.contact_email;
      }
    }

    if (!apiKey || !baseUrl) {
      return res.redirect(`/admin/infobip?err=1&flash=${encodeURIComponent(
        `Account "${rawAccount}" is new — API Key and Base URL are required.`
      )}`);
    }

    // Check MAC collision before writing so we don't silently overwrite.
    const existing = await db.getInfobipConnectionByMac(mac);
    if (existing) {
      return res.redirect(`/admin/infobip?err=1&flash=${encodeURIComponent(
        `MAC ${mac} is already assigned to "${existing.account_name} / ${existing.source_tag}". Delete that row first if you want to reassign.`
      )}`);
    }

    const saved = await db.upsertInfobipConnection({
      macAddress: mac,
      apiKey,
      baseUrl,
      accountName,
      contactEmail,
      sourceTag: rawTag,
      tagId: null,
    });

    // Best-effort tag resolve/create so tag_id is cached before first sync.
    let tagId = null;
    try {
      tagId = await infobip.findOrCreateTagId(apiKey, baseUrl, rawTag);
      if (tagId) await db.updateInfobipConnectionTagId(saved.id, tagId);
    } catch (e) {
      console.warn('Infobip tag resolve at admin save failed:', e.message);
    }

    res.redirect(`/admin/infobip?flash=${encodeURIComponent(
      `Saved ${accountName} — ${rawTag} (${mac})${tagId ? ` [tag #${tagId}]` : ''}.`
    )}`);
  } catch (error) {
    console.error('admin-infobip upsert error:', error);
    res.redirect(`/admin/infobip?err=1&flash=${encodeURIComponent(error.message || 'Failed to save')}`);
  }
});

router.post('/:id/delete', async (req, res) => {
  try {
    const deleted = await db.deleteInfobipConnectionById(req.params.id);
    if (!deleted) return res.redirect(`/admin/infobip?err=1&flash=${encodeURIComponent('Not found')}`);
    res.redirect(`/admin/infobip?flash=${encodeURIComponent(`Deleted ${deleted.account_name} — ${deleted.source_tag}.`)}`);
  } catch (error) {
    res.redirect(`/admin/infobip?err=1&flash=${encodeURIComponent(error.message)}`);
  }
});

router.post('/:id/test', async (req, res) => {
  try {
    const rows = await db.getAllInfobipConnections();
    const c = rows.find((x) => String(x.id) === String(req.params.id));
    if (!c) return res.redirect(`/admin/infobip?err=1&flash=${encodeURIComponent('Not found')}`);
    // Full record needed for api_key (getAllInfobipConnections omits it for display)
    const full = await db.getInfobipConnectionByMac(c.mac_address);
    const ok = await infobip.pingAccount(full.api_key, full.base_url);
    res.redirect(`/admin/infobip?${ok ? '' : 'err=1&'}flash=${encodeURIComponent(`${c.account_name} — ${c.source_tag}: ${ok ? 'connection OK ✓' : 'connection failed ✗'}`)}`);
  } catch (error) {
    res.redirect(`/admin/infobip?err=1&flash=${encodeURIComponent(error.message)}`);
  }
});

module.exports = router;
