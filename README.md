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
    "X-Webhook-Signature": "{{ $secret.MAILCHIMP_WEBHOOK_SECRET }}"
  },
  "body": {
    "mac_address": "{{ $json.mac_address }}",
    "email": "{{ $json.email }}",
    "first_name": "{{ $json.first_name }}",
    "last_name": "{{ $json.last_name }}",
    "phone": "{{ $json.phone }}",
    "location_name": "{{ $json.location_name }}"
  }
}
```

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
| `WEBHOOK_SECRET` | No | HMAC secret for webhook signature verification |
| `ADMIN_API_KEY` | No | API key for admin endpoints |
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
