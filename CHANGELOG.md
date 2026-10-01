# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased] - 2026-10-01

### Added
- Merchant app API under `/app/mailchimp/*` (connect, status, audiences, choose audience, disconnect), server to server with `X-App-Key`. Connections made there carry the VivaSpot `acc_id` and the account's MACs, with no fuzzy matching.
- `/oauth/callback` finishes flows started from the app and redirects back to the app (`return_url` must be on `APP_RETURN_ORIGINS`).
- Migration `add_mailchimp_connections_acc_id`.

### Changed
- Consent: the webhook reads `opt_in`. Guests who said yes are `subscribed`; guests who didn't are added as `transactional` (marketing not allowed) with the tag `WiFi: no email consent`. A payload without `opt_in` keeps the old behaviour.
- Contacts for a connection with no audience chosen are held back (409) instead of failing at Mailchimp.

### Security
- `GET /oauth/status/:mac` and `DELETE /oauth/disconnect/:mac` need `ADMIN_API_KEY` (they were open to anyone who knew a MAC).
- The success page no longer injects `redirect_url` unescaped into a script; only http(s) URLs are followed.
- The Mailchimp error shown on the callback page is escaped.

## [1.0.0] - 2026-01-12

### Added
- Initial release
- OAuth 2.0 authentication flow with Mailchimp
- Contact sync webhook endpoint for n8n CRM Router integration
- Automatic audience selection during OAuth setup
- Source tagging for contact segmentation
- Auto-mapping with fuzzy matching for multi-location hospitality groups
- Batch contact sync endpoint (up to 100 contacts)
- Admin endpoints for connection management
- Health check endpoints for monitoring
- PostgreSQL database with pg_trgm extension for fuzzy matching
- Render deployment configuration

### Security
- HMAC signature verification for webhook requests
- API key authentication for admin endpoints
- OAuth state parameter for CSRF protection
