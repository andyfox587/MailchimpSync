/**
 * Admin Sites UI  (mounted at /admin/sites)
 *
 * A minimal HTML admin console for managing rows in vivaspot_sites without
 * SSHing into Render Shell. Adds/updates by exact restaurant_name, shows
 * per-site Mailchimp/Klaviyo connection status, supports delete.
 *
 * Auth: HTTP Basic Auth. Any username (browser will prompt), password is
 * ADMIN_API_KEY from env. No password = no access.
 */

const express = require('express');
const router = express.Router();
const db = require('../db');

// =============================================================================
// HTTP Basic Auth middleware
// =============================================================================

function basicAuth(req, res, next) {
  const expected = process.env.ADMIN_API_KEY;
  if (!expected) {
    return res
      .status(500)
      .send('ADMIN_API_KEY is not configured on the server.');
  }

  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="VivaSpot Admin"');
    return res.status(401).send('Authentication required.');
  }

  let decoded;
  try {
    decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  } catch {
    res.set('WWW-Authenticate', 'Basic realm="VivaSpot Admin"');
    return res.status(401).send('Invalid credentials.');
  }

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

// =============================================================================
// Small HTML helpers
// =============================================================================

function escapeHtml(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderBadge(mapped, total, label) {
  if (total === 0) {
    return `<span style="background:#eee;color:#666;padding:2px 8px;border-radius:12px;font-size:12px;">no MACs</span>`;
  }
  if (mapped === 0) {
    return `<span style="background:#fee;color:#a00;padding:2px 8px;border-radius:12px;font-size:12px;">${label} 0/${total}</span>`;
  }
  if (mapped < total) {
    return `<span style="background:#fff3cd;color:#856404;padding:2px 8px;border-radius:12px;font-size:12px;">${label} ${mapped}/${total}</span>`;
  }
  return `<span style="background:#d4edda;color:#155724;padding:2px 8px;border-radius:12px;font-size:12px;">${label} ${mapped}/${total}</span>`;
}

/**
 * Compact relative-time string. Same-shape as GitHub / Slack.
 */
function relativeTime(dateStr) {
  if (!dateStr) return 'never';
  const then = new Date(dateStr).getTime();
  const now = Date.now();
  const diff = Math.max(0, (now - then) / 1000);
  if (diff < 60) return `${Math.floor(diff)}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

/**
 * A single CRM cell = connection badge + rolling-30d activity counters.
 * `activity` is { ok, err, lastAt } from listVivaspotSitesWithConnectionCounts.
 */
function renderCrmCell(mapped, total, label, activity) {
  const badge = renderBadge(mapped, total, label);
  const ok = activity?.ok || 0;
  const err = activity?.err || 0;
  const lastAt = activity?.lastAt || null;

  if (ok === 0 && err === 0) {
    return `${badge}<div style="color:#999;font-size:11px;margin-top:4px;">no activity (30d)</div>`;
  }

  const okStr = `<span style="color:#155724;">${ok.toLocaleString()}&nbsp;✓</span>`;
  const errStr = err > 0 ? ` &nbsp;<span style="color:#a00;">${err.toLocaleString()}&nbsp;✗</span>` : '';
  return `${badge}<div style="font-size:12px;margin-top:4px;">${okStr}${errStr}</div><div style="color:#999;font-size:11px;">last ${relativeTime(lastAt)}</div>`;
}

function renderList(sites, flash) {
  const rows = sites
    .map((s) => {
      const macs = (s.mac_addresses || []).join(', ');
      const emails = (s.merchant_emails || []).join(', ');
      return `
        <tr>
          <td><strong>${escapeHtml(s.restaurant_name)}</strong>
              <div style="color:#666;font-size:12px;">id ${s.id} · updated ${s.updated_at ? new Date(s.updated_at).toISOString().slice(0, 10) : '—'}</div>
          </td>
          <td>${escapeHtml(s.hospitality_group || '')}</td>
          <td style="font-size:12px;">${escapeHtml(emails)}</td>
          <td style="font-family:monospace;font-size:11px;">${escapeHtml(macs)}</td>
          <td>${renderCrmCell(s.mailchimp_count || 0, s.total_macs || 0, 'MC', s.activity?.mailchimp)}</td>
          <td>${renderCrmCell(s.klaviyo_count || 0, s.total_macs || 0, 'KV', s.activity?.klaviyo)}</td>
          <td>
            <form method="POST" action="/admin/sites/${s.id}/delete" onsubmit="return confirm('Delete ${escapeHtml(s.restaurant_name).replace(/'/g, "\\'")}? This does not disconnect Mailchimp/Klaviyo.');" style="margin:0;">
              <button type="submit" style="background:#dc3545;color:#fff;border:none;padding:4px 10px;border-radius:4px;cursor:pointer;font-size:12px;">Delete</button>
            </form>
          </td>
        </tr>`;
    })
    .join('');

  const flashBanner = flash
    ? `<div style="background:${flash.error ? '#f8d7da' : '#d4edda'};color:${flash.error ? '#721c24' : '#155724'};padding:10px 15px;border-radius:6px;margin-bottom:15px;">${escapeHtml(flash.message)}</div>`
    : '';

  return `<!doctype html>
<html>
<head>
  <title>VivaSpot Sites Admin</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; max-width: 1300px; margin: 30px auto; padding: 0 20px; color: #222; background:#f5f5f5; }
    h1 { margin: 0 0 4px 0; }
    .sub { color:#666; margin-bottom: 20px; font-size: 14px; }
    .card { background:#fff; padding: 20px; border-radius: 8px; box-shadow: 0 1px 4px rgba(0,0,0,0.08); margin-bottom: 20px; }
    fieldset { border:1px solid #ddd; border-radius:6px; padding: 15px; }
    legend { padding: 0 8px; font-weight: 600; }
    label { display:block; margin: 10px 0 4px 0; font-weight:500; font-size:14px; }
    input[type=text], textarea, input:not([type]) { width:100%; padding:8px; border:1px solid #ccc; border-radius:4px; box-sizing:border-box; font-family:inherit; font-size:14px; }
    textarea { min-height:60px; font-family: "SF Mono", Menlo, monospace; }
    .help { color:#666; font-size:12px; margin-top:4px; }
    button.primary { background:#007bff; color:#fff; border:none; padding:10px 24px; border-radius:4px; cursor:pointer; font-size:15px; margin-top:15px; }
    button.primary:hover { background:#0056b3; }
    table { width:100%; border-collapse: collapse; font-size:14px; }
    th { text-align:left; padding:10px; background:#fafafa; border-bottom:2px solid #eee; font-size:12px; text-transform:uppercase; color:#666; letter-spacing:0.5px; }
    td { padding:10px; border-bottom:1px solid #eee; vertical-align: top; }
    tr:hover td { background:#fafafa; }
    .search { margin-bottom: 15px; }
    .search input { max-width:400px; }
  </style>
</head>
<body>
  <h1>VivaSpot Sites Admin</h1>
  <div class="sub">Manages rows in <code>vivaspot_sites</code>. Used by Mailchimp and Klaviyo OAuth flows for auto-mapping. Also used by the CRM Router webhooks.</div>

  ${flashBanner}

  <div class="card">
    <fieldset>
      <legend>Add or Update a Site</legend>
      <form method="POST" action="/admin/sites">
        <label>Restaurant Name <span style="color:#c00">*</span></label>
        <input type="text" name="restaurant_name" required placeholder="e.g. Tiki Taco - Liberty">
        <div class="help">Matched case-insensitively. If an exact name already exists, MACs/emails are appended.</div>

        <label>Hospitality Group</label>
        <input type="text" name="hospitality_group" placeholder="e.g. Tiki Taco">
        <div class="help">Groups multi-location brands. Used by OAuth's third matching strategy.</div>

        <label>Merchant Emails</label>
        <input type="text" name="merchant_emails" placeholder="eric@tikitaco.com, meredith@tikitaco.com">
        <div class="help">Comma- or space-separated. Lowercased on save. Matched against Mailchimp/Klaviyo account login email.</div>

        <label>MAC Addresses</label>
        <textarea name="mac_addresses" placeholder="e4:55:a8:1b:3f:38&#10;e4-55-a8-06-d6-87&#10;e455a81b3f38"></textarea>
        <div class="help">One per line, or comma/space separated. Colons, dashes, dots, or none — normalized to lowercase XX:XX:XX:XX:XX:XX.</div>

        <button type="submit" class="primary">Save</button>
      </form>
    </fieldset>
  </div>

  <div class="card">
    <h2 style="margin-top:0;">Sites (${sites.length})</h2>
    <div class="search"><input id="site-filter" type="text" placeholder="Filter by name, email, MAC, group..." oninput="filterSites(this.value)"></div>
    <div style="overflow-x:auto;">
    <table>
      <thead>
        <tr><th>Name</th><th>Group</th><th>Emails</th><th>MACs</th><th>Mailchimp<div style="font-weight:400;text-transform:none;font-size:10px;color:#999;">status · 30d activity</div></th><th>Klaviyo<div style="font-weight:400;text-transform:none;font-size:10px;color:#999;">status · 30d activity</div></th><th></th></tr>
      </thead>
      <tbody id="site-rows">
        ${rows || `<tr><td colspan="7" style="text-align:center;color:#999;padding:30px;">No sites yet. Add one above.</td></tr>`}
      </tbody>
    </table>
    </div>
  </div>

  <p style="color:#999;font-size:12px;text-align:center;">
    <strong>Badges:</strong> <span style="background:#d4edda;color:#155724;padding:2px 8px;border-radius:12px;">green</span> all MACs mapped ·
    <span style="background:#fff3cd;color:#856404;padding:2px 8px;border-radius:12px;">yellow</span> partial ·
    <span style="background:#fee;color:#a00;padding:2px 8px;border-radius:12px;">red</span> none mapped &nbsp;·&nbsp;
    <strong>Activity:</strong> <span style="color:#155724;">N ✓</span> successful syncs · <span style="color:#a00;">N ✗</span> failures &nbsp;(rolling 30-day window)
  </p>

  <script>
    function filterSites(q) {
      q = q.toLowerCase().trim();
      const rows = document.querySelectorAll('#site-rows tr');
      rows.forEach(r => {
        r.style.display = !q || r.textContent.toLowerCase().includes(q) ? '' : 'none';
      });
    }
  </script>
</body>
</html>`;
}

// =============================================================================
// Routes
// =============================================================================

/**
 * GET /admin/sites - list + add form.
 * ?flash=... surfaces a message from a POST redirect.
 */
router.get('/', async (req, res) => {
  try {
    const sites = await db.listVivaspotSitesWithConnectionCounts();
    const flash = req.query.flash
      ? { message: req.query.flash, error: req.query.err === '1' }
      : null;
    res.send(renderList(sites, flash));
  } catch (error) {
    console.error('admin-sites list error:', error);
    res.status(500).send(`<pre>Error loading sites: ${escapeHtml(error.message)}</pre>`);
  }
});

/**
 * POST /admin/sites - upsert a site.
 */
router.post('/', async (req, res) => {
  try {
    const { restaurant_name, hospitality_group, merchant_emails, mac_addresses } = req.body;

    const emails = String(merchant_emails || '')
      .split(/[,\s\n]+/)
      .map((e) => e.trim())
      .filter(Boolean);
    const macs = String(mac_addresses || '')
      .split(/[,\s\n]+/)
      .map((m) => m.trim())
      .filter(Boolean);

    const result = await db.upsertVivaspotSite({
      restaurantName: restaurant_name,
      hospitalityGroup: hospitality_group,
      macAddresses: macs,
      merchantEmails: emails,
    });

    const parts = [
      result.action === 'inserted' ? `Inserted "${result.site.restaurant_name}".` :
      result.action === 'updated' ? `Updated "${result.site.restaurant_name}".` :
      `No changes for "${result.site.restaurant_name}" (already up to date).`,
    ];
    if (result.invalidMacs && result.invalidMacs.length > 0) {
      parts.push(`Skipped ${result.invalidMacs.length} invalid MAC(s): ${result.invalidMacs.join(', ')}.`);
    }
    res.redirect(`/admin/sites?flash=${encodeURIComponent(parts.join(' '))}`);
  } catch (error) {
    console.error('admin-sites upsert error:', error);
    res.redirect(`/admin/sites?err=1&flash=${encodeURIComponent(error.message || 'Failed to save site')}`);
  }
});

/**
 * POST /admin/sites/:id/delete - delete a site row (does NOT touch connections).
 */
router.post('/:id/delete', async (req, res) => {
  try {
    const deleted = await db.deleteVivaspotSiteById(req.params.id);
    if (!deleted) {
      return res.redirect(`/admin/sites?err=1&flash=${encodeURIComponent('Site not found')}`);
    }
    res.redirect(`/admin/sites?flash=${encodeURIComponent(`Deleted "${deleted.restaurant_name}".`)}`);
  } catch (error) {
    console.error('admin-sites delete error:', error);
    res.redirect(`/admin/sites?err=1&flash=${encodeURIComponent(error.message || 'Failed to delete')}`);
  }
});

module.exports = router;
