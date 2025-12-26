/**
 * Encoding detection for UTF-8 vs CP437
 * Detects client encoding preference from various sources
 */

const logger = require('./logger');

/**
 * Detect encoding from SSH environment variables
 * @param {Object} env - Environment variables from SSH client
 * @returns {string} 'utf8' or 'cp437'
 */
function detectFromSSHEnvironment(env) {
  if (!env) {
    return 'cp437';
  }

  // Check LANG and LC_* variables for UTF-8 indicators
  const langVars = ['LANG', 'LC_ALL', 'LC_CTYPE'];
  
  for (const varName of langVars) {
    const value = env[varName];
    if (value && typeof value === 'string') {
      const upperValue = value.toUpperCase();
      
      // Check for UTF-8 indicators
      if (upperValue.includes('UTF-8') || upperValue.includes('UTF8')) {
        logger.debug(`Detected UTF-8 from ${varName}=${value}`);
        return 'utf8';
      }
    }
  }

  // If no UTF-8 indicators found, default to CP437
  logger.debug('No UTF-8 indicators in environment, defaulting to CP437');
  return 'cp437';
}

/**
 * Detect encoding from terminal type
 * @param {string} termType - Terminal type (e.g., 'xterm', 'ansi')
 * @returns {string} 'utf8' or 'cp437'
 */
function detectFromTerminalType(termType) {
  if (!termType || typeof termType !== 'string') {
    return 'cp437';
  }

  const term = termType.toLowerCase();

  // Modern terminals that typically support UTF-8
  const utf8Terminals = [
    'xterm-256color',
    'xterm-color',
    'xterm',
    'screen-256color',
    'screen',
    'rxvt-unicode',
    'konsole',
    'gnome',
    'linux',
    'vt220',
    'vt100'
  ];

  // DOS/ANSI terminals that typically use CP437
  const cp437Terminals = [
    'ansi',
    'ansi-bbs',
    'ansi-mono',
    'ansi-color',
    'pcansi',
    'scoansi'
  ];

  // Check for UTF-8 terminals
  for (const utf8Term of utf8Terminals) {
    if (term.includes(utf8Term)) {
      logger.debug(`Detected UTF-8 from terminal type: ${termType}`);
      return 'utf8';
    }
  }

  // Check for CP437 terminals
  for (const cp437Term of cp437Terminals) {
    if (term.includes(cp437Term)) {
      logger.debug(`Detected CP437 from terminal type: ${termType}`);
      return 'cp437';
    }
  }

  // Default to CP437 if unknown
  logger.debug(`Unknown terminal type: ${termType}, defaulting to CP437`);
  return 'cp437';
}

/**
 * Detect encoding from Telnet negotiation data
 * This checks for any telnet options that might indicate encoding
 * @param {string} termType - Terminal type from TERM negotiation
 * @returns {string} 'utf8' or 'cp437'
 */
function detectFromTelnetNegotiation(termType) {
  return detectFromTerminalType(termType);
}

/**
 * Get backend port based on detected encoding
 * @param {string} encoding - 'utf8' or 'cp437'
 * @param {Object} config - Configuration object
 * @returns {number} Backend port number
 */
function getBackendPortForEncoding(encoding, config) {
  if (!config.encodingDetection) {
    // If encoding detection is disabled, use default backend port
    return config.backendPort;
  }

  if (encoding === 'utf8') {
    logger.debug(`Using UTF-8 backend port: ${config.backendPortUTF8}`);
    return config.backendPortUTF8;
  } else {
    logger.debug(`Using CP437 backend port: ${config.backendPortCP437}`);
    return config.backendPortCP437;
  }
}

module.exports = {
  detectFromSSHEnvironment,
  detectFromTerminalType,
  detectFromTelnetNegotiation,
  getBackendPortForEncoding,
};


