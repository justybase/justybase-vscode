# Database tunnel reference server

This is a small FastAPI example for environments where the JustyBase desktop
client can make an outbound HTTPS connection, while a database is reachable
only from a private server network.

```text
JustyBase -> 127.0.0.1:<local-port> -> WSS/443 -> FastAPI -> private database
```

The server relays raw binary TCP traffic. It does not parse SQL or database
protocols and does not accept arbitrary host/port values from clients. Targets
are named in `DATABASE_TUNNEL_TARGETS_JSON` and the client can select only one
of those names. The same relay works for PostgreSQL, Netezza, Oracle, or any
other database driver that speaks over a TCP socket.

## Run locally

```bash
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt

export DATABASE_TUNNEL_TOKEN='use-a-long-random-token'
export DATABASE_TUNNEL_TARGETS_JSON='{"reports":{"host":"127.0.0.1","port":5432}}'
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

In the normal **Add Connection** form, select PostgreSQL, Netezza, or another
dialect that advertises raw TCP tunnel support. Enable **Use HTTPS/WSS TCP
tunnel** and enter:

- the base HTTPS server URL, for example `https://tunnel.example.com`;
- the server-side target id, such as `reports`;
- a free local TCP port, such as `15432`;
- the bearer token.

The form automatically uses `127.0.0.1` and the selected local port for the
database driver. Enter the real remote database name, user, password, and any
database TLS settings in the same profile. The database password and tunnel
token are different values. The tunnel starts lazily when **Test Connection**
or the first query opens the profile and stops when the extension deactivates,
the profile is deleted, or tunneling is disabled/changed.

SQLite is intentionally not a tunnel target: JustyBase opens SQLite files
locally with `node:sqlite`, so there is no remote TCP database endpoint to
forward. File SQL/DuckDB profiles are similarly local-file workflows.

This sample is a reference implementation, not a complete production gateway.
Use a strong rotated token, HTTPS certificate validation, network policy, and
an allowlist of targets before exposing it to users.
