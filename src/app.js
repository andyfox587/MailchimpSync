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

// Database
const db = require('./db');

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

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: { error: 'Too many requests, please try again later.' }
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

// Webhook endpoint for receiving contacts from n8n CRM Router
app.use('/webhook', webhookRoutes);

// Connection management (for admin/debugging)
app.use('/connections', connectionRoutes);

// Manual setup (fallback when auto-mapping fails)
app.use('/setup', setupRoutes);

// Root route - basic info
app.get('/', (req, res) => {
  res.json({
    name: 'VivaSpot Mailchimp Integration',
    version: '1.0.0',
    status: 'running',
    endpoints: {
      oauth: {
        authorize: '/oauth/authorize?mac_address=XX:XX:XX:XX:XX:XX',
        callback: '/oauth/callback'
      },
      webhook: {
        contact: 'POST /webhook/contact'
      },
      health: '/health'
    }
  });
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

async function startServer() {
  try {
    // Test database connection
    await db.testConnection();
    console.log('✓ Database connected');

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
