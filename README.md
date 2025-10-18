# BBS Firewall (bbsfw)

A lightweight TCP proxy firewall for BBS telnet connections, built with Node.js.

## Features

- **TCP Proxy**: Forwards telnet connections to an internal BBS server
- **Connection Management**: Tracks active connections and enforces limits
- **Logging**: Detailed connection and traffic logging
- **Configurable**: Easy configuration via environment variables
- **Graceful Shutdown**: Handles SIGTERM/SIGINT for clean shutdowns
- **Few External Dependencies**: Uses only Node.js built-in modules, dotenv, and maxmind

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
| `LISTEN_PORT` | Port to listen on for incoming connections | `2323` |
| `BACKEND_HOST` | Backend BBS server hostname/IP (use 127.0.0.1 for IPv4) | `127.0.0.1` |
| `BACKEND_PORT` | Backend BBS server port | `23` |
| `MAX_CONNECTIONS` | Maximum simultaneous connections | `100` |
| `CONNECTION_TIMEOUT` | Connection timeout in milliseconds (0 to disable) | `300000` (5 min) |
| `BLOCKED_COUNTRIES` | Comma-separated ISO country codes to block (e.g., CN,RU,KP) | _(empty)_ |
| `BLOCK_UNKNOWN_COUNTRIES` | Block connections when country cannot be determined | `false` |
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

### IP Blocklist

Block specific IP addresses from a file:

1. Create a blocklist file:

```bash
cp blocklist.txt.example blocklist.txt
```

2. Add IPs to block (one per line):

```
# blocklist.txt
192.168.1.100
10.0.0.50
203.0.113.0
# IPv6 also supported
2001:0db8:85a3::8a2e:0370:7334
```

3. Enable the blocklist:

```bash
BLOCKLIST_PATH=blocklist.txt npm start
```

**Blocklist features:**
- One IP per line
- Comments supported (lines starting with #)
- IPv4 and IPv6 addresses
- Changes require restart to take effect
- Permanent blocking (not temporary like rate limiting)

### Combined Protection

Use all protection methods together:

```bash
# In .env file
BLOCKED_COUNTRIES=CN,RU,KP
BLOCKLIST_PATH=blocklist.txt
RATE_LIMIT_ENABLED=true
MAX_CONNECTIONS_PER_WINDOW=10
RATE_LIMIT_WINDOW_MS=60000
```

**Processing order:**
1. IP blocklist check (permanent block)
2. Rate limit check (temporary block)
3. Country check (if GeoIP enabled)
4. If all pass, connection forwarded to BBS

## Architecture

The firewall consists of several modules:

- **server.js**: Main server logic and connection management
- **proxy.js**: Handles bidirectional TCP proxy connections
- **config.js**: Configuration management and validation
- **logger.js**: Logging utility with configurable levels
- **geoip.js**: GeoIP database integration for country lookups
- **ipfilter.js**: IP blocklist and rate limiting module
- **download-geoip.js**: Helper script to download GeoLite2 database

## How It Works

1. The firewall listens on the configured `LISTEN_PORT`
2. When a client connects, the IP is checked in this order:
   - IP blocklist (permanent block)
   - Rate limiting (temporary block for floods)
   - GeoIP country check (if enabled)
3. If any check fails, the connection is rejected immediately
4. If all checks pass, a connection is established to `BACKEND_HOST:BACKEND_PORT`
5. Data is forwarded bidirectionally between client and backend
6. All connections are logged with traffic statistics and filtering decisions
7. Connections are tracked and limited by `MAX_CONNECTIONS`

## Features

✅ **TCP Proxy**: Forwards telnet connections to backend BBS server  
✅ **Country Blocking**: Block connections from specific countries using local GeoIP database  
✅ **IP Blocklist**: Block specific IP addresses from a file  
✅ **Rate Limiting**: Automatic flood protection with temporary blocking  
✅ **Connection Management**: Track and limit simultaneous connections  
✅ **Logging**: Detailed logging with configurable levels and filtering decisions  
✅ **Performance**: Local database lookups, no external API calls  
✅ **Minimal Dependencies**: Only Node.js built-ins (plus maxmind for GeoIP)  

## Future Enhancements

Planned features for future releases:

- Connection statistics and monitoring dashboard
- HTTP API for management and dynamic blocklist updates
- Configuration reload without restart (live reload)
- CIDR range support in blocklist
- Whitelist support (always allow specific IPs)
- IPv6 support improvements

## Development

### Project Structure

```
bbsfw/
├── server.js              # Main entry point
├── proxy.js               # Proxy connection handler
├── config.js              # Configuration management
├── logger.js              # Logging utility
├── geoip.js               # GeoIP lookup module
├── ipfilter.js            # IP blocklist and rate limiting
├── download-geoip.js      # Database download helper
├── package.json           # Project metadata
├── .env.example           # Example configuration
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

