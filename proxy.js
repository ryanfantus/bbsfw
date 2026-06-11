/**
 * TCP proxy connection handler
 */

const net = require('net');
const logger = require('./logger');
const { config } = require('./config');
const { getGeoIP } = require('./geoip');
const { getIPFilter } = require('./ipfilter');
const { detectFromTelnetNegotiation, getBackendPortForEncoding } = require('./encoding-detector');

// When the last proxied session ended. Used for the post-session grace period:
// a single-line backend (real C64 hardware) needs a few seconds to recycle
// after a caller disconnects before it can answer the next one.
let lastSessionEndMs = 0;

class ProxyConnection {
  constructor(clientSocket, backendHost, backendPort) {
    this.clientSocket = clientSocket;
    this.backendHost = backendHost;
    this.backendPort = backendPort;
    this.backendSocket = null;
    this.clientAddress = `${clientSocket.remoteAddress || 'unknown'}:${clientSocket.remotePort || 'unknown'}`;
    this.connectionId = this.generateConnectionId();
    this.bytesFromClient = 0;
    this.bytesFromBackend = 0;
    this.isCleanedUp = false;
    this.detectedEncoding = 'cp437'; // Default encoding
    this.terminalType = null;
    this.backendConnected = false;
    this.graceTimer = null;
    this.graceBuffer = null;
    this.graceDataHandler = null;
    this.clientHandlersAttached = false;
  }

  generateConnectionId() {
    return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  }

  connect() {
    const clientIp = this.clientSocket.remoteAddress;
    
    // Handle edge case where remoteAddress is undefined
    if (!clientIp) {
      logger.warn(`[${this.connectionId}] Connection rejected: unable to determine client IP address`);
      // Add error handler before closing to prevent unhandled errors
      this.clientSocket.on('error', (err) => {
        logger.debug(`[${this.connectionId}] Client socket error during rejection: ${err.message}`);
      });
      // destroy() (not end()): rejected sockets have no data handler, so if the
      // client already sent bytes, end() never completes and 'close' never fires
      this.clientSocket.destroy();
      return;
    }
    
    logger.info(`[${this.connectionId}] New connection from ${this.clientAddress}`);
    
    // Check IP filter (whitelist, blocklist, and rate limiting)
    const ipFilter = getIPFilter();
    let isWhitelisted = false;
    
    if (ipFilter) {
      const filterResult = ipFilter.shouldAllowConnection(clientIp);
      if (!filterResult.allowed) {
        logger.warn(`[${this.connectionId}] Connection blocked by IP filter: ${filterResult.reason}`);
        // Add error handler before closing to prevent unhandled errors
        this.clientSocket.on('error', (err) => {
          logger.debug(`[${this.connectionId}] Client socket error during rejection: ${err.message}`);
        });
        this.clientSocket.destroy();
        return;
      }
      isWhitelisted = filterResult.whitelisted || false;
    }
    
    // Check country blocking (skip for whitelisted IPs)
    if (!isWhitelisted && this.shouldBlockConnection(clientIp)) {
      logger.warn(`[${this.connectionId}] Connection blocked by country filter`);
      // Add error handler before closing to prevent unhandled errors
      this.clientSocket.on('error', (err) => {
        logger.debug(`[${this.connectionId}] Client socket error during rejection: ${err.message}`);
      });
      this.clientSocket.destroy();
      return;
    }
    
    // Disable Nagle's algorithm for better real-time performance
    this.clientSocket.setNoDelay(true);
    this.clientSocket.setKeepAlive(true);

    // Post-session grace period: hold the caller until the backend has had
    // time to recycle after the previous session
    const graceRemaining = config.postSessionGraceMs > 0
      ? config.postSessionGraceMs - (Date.now() - lastSessionEndMs)
      : 0;

    if (graceRemaining > 0) {
      this.holdForGracePeriod(graceRemaining);
      return;
    }

    this.connectToBackend();
  }

  holdForGracePeriod(waitMs) {
    logger.info(`[${this.connectionId}] Holding connection for ${waitMs}ms (post-session grace, backend recycling)`);
    this.clientHandlersAttached = true;

    // Buffer client bytes (e.g. telnet IAC negotiation) sent while held, so
    // they reach the backend in order once connected
    this.graceBuffer = [];
    this.graceDataHandler = (data) => {
      this.graceBuffer.push(data);
    };
    this.clientSocket.on('data', this.graceDataHandler);

    this.clientSocket.on('error', (err) => {
      logger.error(`[${this.connectionId}] Client socket error: ${err.message}`);
      this.cleanup('client-error');
    });
    this.clientSocket.on('close', (hadError) => {
      logger.debug(`[${this.connectionId}] Client socket closed during grace hold (hadError: ${hadError})`);
      this.cleanup('client-close');
    });

    this.graceTimer = setTimeout(() => {
      this.graceTimer = null;
      if (this.isCleanedUp) {
        return;
      }
      this.connectToBackend();
    }, waitMs);
  }

  connectToBackend() {
    // Determine backend port based on encoding (if detection is enabled)
    const actualBackendPort = config.encodingDetection 
      ? getBackendPortForEncoding(this.detectedEncoding, config)
      : this.backendPort;
    
    if (config.encodingDetection) {
      logger.info(`[${this.connectionId}] Using backend port ${actualBackendPort} for encoding: ${this.detectedEncoding}`);
    }
    
    // Create connection to backend server
    this.backendSocket = net.createConnection({
      host: this.backendHost,
      port: actualBackendPort,
    }, () => {
      const backendAddr = `${this.backendSocket.remoteAddress}:${this.backendSocket.remotePort}`;
      const localAddr = `${this.backendSocket.localAddress}:${this.backendSocket.localPort}`;
      logger.info(`[${this.connectionId}] Connected to backend ${backendAddr} (from ${localAddr})`);
      this.backendConnected = true;
      // Disable Nagle's algorithm on backend socket too
      this.backendSocket.setNoDelay(true);
      this.backendSocket.setKeepAlive(true);
    });

    // Forward bytes the client sent while held for the grace period (Node
    // queues writes made before the backend connection completes)
    if (this.graceDataHandler) {
      this.clientSocket.removeListener('data', this.graceDataHandler);
      this.graceDataHandler = null;
    }
    if (this.graceBuffer) {
      for (const chunk of this.graceBuffer) {
        this.bytesFromClient += chunk.length;
        this.backendSocket.write(chunk);
      }
      this.graceBuffer = null;
    }

    // Setup error handlers BEFORE other handlers to catch connection errors
    this.setupErrorHandlers();
    
    // Setup bidirectional data flow
    this.setupPipes();
    
    // Setup close handlers
    this.setupCloseHandlers();
  }

  shouldBlockConnection(ipAddress) {
    const geoip = getGeoIP();
    
    // If GeoIP is not enabled, don't block
    if (!geoip || !geoip.isEnabled) {
      return false;
    }
    
    // Get country info
    const geoInfo = geoip.getCountryInfo(ipAddress);
    
    // Handle unknown countries
    if (!geoInfo || !geoInfo.countryCode) {
      if (config.blockUnknownCountries) {
        logger.info(`[${this.connectionId}] Blocked unknown country for IP: ${ipAddress}`);
        return true;
      }
      return false;
    }
    
    // Log country info
    logger.debug(`[${this.connectionId}] Connection from ${geoInfo.countryName} (${geoInfo.countryCode})`);
    
    // Check if country is blocked
    if (config.blockedCountries.length > 0) {
      const isBlocked = config.blockedCountries.includes(geoInfo.countryCode.toUpperCase());
      if (isBlocked) {
        logger.info(`[${this.connectionId}] Blocked ${geoInfo.countryName} (${geoInfo.countryCode})`);
      }
      return isBlocked;
    }
    
    return false;
  }

  setupPipes() {
    // Forward data from client to backend
    this.clientSocket.on('data', (data) => {
      this.bytesFromClient += data.length;
      const preview = data.toString('hex').substring(0, 60);
      logger.debug(`[${this.connectionId}] Client → Backend: ${data.length} bytes [${preview}${data.length > 30 ? '...' : ''}]`);
      if (this.backendSocket && !this.backendSocket.destroyed) {
        if (!this.backendSocket.write(data)) {
          logger.debug(`[${this.connectionId}] Backend socket buffer full, pausing client`);
          this.clientSocket.pause();
          this.backendSocket.once('drain', () => {
            logger.debug(`[${this.connectionId}] Backend socket drained, resuming client`);
            this.clientSocket.resume();
          });
        }
      }
    });

    // Forward data from backend to client
    this.backendSocket.on('data', (data) => {
      this.bytesFromBackend += data.length;
      const preview = data.toString('hex').substring(0, 60);
      logger.debug(`[${this.connectionId}] Backend → Client: ${data.length} bytes [${preview}${data.length > 30 ? '...' : ''}]`);
      if (this.clientSocket && !this.clientSocket.destroyed) {
        if (!this.clientSocket.write(data)) {
          logger.debug(`[${this.connectionId}] Client socket buffer full, pausing backend`);
          this.backendSocket.pause();
          this.clientSocket.once('drain', () => {
            logger.debug(`[${this.connectionId}] Client socket drained, resuming backend`);
            this.backendSocket.resume();
          });
        }
      }
    });
  }

  setupErrorHandlers() {
    // Held connections already have client error/close handlers attached
    if (!this.clientHandlersAttached) {
      this.clientSocket.on('error', (err) => {
        logger.error(`[${this.connectionId}] Client socket error: ${err.message}`);
        this.cleanup('client-error');
      });
    }

    this.backendSocket.on('error', (err) => {
      logger.error(`[${this.connectionId}] Backend socket error: ${err.message}`);
      this.cleanup('backend-error');
    });
  }

  setupCloseHandlers() {
    if (!this.clientHandlersAttached) {
      this.clientSocket.on('close', (hadError) => {
        logger.debug(`[${this.connectionId}] Client socket closed (hadError: ${hadError})`);
        this.cleanup('client-close');
      });
    }

    this.backendSocket.on('close', (hadError) => {
      logger.debug(`[${this.connectionId}] Backend socket closed (hadError: ${hadError})`);
      this.cleanup('backend-close');
    });
  }

  cleanup(reason) {
    if (this.isCleanedUp) {
      return; // Prevent duplicate cleanup
    }
    this.isCleanedUp = true;

    if (this.graceTimer) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }

    // Only a session that actually reached the backend arms the grace period
    if (this.backendConnected) {
      lastSessionEndMs = Date.now();
    }

    logger.info(`[${this.connectionId}] Connection closed (reason: ${reason}). Bytes: client→backend=${this.bytesFromClient}, backend→client=${this.bytesFromBackend}`);
    
    if (this.clientSocket && !this.clientSocket.destroyed) {
      this.clientSocket.destroy();
    }
    
    if (this.backendSocket && !this.backendSocket.destroyed) {
      this.backendSocket.destroy();
    }
  }
}

function handleConnection(clientSocket, backendHost, backendPort) {
  const proxy = new ProxyConnection(clientSocket, backendHost, backendPort);
  proxy.connect();
}

module.exports = {
  handleConnection,
};

