/**
 * Infobip API Service
 *
 * Auth model: API key (not OAuth). Each customer supplies:
 *   - api_key   → sent as `Authorization: App <api_key>` header
 *   - base_url  → per-tenant subdomain, e.g. "e53je3.api-us.infobip.com"
 *
 * Contact model:
 *   - Persons live at /people/2/persons
 *   - Tags are separate resources at /people/2/tags with numeric IDs
 *   - We tag each captured contact with a per-location tag so the merchant
 *     can segment campaigns per venue.
 */

const axios = require('axios');

const API_VERSION = 'people/2';

/**
 * Build a per-request axios client with the customer's credentials.
 */
function createClient(apiKey, baseUrl) {
  const cleanBase = String(baseUrl || '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  return axios.create({
    baseURL: `https://${cleanBase}`,
    headers: {
      Authorization: `App ${apiKey}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    timeout: 30000,
  });
}

/**
 * Lightweight health check — read one person.
 */
async function pingAccount(apiKey, baseUrl) {
  try {
    const client = createClient(apiKey, baseUrl);
    await client.get(`/${API_VERSION}/persons`, { params: { limit: 1 } });
    return true;
  } catch (error) {
    console.error('Infobip ping failed:', error.response?.status, error.response?.data || error.message);
    return false;
  }
}

/**
 * Find a tag by exact name; return its id or null. Scans up to `pageMax`
 * pages of 100 tags each (default 20 pages = 2000 tags) which is enough for
 * any real account. Falls back to null if not found.
 */
async function findTagIdByName(apiKey, baseUrl, tagName, pageMax = 20) {
  const client = createClient(apiKey, baseUrl);
  const target = String(tagName || '').trim().toLowerCase();
  if (!target) return null;

  for (let page = 1; page <= pageMax; page++) {
    const response = await client.get(`/${API_VERSION}/tags`, {
      params: { limit: 100, page },
    });
    const tags = response.data?.tags || [];
    for (const t of tags) {
      if (String(t.name || '').trim().toLowerCase() === target) return t.id;
    }
    if (tags.length < 100) break; // last page
  }
  return null;
}

/**
 * Create a tag; return the new id. Idempotent-ish: if creation fails because
 * the tag already exists (409), falls back to looking it up.
 */
async function createTag(apiKey, baseUrl, tagName) {
  const client = createClient(apiKey, baseUrl);
  try {
    const response = await client.post(`/${API_VERSION}/tags`, { name: tagName });
    return response.data?.id || response.data?.tag?.id || null;
  } catch (error) {
    const status = error.response?.status;
    if (status === 409 || status === 400) {
      // Already exists — look it up
      return findTagIdByName(apiKey, baseUrl, tagName);
    }
    console.error('Infobip create tag failed:', error.response?.data || error.message);
    throw new Error('Failed to create tag');
  }
}

/**
 * Return an existing tag id or create the tag and return the new id.
 */
async function findOrCreateTagId(apiKey, baseUrl, tagName) {
  const existing = await findTagIdByName(apiKey, baseUrl, tagName);
  if (existing) return existing;
  return await createTag(apiKey, baseUrl, tagName);
}

/**
 * Find a person by email. Returns the person object or null.
 * Uses the search endpoint filtered on primary email.
 */
async function findPersonByEmail(apiKey, baseUrl, email) {
  const client = createClient(apiKey, baseUrl);
  const lower = String(email || '').trim().toLowerCase();
  if (!lower) return null;

  try {
    // Infobip search: GET /persons?email=<address>
    const response = await client.get(`/${API_VERSION}/persons`, {
      params: { email: lower, limit: 1 },
    });
    const persons = response.data?.persons || [];
    return persons[0] || null;
  } catch (error) {
    // If the email filter isn't supported on this endpoint, we return null
    // and the caller's create-then-catch-409 path takes over.
    if (error.response?.status === 400) return null;
    console.error('Infobip person lookup failed:', error.response?.data || error.message);
    return null;
  }
}

/**
 * Build the person JSON body expected by Infobip's People API v2.
 *
 * Note on tags: Infobip's People API accepts tags as an **array of tag name
 * strings** in the create body. The `{id: N}` object form is rejected with
 * a 400 Bad Request. Confirmed via direct API testing 2026-07-09.
 * The referenced tag must already exist (create it separately via
 * POST /people/2/tags if needed).
 */
function buildPersonBody(contact, tagNames = []) {
  const body = {};
  if (contact.firstName) body.firstName = String(contact.firstName).trim();
  if (contact.lastName) body.lastName = String(contact.lastName).trim();

  const emails = [];
  if (contact.email) {
    emails.push({ address: String(contact.email).toLowerCase().trim(), isPrimary: true });
  }
  const phones = [];
  if (contact.phone) {
    phones.push({ number: String(contact.phone).trim(), isPrimary: true });
  }

  if (emails.length || phones.length) {
    body.contactInformation = {};
    if (emails.length) body.contactInformation.email = emails;
    if (phones.length) body.contactInformation.phone = phones;
  }

  const clean = (Array.isArray(tagNames) ? tagNames : [tagNames])
    .filter((t) => typeof t === 'string' && t.trim().length > 0)
    .map((t) => t.trim());
  if (clean.length > 0) {
    body.tags = clean;
  }

  return body;
}

/**
 * Create a person. Individual /persons/{id} endpoints don't exist in this
 * API — the collection is create-only from the API surface we've explored,
 * so this is a POST-only path. Infobip may auto-dedupe by email server-side
 * but that's not documented; either way, our webhook logs one attempt per
 * capture regardless of dedup behavior downstream.
 */
async function createPerson(apiKey, baseUrl, contact, tagNames = []) {
  const client = createClient(apiKey, baseUrl);
  const body = buildPersonBody(contact, tagNames);

  try {
    const response = await client.post(`/${API_VERSION}/persons`, body);
    return { id: response.data?.id || null, action: 'created' };
  } catch (error) {
    const data = error.response?.data;
    const detail =
      data?.requestError?.serviceException?.text ||
      data?.requestError?.serviceException?.messageId ||
      error.message;
    console.error('Infobip person create failed:', data || error.message);
    const err = new Error(detail || 'Failed to create person');
    err.infobipError = data || null;
    err.httpStatus = error.response?.status || null;
    throw err;
  }
}

// Alias for callers using the old name.
async function upsertPerson(apiKey, baseUrl, contact, tagNames = []) {
  return createPerson(apiKey, baseUrl, contact, tagNames);
}

/**
 * Full contact sync: create the person tagged with the venue.
 * The tag is created ahead of time by the admin panel (or on first sync
 * via findOrCreateTagId) so the tag name is guaranteed to exist at
 * Infobip when we reference it here.
 */
async function syncContact({ apiKey, baseUrl, contact, tagName, cachedTagId }) {
  const tagNames = tagName ? [tagName] : [];

  // Best-effort: ensure the tag exists in Infobip before we reference it
  // by name. If tag_id was already cached on the connection we can skip;
  // otherwise resolve/create so a fresh admin-panel row that missed the
  // pre-save tag creation still works.
  let tagId = cachedTagId || null;
  if (!tagId && tagName) {
    try {
      tagId = await findOrCreateTagId(apiKey, baseUrl, tagName);
    } catch (e) {
      // Non-fatal — the create may still succeed even if we couldn't
      // pre-verify the tag exists.
      console.warn('Infobip tag pre-resolve failed:', e.message);
    }
  }

  const result = await createPerson(apiKey, baseUrl, contact, tagNames);
  return { ...result, tagId };
}

module.exports = {
  createClient,
  pingAccount,
  findTagIdByName,
  createTag,
  findOrCreateTagId,
  findPersonByEmail,
  createPerson,
  upsertPerson, // alias
  syncContact,
  buildPersonBody, // exported for tests
};
