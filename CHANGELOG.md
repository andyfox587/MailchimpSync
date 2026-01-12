# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
