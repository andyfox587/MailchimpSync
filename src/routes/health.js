/**
 * Health Check Routes
 * 
 * Simple health check endpoints for monitoring and load balancer probes.
 */

const express = require('express');
const router = express.Router();

const db = require('../db');

/**
 * Basic health check
 * GET /health
 */
router.get('/', async (req, res) => {
  try {
    // Test database connection
    await db.testConnection();
    
    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      database: 'connected'
    });
  } catch (error) {
    res.status(503).json({
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      error: error.message,
      database: 'disconnected'
    });
  }
});

/**
 * Detailed health check
 * GET /health/detailed
 */
router.get('/detailed', async (req, res) => {
  const health = {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    checks: {}
  };
  
  // Check database
  try {
    const start = Date.now();
    await db.testConnection();
    health.checks.database = {
      status: 'healthy',
      latency_ms: Date.now() - start
    };
  } catch (error) {
    health.status = 'degraded';
    health.checks.database = {
      status: 'unhealthy',
      error: error.message
    };
  }
  
  // Check required environment variables
  const requiredEnvVars = [
    'MAILCHIMP_CLIENT_ID',
    'MAILCHIMP_CLIENT_SECRET',
    'DATABASE_URL',
    'OAUTH_REDIRECT_URI'
  ];
  
  const missingEnvVars = requiredEnvVars.filter(v => !process.env[v]);
  
  health.checks.config = {
    status: missingEnvVars.length === 0 ? 'healthy' : 'unhealthy',
    missing_vars: missingEnvVars
  };
  
  if (missingEnvVars.length > 0) {
    health.status = 'unhealthy';
  }
  
  const statusCode = health.status === 'healthy' ? 200 : 503;
  res.status(statusCode).json(health);
});

/**
 * Readiness check (for Kubernetes/container orchestration)
 * GET /health/ready
 */
router.get('/ready', async (req, res) => {
  try {
    await db.testConnection();
    res.json({ ready: true });
  } catch (error) {
    res.status(503).json({ ready: false, reason: 'database_unavailable' });
  }
});

/**
 * Liveness check (for Kubernetes/container orchestration)
 * GET /health/live
 */
router.get('/live', (req, res) => {
  res.json({ alive: true });
});

module.exports = router;
