# BBS Firewall (bbsfw)

A lightweight TCP proxy firewall for BBS telnet connections, built with Node.js.

## Features

- **TCP Proxy**: Forwards telnet connections to an internal BBS server
- **SSH Server**: Built-in SSH server that proxies to telnet backend (accepts any credentials)
  - Note: Use telnet for binary file transfers (Zmodem, etc.); SSH is best for browsing
- **Connection Management**: Tracks active connections and enforces limits
- **Logging**: Detailed connection and traffic logging
- **Configurable**: Easy configuration via environment variables
- **Graceful Shutdown**: Handles SIGTERM/SIGINT for clean shutdowns
- **Legacy Cipher Support**: Configurable SSH ciphers for old BBS clients
- **Few External Dependencies**: Uses only Node.js built-in modules and minimal packages

## Installation

1. Clone or download this repository
2. Ensure Node.js 14+ is installed
3. Install dependencies:

```bash
npm install
```

4. (Optional) Set up GeoIP database for country blocking:

```bash
npm run setup-geoip
```

Follow the on-screen instructions to download the MaxMind GeoLite2 Country database. You'll need to sign up for a free account at https://dev.maxmind.com/geoip/geolite2-free-geolocation-data

5. Copy `.env.example` to `.env` and configure as needed

```bash
cp .env.example .env
```

## Configuration

Configure the firewall by setting environment variables or editing `.env`:

| Variable | Description | Default |
|----------|-------------|---------|
| `LISTEN_PORT` | Port to listen on for incoming telnet connections | `2323` |
| `BACKEND_HOST` | Backend BBS server hostname/IP (use 127.0.0.1 for IPv4) | `127.0.0.1` |
| `BACKEND_PORT` | Backend BBS server port | `23` |
| `MAX_CONNECTIONS` | Maximum simultaneous connections | `100` |
| `CONNECTION_TIMEOUT` | Connection timeout in milliseconds (0 to disable) | `300000` (5 min) |
| `SSH_ENABLED` | Enable SSH server | `false` |
| `SSH_LISTEN_PORT` | Port to listen on for incoming SSH connections | `2222` |
| `SSH_HOST_KEY` | Path to SSH host private key file | `./ssh_host_key` |
| `SSH_CIPHERS` | Comma-separated list of allowed SSH ciphers | _(see below)_ |
| `BLOCKED_COUNTRIES` | Comma-separated ISO country codes to block (e.g., CN,RU,KP) | _(empty)_ |
| `BLOCK_UNKNOWN_COUNTRIES` | Block connections when country cannot be determined | `false` |
| `WHITELIST_PATH` | Path to IP whitelist file (exempt from all firewall rules) | _(empty)_ |
| `BLOCKLIST_PATH` | Path to IP blocklist file | _(empty)_ |
| `RATE_LIMIT_ENABLED` | Enable connection flood protection | `true` |
| `MAX_CONNECTIONS_PER_WINDOW` | Max connections per IP within time window | `10` |
| `RATE_LIMIT_WINDOW_MS` | Time window for rate limiting in milliseconds | `60000` (1 min) |
| `RATE_LIMIT_BLOCK_DURATION_MS` | How long to block IPs that exceed rate limit (ms) | `300000` (5 min) |
| `LOG_LEVEL` | Logging level: debug, info, warn, error | `info` |

## Usage

### Start the firewall

```bash
npm start
```

Or with custom configuration:

```bash
LISTEN_PORT=2323 BACKEND_HOST=192.168.1.100 BACKEND_PORT=23 npm start
```

### Connect to the firewall

Use any telnet client to connect:

```bash
telnet localhost 2323
```

The connection will be forwarded to your configured backend server.

## SSH Server

bbsfw includes an optional SSH server that allows users to connect via SSH instead of raw telnet. The SSH server accepts **any username and password combination** and immediately proxies the connection to your backend BBS via telnet.

**⚠️ Important:** Binary file transfers (Zmodem, Ymodem, etc.) do not work reliably over SSH due to PTY character processing. Users should use the telnet connection for file transfers. See [Known Limitations](#known-limitations) below.

### Why SSH?

- **Encrypted connections**: All traffic between client and firewall is encrypted
- **Legacy client support**: Many old BBS terminal programs support SSH with older ciphers
- **Drop-in replacement**: Users can connect via SSH without changes to your backend BBS
- **Best for browsing**: Ideal for reading messages, viewing content, and interactive BBS use

### Setup

1. **Generate an SSH host key:**

```bash
ssh-keygen -t rsa -b 4096 -f ssh_host_key -N "" -m PEM
```

This creates a private key file (`ssh_host_key`) in PEM format that the SSH server will use.

**Note:** The `-m PEM` flag is important - it generates the key in the traditional PEM format which is compatible with the ssh2 library. If you already have a key in OpenSSH format, you can convert it:

```bash
ssh-keygen -p -m PEM -f ssh_host_key -N ""
```

2. **Enable SSH in your `.env` file:**

```bash
SSH_ENABLED=true
SSH_LISTEN_PORT=2222
SSH_HOST_KEY=./ssh_host_key
```

3. **Start the firewall:**

```bash
npm start
```

The SSH server will start alongside the telnet proxy.

### Connect via SSH

Users can connect with any SSH client:

```bash
ssh -p 2222 anyusername@yourdomain.com
```

When prompted for a password, they can enter **anything** - all credentials are accepted.

### Legacy Cipher Support

Many older BBS terminal programs (like SyncTERM) only support older SSH ciphers. bbsfw includes these by default, but you can customize the cipher list:

**Default ciphers:**
- `aes128-gcm@openssh.com`
- `aes256-gcm@openssh.com`
- `aes128-ctr`, `aes192-ctr`, `aes256-ctr`
- `aes128-cbc`, `aes192-cbc`, `aes256-cbc`
- `3des-cbc` (for very old clients)

**Custom cipher configuration:**

```bash
# In .env file
SSH_CIPHERS=aes128-ctr,aes256-ctr,aes128-cbc,3des-cbc
```

Separate ciphers with commas. Order matters - the first matching cipher will be used.

### How It Works

1. Client connects to SSH server on `SSH_LISTEN_PORT`
2. SSH handshake occurs (encryption negotiation)
3. Client authenticates with any username/password (all accepted)
4. Shell session is established
5. SSH server opens a telnet connection to `BACKEND_HOST:BACKEND_PORT`
6. All data is proxied bidirectionally:
   - Client ↔ SSH (encrypted) ↔ bbsfw ↔ Telnet (unencrypted) ↔ Backend BBS
7. All firewall rules apply (country blocking, rate limiting, IP filtering)

### Security Notes

- **No authentication**: The SSH server accepts any credentials. Security comes from IP filtering, country blocking, and rate limiting.
- **Backend connection is unencrypted**: The connection from bbsfw to your backend BBS is still telnet (unencrypted). Only the client-to-firewall connection is encrypted.
- **Host key verification**: Clients will see a host key fingerprint on first connection. They should verify this matches your server.

### Known Limitations

**Binary File Transfers (Zmodem, Ymodem, etc.)**

Due to SSH PTY (pseudo-terminal) character processing, binary file transfer protocols like Zmodem may not work reliably over SSH connections. The SSH protocol performs terminal emulation which can modify or corrupt binary data streams, resulting in CRC errors and failed transfers.

**Workaround:** Use the telnet connection for file transfers. This is a known limitation of SSH PTY mode and affects most SSH-based BBS proxy implementations.

**Recommended workflow:**
1. Connect via SSH for regular BBS browsing (encrypted, more secure)
2. When you need to download/upload files, switch to telnet connection
3. Return to SSH after the file transfer is complete

This limitation is inherent to how SSH handles terminal sessions and cannot be fully resolved without using alternative file transfer methods (such as SFTP, which would require a different server implementation).

### Testing SSH

Test your SSH server:

```bash
# Connect with verbose output
ssh -v -p 2222 test@localhost

# Test with a specific cipher
ssh -c aes128-cbc -p 2222 test@localhost
```

## Country Blocking

Block connections from specific countries using GeoIP lookup:

### Setup

1. Download the GeoIP database:

```bash
npm run setup-geoip
```

2. Configure blocked countries in your environment:

```bash
# Block China, Russia, and North Korea
BLOCKED_COUNTRIES=CN,RU,KP npm start
```

Or add to your `.env` file:

```
BLOCKED_COUNTRIES=CN,RU,KP
BLOCK_UNKNOWN_COUNTRIES=false
```

### Country Codes

Use ISO 3166-1 alpha-2 country codes (2 letters). Common examples:

- `CN` - China
- `RU` - Russia
- `KP` - North Korea
- `IR` - Iran
- `US` - United States
- `GB` - United Kingdom
- `DE` - Germany
- `JP` - Japan

See full list: https://en.wikipedia.org/wiki/ISO_3166-1_alpha-2

### How It Works

1. When a connection is received, the client's IP address is looked up in the local GeoLite2 database
2. If the country is in the blocked list, the connection is immediately rejected
3. If the country cannot be determined and `BLOCK_UNKNOWN_COUNTRIES=true`, the connection is rejected
4. All blocking events are logged for monitoring

### Database Updates

The GeoLite2 database is updated monthly by MaxMind. To update:

1. Delete the old database: `rm data/GeoLite2-Country.mmdb`
2. Re-run setup: `npm run setup-geoip`

### Performance

- Lookups are performed against a local database (no API calls)
- Typical lookup time: < 1ms
- Database size: ~6MB in memory
- No external dependencies or network latency

## IP Filtering & Rate Limiting

Protect your BBS from connection floods and block specific IP addresses.

### Connection Flood Protection

Built-in rate limiting automatically blocks IPs that connect too frequently:

```bash
# Default: 10 connections per minute
npm start

# Custom settings: 5 connections per 30 seconds, block for 10 minutes
MAX_CONNECTIONS_PER_WINDOW=5 RATE_LIMIT_WINDOW_MS=30000 RATE_LIMIT_BLOCK_DURATION_MS=600000 npm start
```

Or add to your `.env` file:

```
RATE_LIMIT_ENABLED=true
MAX_CONNECTIONS_PER_WINDOW=10
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_BLOCK_DURATION_MS=300000
```

**How it works:**
- Tracks connection attempts per IP address
- If an IP exceeds `MAX_CONNECTIONS_PER_WINDOW` within `RATE_LIMIT_WINDOW_MS`, it's temporarily blocked
- Blocked IPs are automatically unblocked after `RATE_LIMIT_BLOCK_DURATION_MS`
- All blocks are logged for monitoring

**To disable rate limiting:**
```bash
RATE_LIMIT_ENABLED=false npm start
```

### IP Whitelist

Whitelist specific IP addresses or ranges to **bypass all firewall rules** (country blocking, rate limiting, and blocklist):

1. Create a whitelist file:

```bash
cp whitelist.txt.example whitelist.txt
```

2. Add IPs or CIDR ranges to whitelist (one per line):

```
# whitelist.txt
192.168.1.100          # Single trusted IP
10.0.0.0/8             # Entire private network
172.16.0.0/12          # Another private range
```

3. Enable the whitelist:

```bash
WHITELIST_PATH=whitelist.txt npm start
```

**Whitelist features:**
- IPs in the whitelist bypass ALL firewall rules
- Supports single IPs (e.g., `192.168.1.100`)
- Supports CIDR ranges (e.g., `192.168.1.0/24`, `10.0.0.0/8`)
- Comments supported (lines starting with #)
- IPv4 and IPv6-mapped IPv4 addresses supported
- Changes require restart to take effect

**Use cases:**
- Allow connections from trusted networks or IPs
- Exempt monitoring systems from rate limiting
- Allow administrative access regardless of country

### IP Blocklist

Block specific IP addresses or ranges from a file:

1. Create a blocklist file:

```bash
cp blocklist.txt.example blocklist.txt
```

2. Add IPs or CIDR ranges to block (one per line):

```
# blocklist.txt
192.168.1.100          # Single IP
10.0.0.0/24            # CIDR range
203.0.113.0
# IPv6 also supported
2001:0db8:85a3::8a2e:0370:7334
```

3. Enable the blocklist:

```bash
BLOCKLIST_PATH=blocklist.txt npm start
```

**Blocklist features:**
- One IP or CIDR range per line
- Supports CIDR notation (e.g., `192.168.1.0/24`)
- Comments supported (lines starting with #)
- IPv4 and IPv6 addresses
- Changes require restart to take effect
- Permanent blocking (not temporary like rate limiting)

### Combined Protection

Use all protection methods together:

```bash
# In .env file
WHITELIST_PATH=whitelist.txt
BLOCKLIST_PATH=blocklist.txt
BLOCKED_COUNTRIES=CN,RU,KP
RATE_LIMIT_ENABLED=true
MAX_CONNECTIONS_PER_WINDOW=10
RATE_LIMIT_WINDOW_MS=60000
```

**Processing order:**
1. **Whitelist check** - If matched, allow immediately (skip all other checks)
2. IP blocklist check (permanent block)
3. Rate limit check (temporary block)
4. Country check (if GeoIP enabled)
5. If all pass, connection forwarded to BBS

## Architecture

The firewall consists of several modules:

- **server.js**: Main server logic and connection management
- **proxy.js**: Handles bidirectional TCP proxy connections
- **ssh.js**: SSH server implementation with credential bypass
- **config.js**: Configuration management and validation
- **logger.js**: Logging utility with configurable levels
- **geoip.js**: GeoIP database integration for country lookups
- **ipfilter.js**: IP blocklist and rate limiting module
- **download-geoip.js**: Helper script to download GeoLite2 database

## How It Works

1. The firewall listens on `LISTEN_PORT` for telnet and optionally on `SSH_LISTEN_PORT` for SSH
2. When a client connects (via telnet or SSH), the IP is checked in this order:
   - **Whitelist** (if matched, skip all other checks)
   - IP blocklist (permanent block)
   - Rate limiting (temporary block for floods)
   - GeoIP country check (if enabled)
3. If any check fails, the connection is rejected immediately
4. For SSH connections, any username/password is accepted (no authentication)
5. If all checks pass, a connection is established to `BACKEND_HOST:BACKEND_PORT`
6. Data is forwarded bidirectionally between client and backend
7. All connections are logged with traffic statistics and filtering decisions
8. Connections are tracked and limited by `MAX_CONNECTIONS`

## Features

✅ **TCP Proxy**: Forwards telnet connections to backend BBS server  
✅ **SSH Server**: Optional encrypted SSH access (accepts any credentials)  
✅ **Legacy Cipher Support**: Configurable SSH ciphers for old BBS clients  
✅ **IP Whitelist**: Always allow specific IPs/ranges (bypass all firewall rules)  
✅ **Country Blocking**: Block connections from specific countries using local GeoIP database  
✅ **IP Blocklist**: Block specific IP addresses/ranges from a file (supports CIDR)  
✅ **Rate Limiting**: Automatic flood protection with temporary blocking  
✅ **Connection Management**: Track and limit simultaneous connections  
✅ **Logging**: Detailed logging with configurable levels and filtering decisions  
✅ **Performance**: Local database lookups, no external API calls  
✅ **Minimal Dependencies**: Only Node.js built-ins plus ssh2 and maxmind  

## Future Enhancements

Planned features for future releases:

- Connection statistics and monitoring dashboard
- HTTP API for management and dynamic blocklist/whitelist updates
- Configuration reload without restart (live reload)
- IPv6 support improvements
- Custom ban messages/responses

## Development

### Project Structure

```
bbsfw/
├── server.js              # Main entry point
├── proxy.js               # Proxy connection handler
├── ssh.js                 # SSH server module
├── config.js              # Configuration management
├── logger.js              # Logging utility
├── geoip.js               # GeoIP lookup module
├── ipfilter.js            # IP blocklist and rate limiting
├── download-geoip.js      # Database download helper
├── package.json           # Project metadata
├── .env.example           # Example configuration
├── whitelist.txt.example  # Example IP whitelist
├── blocklist.txt.example  # Example IP blocklist
├── data/                  # GeoIP database directory
└── README.md              # Documentation
```

### Running in Development

```bash
npm run dev
```

### Testing

To test the firewall, you'll need:
1. A backend telnet server running
2. Configure bbsfw to point to it
3. Start bbsfw
4. Connect with a telnet client

## License

MIT

