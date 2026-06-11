# Post-session grace period — design

**Date:** 2026-06-11
**Status:** Approved (design discussed and accepted in session)

## Problem

The backend is turbo64, a single-line BBS running on real C64 hardware (Ultimate 64
modem emulation at 192.168.1.202:3000). After a caller disconnects, the BBS takes a few
seconds to recycle (`net_disconnect` → ACIA settle → WFC redraw). The U64 still accepts
TCP during that window, so a caller who reconnects quickly either gets no banner or is
dropped by the hangup intended for the previous caller.

## Solution

When a new connection arrives within `POST_SESSION_GRACE_MS` of the previous session
ending, bbsfw accepts the caller and silently holds the connection until the grace
window has elapsed, then connects to the backend as normal.

### Config (config.js)

- `postSessionGraceMs` from env `POST_SESSION_GRACE_MS`, default `0` = disabled.
  With the default, no new code path executes — current behavior is unchanged.
- Deployment .env gets `POST_SESSION_GRACE_MS=5000`.

### Session-end tracking (proxy.js)

- Module-level `lastSessionEndMs` timestamp, initially `0`.
- `ProxyConnection` sets `this.backendConnected = true` in the backend connect callback.
- `cleanup()` updates `lastSessionEndMs = Date.now()` only when `backendConnected` is
  true. Rejected callers and failed backend connects never arm the grace period; only a
  session that actually reached the BBS does.

### Hold logic (proxy.js connect())

After the IP/country filter checks pass:

1. `wait = postSessionGraceMs - (Date.now() - lastSessionEndMs)`.
2. If `wait <= 0`: connect to the backend immediately (current behavior).
3. If `wait > 0`:
   - Log at info level that the caller is held for `wait` ms (backend recycle grace).
   - Buffer client bytes that arrive during the hold (telnet clients send IAC
     negotiation immediately; dropping those bytes would break turbo64's terminal
     detection). Buffered bytes are flushed to the backend, in order, before any other
     client data once connected.
   - On timer expiry: connect to the backend, flush buffer, proceed as normal.
   - If the caller disconnects mid-hold: cancel the timer, never connect to the
     backend, clean up normally (slot is freed, grace period is not re-armed).
4. A held caller occupies a connection slot. With `MAX_CONNECTIONS=1` this keeps the
   line busy for later callers, which is correct for a single-line BBS.

### Out of scope

- The SSH path (ssh.js) has separate backend-connect code and is disabled in this
  deployment; it does not get the grace period.
- No "please wait" message to the held caller — a short silent pause is normal BBS
  behavior, and injecting bytes could confuse telnet negotiation.

## Testing

Extend `tests/` (node:test, black-box: spawned server + fake backend):

1. With `POST_SESSION_GRACE_MS=1500`: caller A connects, receives backend data,
   disconnects. Caller B connects immediately after, sends bytes during the hold.
   Assert: B receives backend data no sooner than ~1.2 s after connecting, and the
   bytes B sent during the hold arrive at the fake backend in order.
2. Disabled path (`POST_SESSION_GRACE_MS` unset/0) is covered by the existing tests,
   which assert an immediate backend connection.
