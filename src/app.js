/**
 * VivaSpot Mailchimp Integration
 * 
 * OAuth-based integration for syncing WiFi-captured contacts
 * to Mailchimp audiences with tagging support.
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

// Routes
const oauthRoutes = require('./routes/oauth');
const webhookRoutes = require('./routes/webhook');
const connectionRoutes = require('./routes/connections');
const healthRoutes = require('./routes/health');
const setupRoutes = require('./routes/setup');
const klaviyoRoutes = require('./routes/klaviyo');
const klaviyoWebhookRoutes = require('./routes/klaviyo-webhook');
const adminSitesRoutes = require('./routes/admin-sites');
const infobipWebhookRoutes = require('./routes/infobip-webhook');
const adminInfobipRoutes = require('./routes/admin-infobip');
const appRoutes = require('./routes/app');

// Database
const db = require('./db');
const { warnIfOpen } = require('./lib/webhookAuth');

const app = express();
const PORT = process.env.PORT || 3000;

// =============================================================================
// Middleware
// =============================================================================

// Security headers
app.use(helmet());

// CORS - adjust origins for production
app.use(cors({
  origin: process.env.NODE_ENV === 'production' 
    ? ['https://vivaspot.com', 'https://admin.vivaspot.com']
    : '*',
  credentials: true
}));

// Rate limiting — exclude /oauth/* so corporate NAT'd IPs and link scanners
// can't lock a customer out of completing their OAuth flow.
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: { error: 'Too many requests, please try again later.' },
  // /app/* is the merchant app's server, behind APP_API_KEY: many merchants share its few IPs.
  skip: (req) => req.path.startsWith('/oauth') || req.path.startsWith('/klaviyo/oauth') || req.path.startsWith('/app/'),
});
app.use(limiter);

// Body parsing
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Request logging in development
if (process.env.DEBUG === 'true') {
  app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
    next();
  });
}

// =============================================================================
// Routes
// =============================================================================

// Health check (no auth required)
app.use('/health', healthRoutes);

// OAuth flow for Mailchimp
app.use('/oauth', oauthRoutes);

// OAuth flow + webhook for Klaviyo (mount specific webhook path first)
app.use('/klaviyo/webhook', klaviyoWebhookRoutes);
app.use('/klaviyo', klaviyoRoutes);

// Infobip: no OAuth, just a webhook. Admin config via /admin/infobip.
app.use('/infobip/webhook', infobipWebhookRoutes);

// Webhook endpoint for receiving contacts from n8n CRM Router
app.use('/webhook', webhookRoutes);

// Connection management (for admin/debugging)
app.use('/connections', connectionRoutes);

// Merchant app (vivaspot-campaigns), server-to-server with X-App-Key
app.use('/app', appRoutes);

// Manual setup (fallback when auto-mapping fails)
app.use('/setup', setupRoutes);

// Admin console for managing vivaspot_sites (HTTP Basic Auth via ADMIN_API_KEY)
app.use('/admin/sites', adminSitesRoutes);
app.use('/admin/infobip', adminInfobipRoutes);

// Root route - redirect to OAuth flow
app.get('/', (req, res) => {
  res.redirect('/oauth/authorize');
});

// =============================================================================
// Error Handling
// =============================================================================

// 404 handler
app.use((req, res) => {
  res.status(404).json({ 
    error: 'Not Found',
    message: `Cannot ${req.method} ${req.path}`
  });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  
  res.status(err.status || 500).json({
    error: err.message || 'Internal Server Error',
    ...(process.env.NODE_ENV !== 'production' && { stack: err.stack })
  });
});

// =============================================================================
// Server Startup
// =============================================================================

// A stray rejected promise is logged, not fatal: one bad request mustn't take
// down the only instance and drop everyone else's sign-ups.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason instanceof Error ? reason.message : reason);
});
// An exception nothing caught may leave the process in a bad state: log it and
// exit so Render restarts a clean one (n8n retries cover the few seconds).
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception, restarting:', error);
  process.exit(1);
});

async function startServer() {
  try {
    // Test database connection
    await db.testConnection();
    console.log('✓ Database connected');

    warnIfOpen();

    // Expired OAuth and setup sessions: cleared hourly (they used to pile up).
    setInterval(() => {
      db.cleanupExpiredOAuth().catch((error) => console.error('OAuth cleanup failed:', error.message));
    }, 60 * 60 * 1000).unref();

    // Start server
    app.listen(PORT, () => {
      console.log(`✓ Server running on port ${PORT}`);
      console.log(`  Environment: ${process.env.NODE_ENV || 'development'}`);
      console.log(`  OAuth Redirect: ${process.env.OAUTH_REDIRECT_URI}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

startServer();

module.exports = app;
