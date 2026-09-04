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

For local development the JustyBase tunnel URL may be `http://127.0.0.1:8000`.
For deployment use `https://...`; the extension changes the scheme to `wss`.
The reverse proxy must forward WebSocket upgrades and must not apply a short
idle timeout to database sessions.

## Configure JustyBase

1. Run **PostgreSQL: Configure Tunnel**.
2. Enter the HTTPS server URL, target id such as `reports`, a local port such
   as `15432`, and the bearer token.
3. Run **PostgreSQL: Start Tunnel**.
4. Create a normal PostgreSQL connection using host `127.0.0.1` and the local
   port. Keep the real database name, user, and password in that profile.

Use `sslMode=require` or `verify-full` according to the PostgreSQL deployment.
With `verify-full`, use `127.0.0.1` for the local host and configure the remote
certificate name as the PostgreSQL `sslServerName` option.

This sample is a reference implementation, not a complete production gateway.
Use a strong rotated token, HTTPS certificate validation, network policy, and
an allowlist of targets before exposing it to users.
