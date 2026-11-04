# Netezza relay for an existing FastAPI service

Use this sample when your FastAPI service already has a login screen and JWTs,
and holds the database credentials itself. JustyBase users sign in with their
service login and never need the database login or password.

```text
JustyBase driver -> 127.0.0.1:<local-port>
  -> WSS, with JWT and a per-tunnel client proof
  -> relay in your FastAPI service: replaces the user, logs in to the database
  -> Netezza
```

After the login the relay forwards raw bytes, so streaming, notices, EXPLAIN,
cancellation, temporary tables and external-table imports use the driver's
normal Netezza protocol.

The other sample, [`samples/database-tunnel`](../database-tunnel/), is a plain
TCP relay for when each user has their own database login.

## Contents

| Path | Purpose |
| --- | --- |
| `justybase_relay/` | The package to copy into your service |
| `demo_service/app.py` | A small stand-in for your service, for trying this out |
| `tests/` | Tests that need no database |

## Add it to your service

Your login screen and existing endpoints do not change. Give the router the
functions your service already has:

```python
from justybase_relay import create_justybase_router

def issue_token_for_justybase(user):
    token = create_access_token({"sub": user.username})
    return token, ACCESS_TOKEN_EXPIRE_MINUTES * 60  # (jwt, seconds until expiry)

app.include_router(
    create_justybase_router(
        authenticate=authenticate_user,      # (login, password) -> user or None
        issue_token=issue_token_for_justybase,
        verify_token=decode_access_token,    # token -> user, None, or raises
        authorize=lambda user, target_id: user.can_use_sql_editor,
    ),
    prefix="/api/justybase",
)
```

This adds two routes under the prefix:

| Route | Purpose |
| --- | --- |
| `POST /auth/token` | Accepts `{"username", "password"}` and returns `{"access_token", "token_type", "expires_in"}` |
| `WS /tunnel/{target_id}` | Opens one database session; needs `Authorization: Bearer <jwt>` and `X-JustyBase-Client-Proof` |

Functions may be sync or async. Sync functions run in a thread pool, so password
hashing does not block the event loop.

`authorize` has no default on purpose: a session has the full rights of the
service database account.

## Configure the targets

```dotenv
JUSTYBASE_RELAY_TARGETS_JSON='{"netezza":{"host":"10.20.0.25","port":5480,"user_env":"NZ_SVC_USER","password_env":"NZ_SVC_PASSWORD","allowed_databases":["DEV"],"tls":"off"}}'
NZ_SVC_USER=...
NZ_SVC_PASSWORD=...
```

| Key | Meaning |
| --- | --- |
| `host`, `port` | Database address. The client never supplies these |
| `user_env`, `password_env` | Names of the environment variables holding the credentials |
| `allowed_databases` | Databases users may select. Leave out to allow all that the account can reach |
| `tls` | Relay-to-database TLS: `off`, `prefer` or `require` |
| `ca_file` | CA certificate file for the database's TLS certificate |
| `tls_verify` | Default `true`. `false` skips the certificate check, which is **unsafe**: see below |

A TLS certificate failure always ends the login. The relay does not retry
without TLS, because that would expose the database login. The user sees a generic
error, and the cause goes to the `justybase.relay` log.

The relay checks the certificate chain, its dates and the host name in `host`.
Check your database's certificate before choosing `prefer` or `require`: an
appliance's default certificate may be expired, have no host name in it, or come
from a private CA, and then these modes refuse the connection. Install a valid
certificate, or use one of the options below.

### Connecting without a certificate

Neither JustyBase nor the relay needs a certificate file for these two setups. The
extension never handles the database's certificate, because its connection ends at
the relay.

| Your database | Target settings | Result |
| --- | --- | --- |
| Accepts plain connections | `"tls": "off"` | Works with no certificate at all. Not encrypted |
| Requires TLS, or has a certificate you cannot verify | `"tls": "require", "tls_verify": false` | Encrypted. The database's identity is not checked |

```json
{"netezza":{"host":"10.20.0.25","port":5480,"user_env":"NZ_SVC_USER","password_env":"NZ_SVC_PASSWORD","tls":"off"}}
```

`"tls": "off"` is a supported setup for a network you control, such as a private
link between the service and the database. Anyone who can read that traffic sees
all SQL and results, so do not use it across a network you do not control. The
service logs a warning for such a target when it starts.

The default, `prefer`, is not a no-certificate mode: if the database offers TLS, its
certificate must verify. When it does not, users see a generic error and the relay
log says which setting to change.

### Skipping the certificate check (`tls_verify: false`)

> **Warning: this is unsafe.** The connection is encrypted, but the relay does not
> check who it is talking to. Anyone who can intercept traffic between the relay and
> the database can pose as the database, see all SQL and results, and change them.
> With the plain password method, they also receive the service account's password.

Use it only when all of these are true:

- the database's certificate cannot be verified, for example an expired appliance
  default, and you cannot replace it yet;
- traffic between the relay and the database stays on a network you control;
- you have a plan to install a valid certificate and go back to `true`.

```json
{"netezza":{"host":"10.20.0.25","port":5480,"user_env":"NZ_SVC_USER","password_env":"NZ_SVC_PASSWORD","tls":"require","tls_verify":false}}
```

Use it with `"tls": "require"`, so the relay also refuses a server that offers no
TLS. With `prefer`, such a server gets an unencrypted connection. The service logs
a warning for each such target when it starts. It refuses to start if `tls_verify`
is `false` together with `ca_file` or with `"tls": "off"`, because those
combinations suggest a protection that is not there.

| Mode | Encrypted | Database identity checked | Protects against |
| --- | --- | --- | --- |
| `require` | Yes | Yes | Listening and impersonation |
| `require` + `tls_verify: false` | Yes | **No** | Listening only |
| `off` | **No** | **No** | Nothing |

`prefer` behaves like `require` when the server offers TLS, and like `off` when it
does not. If the database supports TLS, the unverified mode is safer than `off`,
because it at least stops passive listening.

## Try the demo

```bash
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements-dev.txt
cp .env.example .env    # then edit the values
set -a; . ./.env; set +a
uvicorn demo_service.app:create_app --factory --host 127.0.0.1 --port 8000
```

Open <http://127.0.0.1:8000/> to see the demo's login screen, which works without
JustyBase. Then in JustyBase choose **Add Connection → Netezza**, enable the tunnel
and enter:

| Field | Value |
| --- | --- |
| Server URL | `http://127.0.0.1:8000/api/justybase` |
| Target ID | `netezza` |
| Local TCP port | A free port, for example `15480` |
| Sign-in mode | **Service login** |
| Service login | `DEMO_USERNAME` |
| Service password | `DEMO_PASSWORD` |
| Database | A database allowed for the target |

Plain HTTP is accepted only on localhost. Any other address must use HTTPS.

## Before production

- **Put HTTPS/WSS in front of the service.** Use the Nginx configuration in
  [`docs/database-tunnel.md`](../../docs/database-tunnel.md).
- **Give the service account the least rights it can work with.** The relay does
  not inspect SQL, so every authorized user can run anything that account can.
- **Do not rely on the database for auditing per person.** All users share one
  database account. The relay logs user, target, outcome, duration and bytes to
  the `justybase.relay` logger. It does not log SQL.
- **Limit login attempts** on `/auth/token`, as you do on your login endpoint.
- **Keep JWTs short-lived.** A JWT is checked when a connection opens. If it
  expires later, the open session continues, and logging a user out or removing
  their access does not end it. New connections are refused.
- **Set connection limits for your workload.** The defaults are 64 in total and
  16 per user, counted per worker. Loading metadata can open up to 8 connections
  for one user, and a shared account also counts against database session limits.

Several uvicorn workers are fine, because each connection is handled entirely
inside one worker.

## How the client proof protects you

The extension listens on `127.0.0.1`, which any local process can reach. Since
the relay supplies the database login, a connection to that port could otherwise
become a logged-in session. So the extension creates a random nonce for each
tunnel and sends it in the WebSocket header. The driver sends the same nonce as
its password, and the relay compares the two before logging in to the database.
The service password itself never reaches the driver.

## Tests

```bash
pytest
```

From the repository root, these run the real JustyBase driver through this relay:

```bash
npm run test:database:tunnel:relay               # scripted Netezza server, no database
npm run test:netezza:tunnel:service-login:live   # real database, needs NZ_DEV_*
```

The live test fails rather than skips when `NZ_DEV_*` variables are missing. Set
`JUSTYBASE_RELAY_LIVE_TLS` to choose the relay-to-database TLS mode.
