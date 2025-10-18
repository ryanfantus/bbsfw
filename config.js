/**
 * Configuration management for bbsfw
 */

// Load environment variables from .env file
require('dotenv').config();

const config = {
  // Port to listen on for incoming connections
  listenPort: parseInt(process.env.LISTEN_PORT || '23', 10),
  
  // Backend server to forward connections to
  backendHost: process.env.BACKEND_HOST || '127.0.0.1',
  backendPort: parseInt(process.env.BACKEND_PORT || '2323', 10),
  
  // Server settings
  maxConnections: parseInt(process.env.MAX_CONNECTIONS || '100', 10),
  connectionTimeout: parseInt(process.env.CONNECTION_TIMEOUT || '300000', 10), // 5 minutes default
  
  // Country blocking (comma-separated ISO 3166-1 alpha-2 country codes)
  // Example: BLOCKED_COUNTRIES=CN,RU,KP
  blockedCountries: process.env.BLOCKED_COUNTRIES 
    ? process.env.BLOCKED_COUNTRIES.split(',').map(c => c.trim().toUpperCase()).filter(c => c)
    : [],
  
  // Block connections when country cannot be determined
  blockUnknownCountries: process.env.BLOCK_UNKNOWN_COUNTRIES === 'true',
  
  // IP blocklist file path
  blocklistPath: process.env.BLOCKLIST_PATH || '',
  
  // IP whitelist file path (IPs exempt from all firewall rules)
  whitelistPath: process.env.WHITELIST_PATH || '',
  
  // Rate limiting / flood protection
  rateLimitEnabled: process.env.RATE_LIMIT_ENABLED !== 'false', // Enabled by default
  maxConnectionsPerWindow: parseInt(process.env.MAX_CONNECTIONS_PER_WINDOW || '10', 10),
  rateLimitWindowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10), // 1 minute default
  rateLimitBlockDurationMs: parseInt(process.env.RATE_LIMIT_BLOCK_DURATION_MS || '300000', 10), // 5 minutes default
  
  // Logging
  logLevel: process.env.LOG_LEVEL || 'info',
};

/**
 * Validates the configuration
 */
function validateConfig() {
  const errors = [];
  
  if (config.listenPort < 1 || config.listenPort > 65535) {
    errors.push('LISTEN_PORT must be between 1 and 65535');
  }
  
  if (config.backendPort < 1 || config.backendPort > 65535) {
    errors.push('BACKEND_PORT must be between 1 and 65535');
  }
  
  if (!config.backendHost) {
    errors.push('BACKEND_HOST is required');
  }
  
  if (config.maxConnectionsPerWindow < 1) {
    errors.push('MAX_CONNECTIONS_PER_WINDOW must be at least 1');
  }
  
  if (config.rateLimitWindowMs < 1000) {
    errors.push('RATE_LIMIT_WINDOW_MS must be at least 1000 (1 second)');
  }
  
  if (errors.length > 0) {
    throw new Error('Configuration validation failed:\n' + errors.join('\n'));
  }
  
  return true;
}

module.exports = {
  config,
  validateConfig,
};

