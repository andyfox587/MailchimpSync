# VivaSpot Mailchimp Integration

OAuth-based integration for syncing WiFi-captured contacts from VivaSpot captive portals to Mailchimp audiences.

## Features

- **OAuth 2.0 Authentication**: Secure connection to Mailchimp accounts
- **Automatic Contact Sync**: Real-time syncing of WiFi guests to Mailchimp audiences
- **Tagging Support**: Automatic tagging for source tracking and segmentation
- **Auto-Mapping**: Fuzzy matching for hospitality groups with multiple locations
- **Webhook API**: RESTful endpoint for n8n CRM Router integration

## Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Captive Portal │────▶│   n8n CRM       │────▶│   Mailchimp     │
│  (AWS Lambda)   │     │   Router        │     │   Integration   │
└─────────────────┘     └─────────────────┘     └────────┬────────┘
                                                         │
                                                         ▼
                                                ┌─────────────────┐
                                                │   Mailchimp     │
                                                │   Marketing API │
                                                └─────────────────┘
```

## Quick Start

### 1. Register Your Mailchimp App

1. Log into [Mailchimp](https://mailchimp.com)
2. Go to **Account → Extras → API Keys**
3. Click **Register And Manage Your Apps**
4. Click **Register An App**
5. Fill in:
   - **App name**: VivaSpot WiFi Marketing
   - **App website**: https://vivaspot.com
   - **Redirect URI**: `https://your-app.onrender.com/oauth/callback`
6. Save your `client_id` and `client_secret`

### 2. Deploy to Render

```bash
# Clone and configure
git clone https://github.com/vivaspot/mailchimp-integration.git
cd mailchimp-integration

# Set environment variables in Render dashboard:
# - MAILCHIMP_CLIENT_ID
# - MAILCHIMP_CLIENT_SECRET
# - OAUTH_REDIRECT_URI (https://your-app.onrender.com/oauth/callback)
# - APP_BASE_URL (https://your-app.onrender.com)

# Deploy using Render Blueprint
render blueprint launch
```

### 3. Run Database Migration

After deployment, run the migration to create tables:

```bash
# Via Render shell or locally
npm run db:migrate
```

### 4. Connect a Location

Direct users to start the OAuth flow:

```
https://your-app.onrender.com/oauth/authorize?mac_address=XX:XX:XX:XX:XX:XX
```

## API Reference

### OAuth Endpoints

#### Start OAuth Flow
```http
GET /oauth/authorize?mac_address=XX:XX:XX:XX:XX:XX&redirect_url=https://...
```

Initiates OAuth with Mailchimp. The `mac_address` identifies the WiFi location. Optional `redirect_url` for post-connection redirect.

#### OAuth Callback
```http
GET /oauth/callback?code=xxx&state=xxx
```

Handles Mailchimp OAuth callback. Exchanges code for token and redirects to audience selection.

#### Check Connection Status
```http
GET /oauth/status/:mac_address
```

Returns connection status and validity.

### Webhook Endpoints

#### Sync Contact
```http
POST /webhook/contact
Content-Type: application/json
X-Webhook-Signature: sha256-hmac-signature (optional)

{
  "mac_address": "XX:XX:XX:XX:XX:XX",
  "email": "guest@example.com",
  "first_name": "John",
  "last_name": "Doe",
  "phone": "+1234567890",
  "source": "WiFi Portal",
  "location_name": "Joe's Pizza - Main St"
}
```

**Response:**
```json
{
  "success": true,
  "email": "guest@example.com",
  "status": "subscribed",
  "account": "Joe's Pizza",
  "audience": "Newsletter",
  "tags": ["WiFi Portal", "Main St"],
  "duration_ms": 245
}
```

#### Batch Sync
```http
POST /webhook/contacts/batch
Content-Type: application/json

{
  "contacts": [
    { "mac_address": "...", "email": "...", "first_name": "..." },
    { "mac_address": "...", "email": "...", "first_name": "..." }
  ]
}
```

#### Test Connection
```http
POST /webhook/test
Content-Type: application/json

{
  "mac_address": "XX:XX:XX:XX:XX:XX"
}
```

### Admin Endpoints

All admin endpoints require `X-API-Key` header in production.

#### List Connections
```http
GET /connections
```

#### Get Connection Details
```http
GET /connections/:mac_address
```

#### Update Connection
```http
PATCH /connections/:mac_address
Content-Type: application/json

{
  "audience_id": "new_audience_id",
  "source_tag": "New Tag"
}
```

#### Delete Connection
```http
DELETE /connections/:mac_address
```

#### Search Connections (Fuzzy)
```http
GET /connections/search?q=pizza
```

#### Get Sync Logs
```http
GET /connections/logs/recent?limit=100
```

## n8n CRM Router Integration

Configure your n8n "CRM Router" workflow to call this integration:

```javascript
// HTTP Request Node Configuration
{
  "method": "POST",
  "url": "https://your-app.onrender.com/webhook/contact",
  "headers": {
    "Content-Type": "application/json",
    "X-Webhook-Key": "<from an n8n Header Auth credential>"
  },
  "body": {
    "mac_address": "{{ $json.mac_address }}",
    "email": "{{ $json.email }}",
    "first_name": "{{ $json.first_name }}",
    "last_name": "{{ $json.last_name }}",
    "phone": "{{ $json.phone }}",
    "location_name": "{{ $json.location_name }}",
    "opt_in": "{{ $json.form.opt_in_email }}"
  }
}
```

### Answers

A venue with no Mailchimp connection gets `200 { success: false, status: "skipped", reason: "no_connection" }` (most venues: the router sends every sign-up to every CRM service), and so does a connection with no audience chosen yet (`reason: "no_audience"`). Only real failures are errors (`401` bad key, `400` bad input, `500` Mailchimp or database trouble), so n8n can retry them.

### Consent (`opt_in`)

Decided 1 Oct 2026. Send the guest's answer to the email box as `opt_in`:

| `opt_in` | Mailchimp status for a new contact | Tag |
|---|---|---|
| `true`, `"true"`, `"yes"`, `"1"`, `"on"` | `subscribed` (an existing `transactional` contact is moved to `subscribed`) | removes `WiFi: no email consent` |
| `false`, `""`, anything else | `transactional`: in the audience, but marketing not allowed | `WiFi: no email consent` |
| missing | `subscribed` (the old behaviour, for senders that don't pass it yet) | – |

A contact who unsubscribed is never re-subscribed.

## Merchant app API (`/app/mailchimp/*`)

For the VivaSpot merchant app (vivaspot-campaigns), server to server only, with `X-App-Key: $APP_API_KEY`. The app passes the merchant's VivaSpot account (`acc_id`) and its access points' MACs, read from VivaSpot with the merchant's own login, so a connection is tied to the account, not matched by Mailchimp login email or restaurant name. Rows carry `acc_id`; a row with no `acc_id` (made by staff or auto-mapping) whose MAC is one of the account's is treated as the account's and claimed when the merchant changes it.

| Method & path | Body / query | Returns |
|---|---|---|
| `POST /app/mailchimp/connect` | `{ acc_id, macs, return_url }` | `{ authorize_url }`: send the merchant's browser there. After Mailchimp, `/oauth/callback` saves the connection and redirects to `return_url?mailchimp=connected \| choose_audience \| no_audience \| cancelled \| expired \| error` |
| `GET /app/mailchimp/status` | `?acc_id=&macs=a,b` | `{ connected, account_name, audience_name, needs_audience, access_points, last_sent_at, last_error, sent_30d, failed_30d }`. No guest data |
| `GET /app/mailchimp/audiences` | `?acc_id=&macs=a,b` | `{ audiences: [{ id, name, member_count }] }` |
| `POST /app/mailchimp/audience` | `{ acc_id, macs, audience_id }` | Sets the audience for all the account's access points |
| `POST /app/mailchimp/disconnect` | `{ acc_id, macs }` | Deletes the account's connections. Contacts already in Mailchimp stay |

With several audiences and none chosen yet, contacts are held back (`409`, logged as "Audience not chosen yet") until the merchant chooses one.

Run `npm run db:migrate` before deploying this (it adds `mailchimp_connections.acc_id`).

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `MAILCHIMP_CLIENT_ID` | Yes | OAuth client ID from Mailchimp |
| `MAILCHIMP_CLIENT_SECRET` | Yes | OAuth client secret from Mailchimp |
| `OAUTH_REDIRECT_URI` | Yes | OAuth callback URL |
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `APP_BASE_URL` | Yes | Base URL of the application |
| `PORT` | No | Server port (default: 3000) |
| `NODE_ENV` | No | Environment (development/production) |
| `WEBHOOK_KEY` | Yes in production | Shared key the n8n CRM Router sends as `X-Webhook-Key` on every sign-up post (`/webhook/*`, `/klaviyo/webhook/*`, `/infobip/webhook/*`). Without it (and without `WEBHOOK_SECRET`) those routes accept posts from anyone |
| `WEBHOOK_SECRET` | No | Older alternative: HMAC-SHA256 of the JSON body in `X-Webhook-Signature`. Either passes when set |
| `ADMIN_API_KEY` | No | API key for admin endpoints (`/connections`, `/admin/*`, `/oauth/status`, `/oauth/disconnect`; the last two refuse in production without it) |
| `APP_API_KEY` | For `/app/*` | Shared key the merchant app's server sends as `X-App-Key`. `/app/*` refuses without it |
| `APP_RETURN_ORIGINS` | For `/app/*` | Comma-separated origins the app may be sent back to after connecting, e.g. `https://vivaspot-campaigns.vercel.app` |
| `DEBUG` | No | Enable verbose logging (true/false) |

## Database Schema

The integration uses PostgreSQL with the `pg_trgm` extension for fuzzy matching.

**Tables:**
- `mailchimp_connections` - OAuth tokens and audience mappings
- `pending_oauth` - Temporary state for OAuth flow
- `sync_log` - Contact sync history for debugging
- `auto_mappings` - Auto-mapping rules for hospitality groups

## Auto-Mapping

For hospitality groups with multiple locations sharing one Mailchimp account:

1. Connect the main Mailchimp account once
2. When a new location syncs, the system fuzzy-matches the location name to existing accounts
3. New locations are automatically mapped with their location name as a source tag

This allows contacts from "Joe's Pizza - Main St" and "Joe's Pizza - Oak Ave" to sync to the same audience with different tags.

## Mailchimp Integration Partner Program

To get listed in the Mailchimp Marketplace:

1. Build the integration (this app)
2. Get 25+ active users (unique OAuth connections) within 90 days
3. Implement at least 3 core features:
   - ✅ Contact syncing with subscription status
   - ✅ Tags for segmentation
   - ✅ Merge fields for additional data
4. Apply at https://mailchimppp.smapply.io/

## Development

```bash
# Install dependencies
npm install

# Set up environment
cp .env.example .env
# Edit .env with your credentials

# Run migrations
npm run db:migrate

# Start development server
npm run dev

# Run tests
npm test
```

## License

Proprietary - VivaSpot / iValu8 Inc.
