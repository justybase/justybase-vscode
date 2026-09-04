# Global database TCP tunnel over HTTPS/WSS

The tunnel is owned by the JustyBase core extension, not by an individual
dialect companion. It forwards an opaque TCP byte stream through an
authenticated WebSocket, so the database driver and database protocol are not
parsed or modified:

```text
JustyBase database driver -> 127.0.0.1:<local-port>
    -> HTTPS/WSS gateway -> FastAPI relay -> private database host:port
```

The current opt-in dialects are Netezza, PostgreSQL, and Oracle. A future TCP
dialect can enable the same feature by advertising
`supportsRawTcpTunnel`. SQLite, DuckDB/File SQL, and Access are local-file
workflows and are intentionally not tunnel targets.

## What must be reachable

The desktop machine needs only outbound HTTPS/WSS access to the relay, usually
TCP `443`. The relay machine needs TCP access to the private database. The
desktop never submits a destination host or port: it submits only a named
target id, and the relay resolves that id from its server-side allowlist.

The browser/web editor cannot use this feature because it cannot open the
desktop loopback TCP listener. This feature is for the desktop VS Code
extension (including a Remote-SSH/Remote-WSL extension host, where the
loopback listener belongs to that host).

## 1. Start the reference FastAPI relay

The repository sample is in
[`samples/database-tunnel`](../samples/database-tunnel/). On the server that
can reach the private databases:

```bash
cd samples/database-tunnel
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
```

Set a long random token and define named targets. Target hosts and ports are
resolved by the relay, not by JustyBase:

```dotenv
DATABASE_TUNNEL_BIND_HOST=127.0.0.1
DATABASE_TUNNEL_BIND_PORT=8000
DATABASE_TUNNEL_TOKEN=replace-with-a-long-random-token
DATABASE_TUNNEL_MAX_CONNECTIONS=32
DATABASE_TUNNEL_TARGETS_JSON='{"postgresql":{"host":"10.20.0.15","port":5432},"netezza":{"host":"10.20.0.25","port":5480}}'
```

Start it for local development:

```bash
set -a
. ./.env
set +a
uvicorn server.main:app --host 127.0.0.1 --port 8000
curl --fail http://127.0.0.1:8000/healthz
```

`/healthz` checks only that FastAPI is alive; it does not authenticate or
connect to a database target. Use a separate target entry for each approved
database endpoint. Do not add an endpoint that accepts arbitrary host/port
values from the client.

## 2. Put HTTPS/WSS in front of FastAPI

Keep Uvicorn bound to loopback and terminate TLS in a reverse proxy. The proxy
must pass WebSocket upgrades, disable response buffering, and allow long-lived
idle database sessions. A minimal Nginx configuration is:

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 443 ssl;
    server_name tunnel.example.com;

    ssl_certificate     /etc/letsencrypt/live/tunnel.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/tunnel.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_buffering off;
        proxy_read_timeout 1h;
        proxy_send_timeout 1h;
    }
}
```

The URL entered in JustyBase is the base URL
`https://tunnel.example.com`. Core appends
`/tunnel/<target-id>` and changes HTTPS to WSS. Do not enter the complete
WebSocket path, and do not expose Uvicorn directly to the internet.

## 3. Configure a tunneled connection in JustyBase

Open **JustyBase → Connect → Add Connection** and choose Netezza,
PostgreSQL, or Oracle. Enable **Use HTTPS/WSS TCP tunnel** in the common
connection form and enter:

| Field | Example | Meaning |
| --- | --- | --- |
| Server URL | `https://tunnel.example.com` | Base relay URL, without `/tunnel/...` |
| Target ID | `postgresql` | Must match a relay allowlist key |
| Local TCP port | `15432` | Free port on the extension-host machine |
| Bearer token | value from relay `.env` | Stored in VS Code SecretStorage |
| Host | `127.0.0.1` | Filled/enforced by the form |
| Port | `15432` | Filled from the local tunnel port |

Enter the real remote database name, user, and database password in the same
profile. The password is sent through the opaque tunnel to the database; it is
not the relay bearer token. Click **Test Connection**, then **Save & Connect**.

The tunnel is lazy: **Test Connection** and the first normal query start the
loopback listener automatically. It is stopped when the extension is
deactivated, when the profile is deleted, or when tunneling is disabled or its
endpoint changes. A different target should use a different local port and a
different stable tunnel id.

The token input is write-only in the form. Leaving it blank while editing a
saved profile reuses the token already held in SecretStorage. To remove that
token, select **Remove the saved bearer token** and save the profile; the
profile remains saved but cannot connect until a new token is entered. The
same rule applies when changing the relay URL: a blank token clears the old
relay token, while entering a token stores the replacement. The token is
never stored in the serializable connection profile or global state cache.

### Database-specific details

- PostgreSQL: configure PostgreSQL SSL in the normal profile. `require` or
  `verify-full` applies inside the tunnel. With `verify-full`, keep Host as
  `127.0.0.1` and set the PostgreSQL TLS server name to the name in the remote
  certificate.
- Netezza: the Netezza wire protocol is forwarded unchanged; use the remote
  database, user, and password as for a direct connection.
- Oracle: use Host, Port, and Service Name fields. A custom Oracle Connect
  String override is not compatible with the transparent tunnel because it
  can embed a different endpoint.

## Security and operations

The relay bearer token authenticates the WebSocket, while the database
credentials authenticate the database session. Use HTTPS certificate
validation, rotate tokens, restrict relay firewall egress, keep the target
allowlist minimal, and set a connection limit. Consider putting the gateway
behind a VPN or an additional identity-aware proxy for production use.

Raw tunneling gives the client network reachability; it does not grant any
database privileges. Apply normal database roles, TLS requirements, auditing,
and firewall policy. The reference FastAPI server intentionally does not
implement production identity management or auditing.

## Troubleshooting

- `Connection refused` on `127.0.0.1:<local-port>`: verify that the profile
  uses a free port and that **Test Connection** or the first query has started
  the tunnel.
- WebSocket `401/403`, `502`, or `426`: check the token, base URL, target id,
  and reverse-proxy `Upgrade`/`Connection` headers.
- Target unavailable: test the private host/port from the relay machine, not
  from the desktop.
- Database authentication/TLS failure: check remote database credentials and
  inner database TLS settings; WSS does not automatically enable database TLS.
- Idle disconnects: increase proxy and load-balancer read/send timeouts and
  inspect firewall idle limits.

## Tests

The local relay component test does not require a database:

```bash
npm run test:database:tunnel
```

The live test starts the FastAPI sample and connects through it using the real
PostgreSQL and Netezza drivers. It deliberately fails when credentials are
missing, so a green result means both configured databases were exercised:

```bash
npm run test:database:tunnel:live
```

Required variables:

```text
PostgreSQL: POSTGRES_LIVE_TEST_HOST/PORT/DATABASE/USER/PASSWORD
            or PG_LIVE_TEST_HOST/PORT/DATABASE/USER/PASSWORD
Netezza:    NZ_DEV_HOST/PORT/DATABASE/USER/PASSWORD
```

To run one target independently:

```bash
npm run test:postgresql:tunnel:live
npm run test:netezza:tunnel:live
```

Credentials are read only from the process environment and are not printed or
written to the repository.
