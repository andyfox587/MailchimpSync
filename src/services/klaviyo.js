/**
 * Klaviyo API Service
 *
 * Handles all interactions with the Klaviyo Marketing API and OAuth.
 *
 * Differences vs. the Mailchimp service:
 *   - OAuth uses Authorization Code + PKCE (code_verifier / code_challenge).
 *   - Access tokens expire (~1 hour), so we also manage refresh tokens.
 *   - All API calls require a date-based `revision` header.
 *
 * Token + revoke traffic must route to a.klaviyo.com (required since 2025-03-31).
 */

const axios = require('axios');
const crypto = require('crypto');

// OAuth endpoints
const OAUTH_AUTHORIZE_URL = 'https://www.klaviyo.com/oauth/authorize';
const OAUTH_TOKEN_URL = 'https://a.klaviyo.com/oauth/token';
const OAUTH_REVOKE_URL = 'https://a.klaviyo.com/oauth/revoke';

// API base
const API_BASE_URL = 'https://a.klaviyo.com/api';

// Date-based API revision. Overridable via env so it can be bumped without a
// code change. Defaults to a known-stable GA revision.
const API_REVISION = process.env.KLAVIYO_API_REVISION || '2024-10-15';

// Scopes requested at install time. accounts:read is required by default.
const DEFAULT_SCOPES =
  process.env.KLAVIYO_SCOPES ||
  'accounts:read lists:read lists:write profiles:write subscriptions:write';

// =============================================================================
// PKCE helpers
// =============================================================================

function base64UrlEncode(buffer) {
  return buffer
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Generate a PKCE code_verifier / code_challenge (S256) pair.
 * code_verifier: 43-128 char high-entropy string.
 */
function generatePKCE() {
  const codeVerifier = base64UrlEncode(crypto.randomBytes(64)).slice(0, 128);
  const codeChallenge = base64UrlEncode(
    crypto.createHash('sha256').update(codeVerifier).digest()
  );
  return { codeVerifier, codeChallenge };
}

// =============================================================================
// OAuth
// =============================================================================

/**
 * Build the Klaviyo authorization URL the user is redirected to.
 */
function getAuthorizationUrl(state, codeChallenge, scopes = DEFAULT_SCOPES) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.KLAVIYO_CLIENT_ID,
    redirect_uri: process.env.KLAVIYO_OAUTH_REDIRECT_URI,
    scope: scopes,
    state,
    code_challenge_method: 'S256',
    code_challenge: codeChallenge,
  });

  return `${OAUTH_AUTHORIZE_URL}?${params.toString()}`;
}

/**
 * Build the HTTP Basic auth header for the token endpoint.
 */
function basicAuthHeader() {
  const creds = `${process.env.KLAVIYO_CLIENT_ID}:${process.env.KLAVIYO_CLIENT_SECRET}`;
  return `Basic ${Buffer.from(creds).toString('base64')}`;
}

function normalizeTokenResponse(data) {
  // Klaviyo returns expires_in (seconds). Compute an absolute expiry with a
  // small safety margin handled by callers.
  const expiresInSeconds = Number(data.expires_in) || 3600;
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresInSeconds,
    tokenExpiresAt: new Date(Date.now() + expiresInSeconds * 1000),
  };
}

/**
 * Exchange an authorization code for tokens (with PKCE verifier).
 */
async function exchangeCodeForToken(code, codeVerifier) {
  try {
    const response = await axios.post(
      OAUTH_TOKEN_URL,
      new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: process.env.KLAVIYO_OAUTH_REDIRECT_URI,
        code_verifier: codeVerifier,
      }).toString(),
      {
        headers: {
          Authorization: basicAuthHeader(),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      }
    );
    return normalizeTokenResponse(response.data);
  } catch (error) {
    const detail = error.response?.data;
    console.error('Klaviyo token exchange failed:', detail || error.message);
    const err = new Error('Failed to exchange code for token');
    err.klaviyoError = detail?.error || null;
    err.klaviyoErrorDescription = detail?.error_description || detail?.detail || null;
    err.httpStatus = error.response?.status || null;
    throw err;
  }
}

/**
 * Refresh an access token. A response of invalid_grant means the app was
 * uninstalled — callers should treat the connection as dead.
 */
async function refreshAccessToken(refreshToken) {
  try {
    const response = await axios.post(
      OAUTH_TOKEN_URL,
      new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }).toString(),
      {
        headers: {
          Authorization: basicAuthHeader(),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      }
    );
    return normalizeTokenResponse(response.data);
  } catch (error) {
    const data = error.response?.data;
    console.error('Klaviyo token refresh failed:', data || error.message);
    if (data && data.error === 'invalid_grant') {
      const err = new Error('Klaviyo app uninstalled (invalid_grant)');
      err.code = 'INVALID_GRANT';
      throw err;
    }
    throw new Error('Failed to refresh access token');
  }
}

/**
 * Revoke a token (call on uninstall).
 */
async function revokeToken(token, tokenTypeHint = 'access_token') {
  try {
    await axios.post(
      OAUTH_REVOKE_URL,
      new URLSearchParams({ token, token_type_hint: tokenTypeHint }).toString(),
      {
        headers: {
          Authorization: basicAuthHeader(),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      }
    );
    return true;
  } catch (error) {
    console.error('Klaviyo token revoke failed:', error.response?.data || error.message);
    return false;
  }
}

// =============================================================================
// API client
// =============================================================================

function createClient(accessToken) {
  return axios.create({
    baseURL: API_BASE_URL,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      revision: API_REVISION,
      Accept: 'application/vnd.api+json',
      'Content-Type': 'application/vnd.api+json',
    },
    timeout: 30000,
  });
}

/**
 * Fetch account metadata (id, organization name, sender email).
 * GET /api/accounts/?fields[account]=contact_information
 *
 * Per the Klaviyo OpenAPI schema, the account name + primary email live
 * under attributes.contact_information.{organization_name,default_sender_email}.
 * The top-level attributes.name / attributes.contact_email used previously
 * do not exist and produced `undefined`.
 */
async function getAccountMetadata(accessToken) {
  const client = createClient(accessToken);
  try {
    const response = await client.get('/accounts/', {
      params: { 'fields[account]': 'contact_information' },
    });
    const account = response.data.data?.[0];
    if (!account) {
      throw new Error('No account returned');
    }
    const ci = account.attributes?.contact_information || {};
    const loginEmail = ci.default_sender_email
      ? String(ci.default_sender_email).toLowerCase()
      : null;
    return {
      accountId: account.id,
      accountName:
        ci.organization_name ||
        ci.default_sender_name ||
        loginEmail ||
        `Klaviyo account ${account.id}`,
      loginEmail,
    };
  } catch (error) {
    console.error('Klaviyo metadata fetch failed:', error.response?.data || error.message);
    throw new Error('Failed to fetch account metadata');
  }
}

/**
 * Fetch lists for the account.
 * GET /api/lists
 */
async function getLists(accessToken) {
  const client = createClient(accessToken);
  try {
    const response = await client.get('/lists/', {
      params: { 'fields[list]': 'name' },
    });
    return (response.data.data || []).map((list) => ({
      id: list.id,
      name: list.attributes?.name || '(unnamed list)',
    }));
  } catch (error) {
    console.error('Klaviyo list fetch failed:', error.response?.data || error.message);
    throw new Error('Failed to fetch lists');
  }
}

/**
 * Create or update a profile's identity fields (name, phone, properties).
 * Klaviyo's Create Profile returns 409 on an existing email; we then PATCH.
 * Returns the profile id.
 */
async function upsertProfile(accessToken, contact) {
  const client = createClient(accessToken);

  const attributes = { email: contact.email };
  if (contact.firstName) attributes.first_name = contact.firstName;
  if (contact.lastName) attributes.last_name = contact.lastName;
  if (contact.phone) attributes.phone_number = contact.phone;
  if (contact.properties && Object.keys(contact.properties).length > 0) {
    attributes.properties = contact.properties;
  }

  const body = { data: { type: 'profile', attributes } };

  try {
    const response = await client.post('/profiles/', body);
    return response.data.data.id;
  } catch (error) {
    const status = error.response?.status;
    const dupId = error.response?.data?.errors?.[0]?.meta?.duplicate_profile_id;
    if (status === 409 && dupId) {
      // Profile exists — update it.
      await client.patch(`/profiles/${dupId}/`, {
        data: { type: 'profile', id: dupId, attributes },
      });
      return dupId;
    }
    console.error('Klaviyo profile upsert failed:', error.response?.data || error.message);
    throw new Error('Failed to create/update profile');
  }
}

/**
 * Subscribe a profile to a list with email marketing consent.
 * POST /api/profile-subscription-bulk-create-jobs
 * This both records consent and adds the profile to the list.
 */
async function subscribeProfileToList(accessToken, listId, contact, customSource = 'VivaSpot WiFi') {
  const client = createClient(accessToken);

  const profileAttributes = {
    email: contact.email,
    subscriptions: { email: { marketing: { consent: 'SUBSCRIBED' } } },
  };
  if (contact.phone) {
    profileAttributes.phone_number = contact.phone;
  }

  const body = {
    data: {
      type: 'profile-subscription-bulk-create-job',
      attributes: {
        custom_source: customSource,
        profiles: {
          data: [{ type: 'profile', attributes: profileAttributes }],
        },
      },
      relationships: {
        list: { data: { type: 'list', id: listId } },
      },
    },
  };

  try {
    await client.post('/profile-subscription-bulk-create-jobs/', body);
    return { success: true };
  } catch (error) {
    console.error('Klaviyo subscribe failed:', error.response?.data || error.message);
    throw new Error(
      error.response?.data?.errors?.[0]?.detail || 'Failed to subscribe profile to list'
    );
  }
}

/**
 * Full sync: set identity fields, then subscribe to the list with consent.
 */
async function syncContact(accessToken, listId, contact, customSource) {
  // Identity first (names/phone/properties), then consent + list membership.
  await upsertProfile(accessToken, contact);
  await subscribeProfileToList(accessToken, listId, contact, customSource);
  return { success: true, email: contact.email, status: 'subscribed' };
}

/**
 * Lightweight validity check — can we read the account?
 */
async function pingAccount(accessToken) {
  try {
    await getAccountMetadata(accessToken);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  // PKCE + OAuth
  generatePKCE,
  getAuthorizationUrl,
  exchangeCodeForToken,
  refreshAccessToken,
  revokeToken,

  // API
  createClient,
  getAccountMetadata,
  getLists,
  upsertProfile,
  subscribeProfileToList,
  syncContact,
  pingAccount,

  // Constants (exported for tests/visibility)
  API_REVISION,
  DEFAULT_SCOPES,
};
