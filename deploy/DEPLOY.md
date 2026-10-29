# Deploying to the prod box

Two supported targets. Both are keyless — no Foundry key is deployed.

---

## 1. VM / bare metal (systemd)

Requires Node 18+ and `curl`. Copy the release tarball or a git checkout onto the box, then:

```bash
sudo ./deploy/install.sh
```

That command is idempotent and does all of this:

1. creates a `devagent` system user (if missing)
2. stages an immutable release: `$PREFIX/releases/<utc-stamp>/`
3. flips the symlink `$PREFIX/current` to it
4. installs the unit as `/etc/systemd/system/dev-agent.service`, enables and restarts it
5. waits up to 10s for `GET /api/health` to answer `{"ok":true}`
6. **rolls back to the previous release if the health check fails**
7. prunes all but the last 5 releases

`$PREFIX` defaults to `/opt/dev-agent`.

### Sessions survive deploys

`DATA_DIR` defaults to `$PREFIX/shared/.data` — deliberately **outside** the
release directory, so switching versions never deletes conversation history.

### First install

On a fresh box the installer creates `/etc/dev-agent.env` (mode `0600`) from
`dev-agent.env.example` and fills in nothing secret. Review it, then re-run the
installer so the service picks it up:

```bash
sudoedit /etc/dev-agent.env     # check PORT, DATA_DIR, FOUNDRY_* values
sudo ./deploy/install.sh
```

### Verify

```bash
curl -s localhost:3000/api/health | jq .
systemctl status dev-agent --no-pager
journalctl -u dev-agent -n 50 --no-pager
```

`/api/health` returns the auth mode, scope, whether a key is present, and the
sessions directory. `auth.apiKeyPresent` should be **false** in production.

### Upgrade

```bash
git fetch --tags && git checkout v1.1.1
sudo ./deploy/install.sh
```

### Roll back

```bash
ls -1dt /opt/dev-agent/releases/* | sed -n 2p        # previous release
sudo ln -sfn /opt/dev-agent/releases/<that-one> /opt/dev-agent/current
sudo systemctl restart dev-agent
```

### Uninstall

```bash
sudo systemctl disable --now dev-agent
sudo rm /etc/systemd/system/dev-agent.service /etc/dev-agent.env
sudo rm -rf /opt/dev-agent          # deletes history too
sudo systemctl daemon-reload
```

---

## 2. Azure App Service / Functions

No systemd and **no IMDS** — the app uses `IDENTITY_ENDPOINT` automatically, so
keep `FOUNDRY_AUTH=auto` and leave `FOUNDRY_API_KEY` unset.

```bash
# app settings (no secrets)
az webapp config appsettings set -g <rg> -n momtv-api --settings \
  FOUNDRY_AUTH=auto PORT=8080 DATA_DIR=/home/data \
  FOUNDRY_TOKEN_SCOPE=https://ai.azure.com/.default \
  AGENT_ID=momtv-developer

# keyless access to the model
az webapp identity assign -g <rg> -n momtv-api          # note principalId
az role assignment create --assignee <principalId> \
  --role "Cognitive Services User" \
  --scope /subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.CognitiveServices/accounts/<foundry>

# ship it
az webapp deploy -g <rg> -n momtv-api --src-path app.zip --type zip
```

On App Service the filesystem under `DATA_DIR` is persistent; point it at
`/home/...`. Unknown paths are fine — the server serves `dev-portal/` and returns
JSON for unknown API routes.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| `503 no_credentials` | No identity and no key. Assign the role, or pass `FOUNDRY_API_KEY` locally with `FOUNDRY_AUTH=key`. |
| `401` from Foundry with a valid identity | Wrong scope. Classic Azure OpenAI needs `FOUNDRY_TOKEN_SCOPE=https://cognitiveservices.azure.com/.default`. |
| `403` from Foundry | Role missing or still propagating — `Cognitive Services User`, or `Azure AI Developer` for some setups. |
| Health OK but page is blank | Hard-refresh; assets are cache-busted with `?v=`. Check `/js/chat.js` returns `application/javascript`, not `text/html`. |
| Agent writes nothing | `DEV_AGENT_AUTO_APPLY=0`, or it emitted no ```file:``` blocks. Check journal for `[apply]` lines. |

Disk: sessions are capped at 400 turns each; prune old ones with
`rm /opt/dev-agent/shared/.data/sessions/users/*/sessions/<id>.json` or
`DELETE /api/sessions/:id`.
