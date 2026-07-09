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
 */
function buildPersonBody(contact, tagIds = []) {
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

  // Tags are references by id in the person body
  if (Array.isArray(tagIds) && tagIds.length > 0) {
    body.tags = tagIds.filter((t) => t !== null && t !== undefined).map((id) => ({ id }));
  }

  return body;
}

/**
 * Create or update a person by email. Returns { id, action: 'created'|'updated' }.
 */
async function upsertPerson(apiKey, baseUrl, contact, tagIds = []) {
  const client = createClient(apiKey, baseUrl);
  const body = buildPersonBody(contact, tagIds);

  // Try to find first; PATCH if found, POST if not.
  const existing = await findPersonByEmail(apiKey, baseUrl, contact.email);
  if (existing && existing.id) {
    await client.patch(`/${API_VERSION}/persons/${existing.id}`, body);
    return { id: existing.id, action: 'updated' };
  }

  try {
    const response = await client.post(`/${API_VERSION}/persons`, body);
    return { id: response.data?.id || response.data?.person?.id, action: 'created' };
  } catch (error) {
    // Fallback: someone raced us — try lookup + patch
    const status = error.response?.status;
    if (status === 409 || status === 400) {
      const retryFound = await findPersonByEmail(apiKey, baseUrl, contact.email);
      if (retryFound && retryFound.id) {
        await client.patch(`/${API_VERSION}/persons/${retryFound.id}`, body);
        return { id: retryFound.id, action: 'updated' };
      }
    }
    console.error('Infobip person upsert failed:', error.response?.data || error.message);
    throw new Error(
      error.response?.data?.requestError?.serviceException?.text ||
        'Failed to create/update person'
    );
  }
}

/**
 * Full contact sync: ensure the connection's tag exists, then upsert person.
 * If the connection doesn't have a cached tag_id, resolve/create it and let
 * the caller persist the id for next time.
 */
async function syncContact({ apiKey, baseUrl, contact, tagName, cachedTagId }) {
  let tagId = cachedTagId || null;
  if (!tagId && tagName) {
    tagId = await findOrCreateTagId(apiKey, baseUrl, tagName);
  }
  const result = await upsertPerson(apiKey, baseUrl, contact, tagId ? [tagId] : []);
  return { ...result, tagId };
}

module.exports = {
  createClient,
  pingAccount,
  findTagIdByName,
  createTag,
  findOrCreateTagId,
  findPersonByEmail,
  upsertPerson,
  syncContact,
  buildPersonBody, // exported for tests
};
