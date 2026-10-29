# Deploying to the VM

One process, one origin: `server.js` serves the built React frontend
(`dev-portal/dist/`) and the API (`/api/*`) from the same host, behind Caddy for
TLS. The installer builds the frontend from the checked-in source. No Static
Web App, no Function App, no second hostname.

## Topology

| Piece | Runs on | Notes |
|---|---|---|
| UI + API | `dev-agent.service` (:3000, loopback) | Vite-built React UI + one Node process |
| TLS | Caddy (:443) | automatic Let's Encrypt, reverse-proxies to :3000 |
| Sessions | `$PREFIX/shared/.data` | outside the release dir, survives deploys |
| Model auth | managed identity | keyless; no Foundry key on the box |

## Cut over from the Static Web App

`dev.fameshire.com` currently points at an Azure Static Web App. **Do this in
order** so the hostname never resolves to nothing:

1. Stand the VM up and install (below). Verify locally with curl — no DNS yet.
2. Verify through Caddy with the real hostname before touching public DNS:
   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' --resolve dev.fameshire.com:443:<VM-IP> \
     https://dev.fameshire.com/
   ```
3. Switch DNS: replace the `azurestaticapps.net` CNAME with an **A record**
   `dev.fameshire.com -> <VM public IP>`. Lower the TTL an hour beforehand.
4. Wait for propagation, confirm `curl -sI https://dev.fameshire.com` now hits
   your VM, then delete the Static Web App:
   ```bash
   az staticwebapp list -o table                       # find the name/rg
   az staticwebapp delete --name <name> --resource-group <rg> --yes
   ```
   Deleting the resource does **not** remove the DNS records — that is step 3.
5. Optionally remove `momtv-api` references anywhere else, then confirm no
   Azure resource is still serving this hostname.

> I could not run any of this: there are no Azure credentials or SSH access in
> the environment that prepared these files. Steps 3 and 4 are yours.

## 1. Install the app (systemd)

Requires Node 18+, npm, and `curl` on the VM. The installer installs the locked
frontend build dependencies, builds the UI, and removes build-only dependencies
before enabling the service.

```bash
sudo ./deploy/install.sh
```

That command is idempotent and does all of this:

1. creates a `devagent` system user (if missing)
2. stages an immutable release: `$PREFIX/releases/<utc-stamp>/`
3. flips the symlink `$PREFIX/current` to it
4. installs `/etc/systemd/system/dev-agent.service`, enables and restarts it
5. waits up to 10s for `GET /api/health` to answer `{"ok":true}`
6. **rolls back to the previous release if the health check fails**
7. prunes all but the last 5 releases

`$PREFIX` defaults to `/opt/dev-agent`.

On a fresh box it creates `/etc/dev-agent.env` (mode `0600`) from
`dev-agent.env.example` with nothing secret. Set `HOST=127.0.0.1` when Caddy is
in front, then re-run the installer.

## 2. TLS with Caddy

```bash
sudo apt install caddy
getent hosts dev.fameshire.com          # must already be this VM before you start
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Caddy obtains and renews the certificate automatically; port **80 must be open**
for the ACME challenge, and **443** for traffic.

## 3. Firewall

```bash
sudo ufw allow 22/tcp && sudo ufw allow 80,443/tcp && sudo ufw enable
```

Do **not** expose 3000 — the service binds loopback when `HOST=127.0.0.1`, and
Node should never be the public face of the box.

## 4. Entra ID

Register `https://dev.fameshire.com` as a **SPA redirect URI** on the
`fameshire-dev-portal` app registration (Authentication → Single-page
application → Add URI). Frontend development with Vite also needs
`http://localhost:5173`; the built local portal uses `http://localhost:3000`.

## Verify

```bash
curl -s localhost:3000/api/health | jq .          # auth mode, scope, data dir
curl -sI https://dev.fameshire.com/ | grep -i content-type             # built portal
systemctl status dev-agent --no-pager
journalctl -u dev-agent -n 50 --no-pager
```

`auth.apiKeyPresent` must be **false** in production.

## Upgrade / rollback / uninstall

```bash
git fetch --tags && git checkout v1.3.0 && sudo ./deploy/install.sh
```

```bash
ls -1dt /opt/dev-agent/releases/* | sed -n 2p          # previous release
sudo ln -sfn /opt/dev-agent/releases/<that-one> /opt/dev-agent/current
sudo systemctl restart dev-agent
```

```bash
sudo systemctl disable --now dev-agent
sudo rm /etc/systemd/system/dev-agent.service /etc/dev-agent.env
sudo rm -rf /opt/dev-agent                             # deletes history too
sudo systemctl daemon-reload
```

## Troubleshooting

| Symptom | Cause |
|---|---|
| `503 no_credentials` | No identity and no key. Attach a managed identity and grant it `Cognitive Services User`, or set `FOUNDRY_API_KEY` with `FOUNDRY_AUTH=key` locally. |
| `401` from Foundry with a valid identity | Wrong scope. Classic Azure OpenAI needs `FOUNDRY_TOKEN_SCOPE=https://cognitiveservices.azure.com/.default`. |
| `403` from Foundry | Role missing or still propagating — `Cognitive Services User`, or `Azure AI Developer`. |
| Caddy will not get a cert | DNS not pointing here yet, or port 80 blocked. |
| Site loads, chat fails | `/api/health` returning HTML means something other than this server answers the hostname — check DNS. |
| Agent writes nothing | `DEV_AGENT_AUTO_APPLY=0`, or no ```file:``` blocks emitted. Look for `[apply]` in the journal. |

Sessions are capped at 400 turns each; delete old ones with
`DELETE /api/sessions/:id` or by removing the file under
`$PREFIX/shared/.data/sessions/users/*/sessions/`.
