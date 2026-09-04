# PostgreSQL tunnel reference server

This is a small FastAPI example for environments where the JustyBase desktop
client can make an outbound HTTPS connection, while PostgreSQL is reachable
only from a private server network.

```text
JustyBase -> 127.0.0.1:15432 -> WSS/443 -> FastAPI -> private PostgreSQL:5432
```

The server relays raw binary PostgreSQL traffic. It does not execute SQL and
does not accept arbitrary host/port values from clients. Targets are named in
`POSTGRES_TUNNEL_TARGETS_JSON`.

## Run locally

```bash
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt

export POSTGRES_TUNNEL_TOKEN='use-a-long-random-token'
export POSTGRES_TUNNEL_TARGETS_JSON='{"reports":{"host":"127.0.0.1","port":5432}}'
uvicorn server.main:app --host 127.0.0.1 --port 8000
```

For local development the JustyBase tunnel URL may be
`http://127.0.0.1:8000`; the extension changes the scheme to `ws`. For
deployment use a base URL such as `https://tunnel.example.com`; the extension
changes the scheme to `wss` and appends `/tunnel/<target-id>`.

Keep Uvicorn on loopback and put it behind an HTTPS reverse proxy. The proxy
must forward `Upgrade` and `Connection` WebSocket headers, preserve the
`Host` header, and use a long read timeout (for example one hour). Do not
expose port `8000` directly.

Minimal Nginx location:

```nginx
location / {
    proxy_pass http://127.0.0.1:8000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_buffering off;
    proxy_read_timeout 1h;
}
```

## Configure JustyBase

1. Run **PostgreSQL: Configure Tunnel**.
2. Enter the base HTTPS server URL, for example
   `https://tunnel.example.com` (not `/tunnel/reports`), target id such as
   `reports`, a local port such as `15432`, and the bearer token.
3. Run **PostgreSQL: Start Tunnel**.
4. Create a normal PostgreSQL connection using host `127.0.0.1` and the local
   port. Keep the real database name, user, and password in that profile. The
   database password and tunnel token are different values.

Use PostgreSQL SSL independently of the outer WSS connection. The runtime
supports `sslMode=require` and `verify-full`; with `verify-full`, the TLS
server name must match the remote PostgreSQL certificate, not the local
`127.0.0.1` listener. Confirm that the installed connection panel exposes the
corresponding PostgreSQL SSL fields before selecting `verify-full`.

This sample is a reference implementation, not a complete production gateway.
Use a strong rotated token, HTTPS certificate validation, network policy, and
an allowlist of targets before exposing it to users.
