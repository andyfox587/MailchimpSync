/**
 * Mailchimp API Service
 * 
 * Handles all interactions with the Mailchimp Marketing API.
 * Requires OAuth access token and data center prefix.
 */

const axios = require('axios');
const crypto = require('crypto');

// Mailchimp OAuth endpoints (not data center specific)
const OAUTH_AUTHORIZE_URL = 'https://login.mailchimp.com/oauth2/authorize';
const OAUTH_TOKEN_URL = 'https://login.mailchimp.com/oauth2/token';
const OAUTH_METADATA_URL = 'https://login.mailchimp.com/oauth2/metadata';

/**
 * Generate the OAuth authorization URL
 */
function getAuthorizationUrl(state) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.MAILCHIMP_CLIENT_ID,
    redirect_uri: process.env.OAUTH_REDIRECT_URI,
    state: state
  });
  
  return `${OAUTH_AUTHORIZE_URL}?${params.toString()}`;
}

/**
 * Exchange authorization code for access token
 */
async function exchangeCodeForToken(code) {
  try {
    const response = await axios.post(OAUTH_TOKEN_URL, 
      new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: process.env.MAILCHIMP_CLIENT_ID,
        client_secret: process.env.MAILCHIMP_CLIENT_SECRET,
        redirect_uri: process.env.OAUTH_REDIRECT_URI,
        code: code
      }).toString(),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );
    
    return {
      accessToken: response.data.access_token,
      // Note: Mailchimp tokens don't expire, so no refresh token needed
    };
  } catch (error) {
    console.error('Token exchange failed:', error.response?.data || error.message);
    throw new Error('Failed to exchange code for token');
  }
}

/**
 * Get account metadata (data center, account name, etc.)
 */
async function getAccountMetadata(accessToken) {
  try {
    const response = await axios.get(OAUTH_METADATA_URL, {
      headers: {
        Authorization: `OAuth ${accessToken}`
      }
    });
    
    return {
      dataCenter: response.data.dc,           // e.g., 'us6'
      accountId: response.data.user_id?.toString(),
      accountName: response.data.accountname,
      loginEmail: response.data.login?.login_email,
      apiEndpoint: response.data.api_endpoint  // e.g., 'https://us6.api.mailchimp.com'
    };
  } catch (error) {
    console.error('Metadata fetch failed:', error.response?.data || error.message);
    throw new Error('Failed to fetch account metadata');
  }
}

/**
 * Create a Mailchimp API client for a specific account
 */
function createClient(accessToken, dataCenter) {
  const baseURL = `https://${dataCenter}.api.mailchimp.com/3.0`;
  
  return axios.create({
    baseURL,
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    timeout: 30000
  });
}

/**
 * Get all audiences (lists) for an account
 */
async function getAudiences(accessToken, dataCenter) {
  const client = createClient(accessToken, dataCenter);
  
  try {
    const response = await client.get('/lists', {
      params: {
        fields: 'lists.id,lists.name,lists.stats.member_count',
        count: 100
      }
    });
    
    return response.data.lists.map(list => ({
      id: list.id,
      name: list.name,
      memberCount: list.stats?.member_count || 0
    }));
  } catch (error) {
    console.error('Failed to fetch audiences:', error.response?.data || error.message);
    throw new Error('Failed to fetch audiences');
  }
}

/**
 * Calculate subscriber hash (MD5 of lowercase email)
 */
function getSubscriberHash(email) {
  return crypto
    .createHash('md5')
    .update(email.toLowerCase())
    .digest('hex');
}

/**
 * Add or update a contact in a Mailchimp audience
 * Uses PUT to /lists/{list_id}/members/{subscriber_hash}
 */
async function upsertContact(accessToken, dataCenter, audienceId, contact) {
  const client = createClient(accessToken, dataCenter);
  const subscriberHash = getSubscriberHash(contact.email);
  
  const payload = {
    email_address: contact.email,
    status_if_new: contact.status || 'subscribed',
    merge_fields: {}
  };
  
  // Add merge fields if provided
  if (contact.firstName) {
    payload.merge_fields.FNAME = contact.firstName;
  }
  if (contact.lastName) {
    payload.merge_fields.LNAME = contact.lastName;
  }
  if (contact.phone) {
    payload.merge_fields.PHONE = contact.phone;
  }
  
  // Add any additional merge fields
  if (contact.mergeFields) {
    payload.merge_fields = { ...payload.merge_fields, ...contact.mergeFields };
  }
  
  try {
    const response = await client.put(
      `/lists/${audienceId}/members/${subscriberHash}`,
      payload
    );
    
    return {
      success: true,
      id: response.data.id,
      email: response.data.email_address,
      status: response.data.status,
      isNew: response.status === 200 // 200 = created, could check for exact response
    };
  } catch (error) {
    console.error('Failed to upsert contact:', error.response?.data || error.message);
    throw new Error(error.response?.data?.detail || 'Failed to add/update contact');
  }
}

/**
 * Add tags to a contact
 */
async function addTagsToContact(accessToken, dataCenter, audienceId, email, tags) {
  const client = createClient(accessToken, dataCenter);
  const subscriberHash = getSubscriberHash(email);
  
  // Format tags for the API
  const formattedTags = tags.map(tag => ({
    name: tag,
    status: 'active'
  }));
  
  try {
    await client.post(
      `/lists/${audienceId}/members/${subscriberHash}/tags`,
      { tags: formattedTags }
    );
    
    return { success: true };
  } catch (error) {
    console.error('Failed to add tags:', error.response?.data || error.message);
    throw new Error('Failed to add tags to contact');
  }
}

/**
 * Get contact by email
 */
async function getContact(accessToken, dataCenter, audienceId, email) {
  const client = createClient(accessToken, dataCenter);
  const subscriberHash = getSubscriberHash(email);
  
  try {
    const response = await client.get(
      `/lists/${audienceId}/members/${subscriberHash}`
    );
    
    return {
      id: response.data.id,
      email: response.data.email_address,
      status: response.data.status,
      mergeFields: response.data.merge_fields,
      tags: response.data.tags
    };
  } catch (error) {
    if (error.response?.status === 404) {
      return null; // Contact doesn't exist
    }
    throw new Error('Failed to fetch contact');
  }
}

/**
 * Full contact sync: upsert contact and add tags
 */
async function syncContact(accessToken, dataCenter, audienceId, contact, tags = []) {
  // First, add/update the contact
  const result = await upsertContact(accessToken, dataCenter, audienceId, contact);
  
  // Then add tags if any are specified
  if (tags.length > 0) {
    await addTagsToContact(accessToken, dataCenter, audienceId, contact.email, tags);
  }
  
  return result;
}

/**
 * Validate that we can access an account (ping test)
 */
async function pingAccount(accessToken, dataCenter) {
  const client = createClient(accessToken, dataCenter);
  
  try {
    const response = await client.get('/ping');
    return response.data.health_status === 'Everything\'s Chimpy!';
  } catch (error) {
    return false;
  }
}

/**
 * Get account details
 */
async function getAccountInfo(accessToken, dataCenter) {
  const client = createClient(accessToken, dataCenter);
  
  try {
    const response = await client.get('/');
    return {
      accountId: response.data.account_id,
      accountName: response.data.account_name,
      email: response.data.email,
      totalSubscribers: response.data.total_subscribers
    };
  } catch (error) {
    console.error('Failed to fetch account info:', error.response?.data || error.message);
    throw new Error('Failed to fetch account info');
  }
}

module.exports = {
  // OAuth
  getAuthorizationUrl,
  exchangeCodeForToken,
  getAccountMetadata,
  
  // Account
  createClient,
  pingAccount,
  getAccountInfo,
  getAudiences,
  
  // Contacts
  getSubscriberHash,
  upsertContact,
  addTagsToContact,
  getContact,
  syncContact
};
