#!/usr/bin/env node

/**
 * BBS Firewall (bbsfw)
 * TCP proxy server for telnet connections
 */

const net = require('net');
const { config, validateConfig } = require('./config');
const logger = require('./logger');
const { handleConnection } = require('./proxy');
const { initializeGeoIP } = require('./geoip');
const { initializeIPFilter } = require('./ipfilter');

class BBSFirewall {
  constructor() {
    this.server = null;
    this.activeConnections = 0;
  }

  async start() {
    try {
      validateConfig();
    } catch (err) {
      logger.error('Configuration error:', err.message);
      process.exit(1);
    }

    logger.info('Starting BBS Firewall...');
    
    // Initialize GeoIP database
    await initializeGeoIP();
    
    // Initialize IP filter
    initializeIPFilter(config);
    
    logger.info(`Configuration:`, {
      listenPort: config.listenPort,
      backendHost: config.backendHost,
      backendPort: config.backendPort,
      maxConnections: config.maxConnections,
      blockedCountries: config.blockedCountries.length > 0 
        ? config.blockedCountries.join(', ') 
        : 'none',
      rateLimitEnabled: config.rateLimitEnabled,
      maxConnectionsPerWindow: config.maxConnectionsPerWindow,
      rateLimitWindowMs: `${config.rateLimitWindowMs}ms`,
      blocklistPath: config.blocklistPath || 'none',
    });

    this.server = net.createServer((clientSocket) => {
      this.handleNewConnection(clientSocket);
    });

    this.server.on('error', (err) => {
      logger.error('Server error:', err.message);
      if (err.code === 'EADDRINUSE') {
        logger.error(`Port ${config.listenPort} is already in use`);
        process.exit(1);
      }
    });

    this.server.listen(config.listenPort, () => {
      logger.info(`BBS Firewall listening on port ${config.listenPort}`);
      logger.info(`Forwarding connections to ${config.backendHost}:${config.backendPort}`);
    });

    this.setupGracefulShutdown();
  }

  handleNewConnection(clientSocket) {
    // Check max connections limit
    if (this.activeConnections >= config.maxConnections) {
      logger.warn(`Connection rejected: max connections (${config.maxConnections}) reached`);
      clientSocket.end();
      return;
    }

    this.activeConnections++;
    logger.debug(`Active connections: ${this.activeConnections}`);

    // Set connection timeout
    if (config.connectionTimeout > 0) {
      clientSocket.setTimeout(config.connectionTimeout);
      clientSocket.on('timeout', () => {
        logger.info(`Connection timeout for ${clientSocket.remoteAddress}`);
        clientSocket.destroy();
      });
    }

    // Handle the proxy connection
    handleConnection(clientSocket, config.backendHost, config.backendPort);

    // Track connection close
    clientSocket.on('close', () => {
      this.activeConnections--;
      logger.debug(`Active connections: ${this.activeConnections}`);
    });
  }

  setupGracefulShutdown() {
    const shutdown = () => {
      logger.info('Shutting down gracefully...');
      
      if (this.server) {
        this.server.close(() => {
          logger.info('Server closed');
          process.exit(0);
        });

        // Force shutdown after 10 seconds
        setTimeout(() => {
          logger.warn('Forcing shutdown');
          process.exit(1);
        }, 10000);
      } else {
        process.exit(0);
      }
    };

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  }
}

// Start the firewall
if (require.main === module) {
  const firewall = new BBSFirewall();
  firewall.start();
}

module.exports = BBSFirewall;

