/**
 * IP filtering and rate limiting
 */

const fs = require('fs');
const path = require('path');
const logger = require('./logger');

/**
 * Converts an IP address to a 32-bit integer (for IPv4)
 */
function ipToInt(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  return parts.reduce((acc, part) => (acc << 8) + parseInt(part, 10), 0) >>> 0;
}

/**
 * Checks if an IP address matches a CIDR range
 */
function ipMatchesCIDR(ip, cidr) {
  const [range, bits] = cidr.split('/');
  
  // If no CIDR notation, do exact match
  if (!bits) {
    return ip === cidr;
  }
  
  const ipInt = ipToInt(ip);
  const rangeInt = ipToInt(range);
  
  if (ipInt === null || rangeInt === null) {
    // Not a valid IPv4 address, fall back to exact match
    return ip === cidr;
  }
  
  const mask = (~0 << (32 - parseInt(bits, 10))) >>> 0;
  return (ipInt & mask) === (rangeInt & mask);
}

class IPFilter {
  constructor(config) {
    this.config = config;
    this.blocklist = new Set();
    this.whitelist = new Set();
    this.connectionAttempts = new Map(); // IP -> [{timestamp}]
    this.blockedIPs = new Map(); // IP -> {blockedUntil, reason}
    this.cleanupInterval = null;
  }

  initialize() {
    // Load whitelist from file if configured
    if (this.config.whitelistPath) {
      this.loadWhitelist(this.config.whitelistPath);
    }

    // Load blocklist from file if configured
    if (this.config.blocklistPath) {
      this.loadBlocklist(this.config.blocklistPath);
    }

    // Start cleanup interval to remove old connection attempts
    this.cleanupInterval = setInterval(() => {
      this.cleanupOldAttempts();
    }, 60000); // Clean up every minute

    logger.info('IP filter initialized', {
      whitelistSize: this.whitelist.size,
      blocklistSize: this.blocklist.size,
      rateLimitEnabled: this.config.rateLimitEnabled,
      maxConnectionsPerWindow: this.config.maxConnectionsPerWindow,
      rateLimitWindowMs: this.config.rateLimitWindowMs,
    });
  }

  loadWhitelist(whitelistPath) {
    try {
      const fullPath = path.resolve(whitelistPath);
      
      if (!fs.existsSync(fullPath)) {
        logger.warn(`Whitelist file not found: ${fullPath}`);
        return;
      }

      const content = fs.readFileSync(fullPath, 'utf-8');
      const lines = content.split('\n');
      let count = 0;

      for (const line of lines) {
        const trimmed = line.trim();
        // Skip empty lines and comments
        if (!trimmed || trimmed.startsWith('#')) {
          continue;
        }

        // Support CIDR notation or single IPs
        this.whitelist.add(trimmed);
        count++;
      }

      logger.info(`Loaded ${count} entries from whitelist: ${fullPath}`);
    } catch (err) {
      logger.error(`Failed to load whitelist: ${err.message}`);
    }
  }

  loadBlocklist(blocklistPath) {
    try {
      const fullPath = path.resolve(blocklistPath);
      
      if (!fs.existsSync(fullPath)) {
        logger.warn(`Blocklist file not found: ${fullPath}`);
        return;
      }

      const content = fs.readFileSync(fullPath, 'utf-8');
      const lines = content.split('\n');
      let count = 0;

      for (const line of lines) {
        const trimmed = line.trim();
        // Skip empty lines and comments
        if (!trimmed || trimmed.startsWith('#')) {
          continue;
        }

        // Support CIDR notation or single IPs
        this.blocklist.add(trimmed);
        count++;
      }

      logger.info(`Loaded ${count} IPs from blocklist: ${fullPath}`);
    } catch (err) {
      logger.error(`Failed to load blocklist: ${err.message}`);
    }
  }

  reloadWhitelist() {
    if (!this.config.whitelistPath) {
      return;
    }
    
    this.whitelist.clear();
    this.loadWhitelist(this.config.whitelistPath);
  }

  reloadBlocklist() {
    if (!this.config.blocklistPath) {
      return;
    }
    
    this.blocklist.clear();
    this.loadBlocklist(this.config.blocklistPath);
  }

  isIPWhitelisted(ipAddress) {
    // Handle null/undefined IP addresses
    if (!ipAddress || typeof ipAddress !== 'string') {
      return false;
    }
    
    // Clean IPv6-mapped IPv4 addresses
    const cleanIp = ipAddress.replace(/^::ffff:/i, '');
    
    // Check exact match
    if (this.whitelist.has(cleanIp)) {
      return true;
    }

    // Check if whitelist contains the IP (for IPv6 format too)
    if (this.whitelist.has(ipAddress)) {
      return true;
    }

    // Check CIDR ranges
    for (const entry of this.whitelist) {
      if (ipMatchesCIDR(cleanIp, entry)) {
        return true;
      }
    }

    return false;
  }

  isIPInBlocklist(ipAddress) {
    // Handle null/undefined IP addresses
    if (!ipAddress || typeof ipAddress !== 'string') {
      return false;
    }
    
    // Clean IPv6-mapped IPv4 addresses
    const cleanIp = ipAddress.replace(/^::ffff:/i, '');
    
    // Check exact match
    if (this.blocklist.has(cleanIp)) {
      return true;
    }

    // Check if blocklist contains the IP (for IPv6 format too)
    if (this.blocklist.has(ipAddress)) {
      return true;
    }

    // Check CIDR ranges
    for (const entry of this.blocklist) {
      if (ipMatchesCIDR(cleanIp, entry)) {
        return true;
      }
    }

    return false;
  }

  recordConnectionAttempt(ipAddress) {
    if (!this.config.rateLimitEnabled) {
      return;
    }
    
    // Handle null/undefined IP addresses
    if (!ipAddress || typeof ipAddress !== 'string') {
      return false;
    }

    const now = Date.now();
    const cleanIp = ipAddress.replace(/^::ffff:/i, '');

    if (!this.connectionAttempts.has(cleanIp)) {
      this.connectionAttempts.set(cleanIp, []);
    }

    const attempts = this.connectionAttempts.get(cleanIp);
    attempts.push(now);

    // Keep only attempts within the time window
    const windowStart = now - this.config.rateLimitWindowMs;
    const recentAttempts = attempts.filter(time => time > windowStart);
    this.connectionAttempts.set(cleanIp, recentAttempts);

    // Check if exceeded rate limit
    if (recentAttempts.length > this.config.maxConnectionsPerWindow) {
      this.blockIP(
        cleanIp, 
        this.config.rateLimitBlockDurationMs,
        `Rate limit exceeded: ${recentAttempts.length} connections in ${this.config.rateLimitWindowMs}ms`
      );
      return true; // Exceeded
    }

    return false;
  }

  blockIP(ipAddress, durationMs, reason) {
    const cleanIp = ipAddress.replace(/^::ffff:/i, '');
    const blockedUntil = Date.now() + durationMs;
    
    this.blockedIPs.set(cleanIp, {
      blockedUntil,
      reason,
      blockedAt: Date.now(),
    });

    const durationMin = Math.round(durationMs / 60000);
    logger.warn(`Blocked IP ${cleanIp} for ${durationMin} minutes: ${reason}`);
  }

  isIPBlocked(ipAddress) {
    // Handle null/undefined IP addresses
    if (!ipAddress || typeof ipAddress !== 'string') {
      return { blocked: false };
    }
    
    const cleanIp = ipAddress.replace(/^::ffff:/i, '');
    
    // Check if temporarily blocked
    const blockInfo = this.blockedIPs.get(cleanIp);
    if (blockInfo) {
      if (Date.now() < blockInfo.blockedUntil) {
        return { blocked: true, reason: blockInfo.reason, temporary: true };
      } else {
        // Block expired, remove it
        this.blockedIPs.delete(cleanIp);
      }
    }

    // Check permanent blocklist
    if (this.isIPInBlocklist(ipAddress)) {
      return { blocked: true, reason: 'IP in blocklist', temporary: false };
    }

    return { blocked: false };
  }

  shouldAllowConnection(ipAddress) {
    // Handle null/undefined IP addresses - block them by default
    if (!ipAddress || typeof ipAddress !== 'string') {
      logger.warn('Connection attempt with invalid/undefined IP address');
      return { allowed: false, reason: 'Invalid IP address' };
    }
    
    // Check if IP is whitelisted - if so, bypass all other checks
    if (this.isIPWhitelisted(ipAddress)) {
      logger.debug(`Connection from whitelisted IP: ${ipAddress}`);
      return { allowed: true, whitelisted: true };
    }

    // Check if IP is blocked
    const blockCheck = this.isIPBlocked(ipAddress);
    if (blockCheck.blocked) {
      logger.info(`Blocked connection from ${ipAddress}: ${blockCheck.reason}`);
      return { allowed: false, reason: blockCheck.reason };
    }

    // Record attempt and check rate limit
    const rateLimitExceeded = this.recordConnectionAttempt(ipAddress);
    if (rateLimitExceeded) {
      return { allowed: false, reason: 'Rate limit exceeded' };
    }

    return { allowed: true };
  }

  cleanupOldAttempts() {
    const now = Date.now();
    const windowStart = now - this.config.rateLimitWindowMs;

    // Clean up old connection attempts
    for (const [ip, attempts] of this.connectionAttempts.entries()) {
      const recentAttempts = attempts.filter(time => time > windowStart);
      if (recentAttempts.length === 0) {
        this.connectionAttempts.delete(ip);
      } else {
        this.connectionAttempts.set(ip, recentAttempts);
      }
    }

    // Clean up expired blocks
    for (const [ip, blockInfo] of this.blockedIPs.entries()) {
      if (now >= blockInfo.blockedUntil) {
        this.blockedIPs.delete(ip);
        logger.debug(`Unblocked IP ${ip} (temporary block expired)`);
      }
    }
  }

  getStats() {
    return {
      whitelistSize: this.whitelist.size,
      blocklistSize: this.blocklist.size,
      temporarilyBlockedIPs: this.blockedIPs.size,
      trackedIPs: this.connectionAttempts.size,
    };
  }

  shutdown() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
  }
}

// Singleton instance
let ipFilterInstance = null;

function initializeIPFilter(config) {
  if (!ipFilterInstance) {
    ipFilterInstance = new IPFilter(config);
    ipFilterInstance.initialize();
  }
  return ipFilterInstance;
}

function getIPFilter() {
  return ipFilterInstance;
}

module.exports = {
  initializeIPFilter,
  getIPFilter,
};


