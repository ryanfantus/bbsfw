/**
 * SSH Server for bbsfw
 * Handles SSH connections and proxies them to the backend telnet server
 */

const ssh2 = require('ssh2');
const net = require('net');
const fs = require('fs');
const logger = require('./logger');
const { getIPFilter } = require('./ipfilter');

/**
 * Creates and starts the SSH server
 */
function createSSHServer(config) {
  if (!config.sshEnabled) {
    return null;
  }

  // Read the SSH host key file
  let hostKey;
  try {
    hostKey = fs.readFileSync(config.sshHostKey, 'utf8');
  } catch (err) {
    logger.error(`Failed to read SSH host key from ${config.sshHostKey}:`, err.message);
    logger.error('Generate a host key with: ssh-keygen -t rsa -b 4096 -f ssh_host_key -N ""');
    process.exit(1);
  }

  const server = new ssh2.Server(
    {
      hostKeys: [hostKey],
      algorithms: {
        cipher: config.sshCiphers,
      },
    },
    (client) => {
      // Get client IP from the socket
      const clientIP = client._sock?.remoteAddress || 'unknown';
      logger.info(`SSH client connected from ${clientIP}`);

      // Check if IP should be blocked before authentication
      const ipFilter = getIPFilter();
      if (ipFilter) {
        const accessCheck = ipFilter.shouldAllowConnection(clientIP);
        if (!accessCheck.allowed) {
          logger.warn(`SSH connection blocked from ${clientIP}: ${accessCheck.reason}`);
          client.end();
          return;
        }
      }

      client.on('authentication', (ctx) => {
        // Accept any username/password combination
        logger.info(`SSH authentication attempt from ${clientIP} with username: ${ctx.username}`);
        
        if (ctx.method === 'password' || ctx.method === 'none') {
          // Accept any credentials
          ctx.accept();
        } else {
          // Only support password and none authentication
          ctx.reject(['password', 'none']);
        }
      });

      client.on('ready', () => {
        logger.info(`SSH client ${clientIP} authenticated successfully`);

        client.on('session', (accept, reject) => {
          logger.debug(`Session requested for ${clientIP}, accept type: ${typeof accept}`);
          
          if (typeof accept !== 'function') {
            logger.error(`Session accept is not a function for ${clientIP}, got: ${typeof accept}`);
            return;
          }
          
          const session = accept();

          // Handle PTY request first (must come before shell)
          session.on('pty', (accept, reject, info) => {
            logger.debug(`PTY requested for ${clientIP}, accept type: ${typeof accept}, term: ${info.term}`);
            if (typeof accept === 'function') {
              // Accept the PTY in raw mode - disable all terminal processing
              // This is critical for binary protocols like Zmodem
              // Set terminal modes to completely raw/transparent mode
              accept();
            } else {
              logger.warn(`PTY accept is not a function for ${clientIP}`);
            }
          });

          // Handle window change requests
          session.on('window-change', (info) => {
            // Window size changes are informational only
            logger.debug(`Window change for ${clientIP}: ${info.cols}x${info.rows}`);
          });

          // Handle shell request
          session.on('shell', (accept, reject) => {
            logger.debug(`Shell requested for ${clientIP}, accept type: ${typeof accept}`);
            
            if (typeof accept !== 'function') {
              logger.error(`Shell accept is not a function for ${clientIP}`);
              return;
            }
            
            const stream = accept();
            logger.info(`SSH shell session started for ${clientIP}`);

            // CRITICAL: Keep everything in binary Buffer mode - no encoding!
            // ssh2 streams are already binary, don't mess with them
            stream.allowHalfOpen = true;

            // Connect to backend telnet server
            const backendSocket = new net.Socket();
            
            // Configure socket for optimal binary transfer
            backendSocket.setNoDelay(true);    // Disable Nagle's algorithm
            backendSocket.setKeepAlive(true, 30000);  // Enable TCP keepalive
            
            backendSocket.connect(config.backendPort, config.backendHost, () => {
              logger.info(`SSH client ${clientIP} connected to backend ${config.backendHost}:${config.backendPort}`);
              
              // Ensure backend socket is optimized
              backendSocket.setNoDelay(true);
            });

            // Pipe data bidirectionally with proper backpressure handling
            // Use the exact same pattern as the working telnet proxy
            let bytesFromClient = 0;
            let bytesFromBackend = 0;
            
            // SSH stream -> Backend socket
            stream.on('data', (data) => {
              bytesFromClient += data.length;
              
              if (!backendSocket.writable || backendSocket.destroyed) {
                logger.debug(`Backend not writable, dropping ${data.length} bytes`);
                return;
              }
              
              // Write as-is, data is already a Buffer
              const needsDrain = !backendSocket.write(data);
              if (needsDrain) {
                logger.debug(`Backend buffer full, pausing SSH stream`);
                stream.pause();
                backendSocket.once('drain', () => {
                  logger.debug(`Backend drained, resuming SSH stream`);
                  if (!stream.destroyed) {
                    stream.resume();
                  }
                });
              }
            });
            
            // Backend socket -> SSH stream
            backendSocket.on('data', (data) => {
              bytesFromBackend += data.length;
              
              if (!stream.writable || stream.destroyed) {
                logger.debug(`SSH stream not writable, dropping ${data.length} bytes`);
                return;
              }
              
              // Write as-is, data is already a Buffer
              const needsDrain = !stream.write(data);
              if (needsDrain) {
                logger.debug(`SSH stream buffer full, pausing backend`);
                backendSocket.pause();
                stream.once('drain', () => {
                  logger.debug(`SSH stream drained, resuming backend`);
                  if (!backendSocket.destroyed) {
                    backendSocket.resume();
                  }
                });
              }
            });

            // Handle backend socket errors
            backendSocket.on('error', (err) => {
              logger.error(`Backend connection error for SSH client ${clientIP}:`, err.message);
              stream.end();
            });

            backendSocket.on('close', () => {
              logger.info(`Backend connection closed for SSH client ${clientIP}`);
              stream.end();
            });

            // Handle stream close
            stream.on('close', () => {
              logger.info(`SSH stream closed for ${clientIP}. Bytes: client→backend=${bytesFromClient}, backend→client=${bytesFromBackend}`);
              if (!backendSocket.destroyed) {
                backendSocket.destroy();
              }
            });

            stream.on('error', (err) => {
              logger.error(`SSH stream error for ${clientIP}:`, err.message);
              if (!backendSocket.destroyed) {
                backendSocket.destroy();
              }
            });
          });

          // Handle exec requests (some clients use this instead of shell)
          session.on('exec', (accept, reject, info) => {
            logger.debug(`Exec request from ${clientIP}: ${info.command}`);
            // Reject exec - we only support interactive shell
            reject();
          });
        });
      });

      client.on('error', (err) => {
        logger.error(`SSH client error:`, err.message);
      });

      client.on('close', () => {
        logger.info(`SSH client ${clientIP} disconnected`);
      });
    }
  );

  return server;
}

/**
 * Starts the SSH server
 */
function startSSHServer(config, activeConnectionsTracker) {
  const server = createSSHServer(config);
  
  if (!server) {
    logger.info('SSH server is disabled');
    return null;
  }

  server.on('error', (err) => {
    logger.error('SSH server error:', err.message);
    if (err.code === 'EADDRINUSE') {
      logger.error(`SSH port ${config.sshListenPort} is already in use`);
      process.exit(1);
    }
  });

  server.listen(config.sshListenPort, () => {
    logger.info(`SSH server listening on port ${config.sshListenPort}`);
    logger.info(`SSH connections will be forwarded to ${config.backendHost}:${config.backendPort}`);
  });

  return server;
}

module.exports = {
  createSSHServer,
  startSSHServer,
};

