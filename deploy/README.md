# Deploying Dash

Two environments, one release train. **Staging** receives every commit on `main`
after CI passes. **Production** receives a `vX.Y.Z` tag after one approval. Every
deploy job skips with a notice until its target is configured, so this whole
process can be switched on one surface at a time.

| Surface | Staging (`deploy-staging.yml`) | Production (`release.yml`) |
|---|---|---|
| relay + control plane | `server-do`, compose stack from `deploy/server/` | production host, same stack |
| web app (`apps/web`) | Cloudflare Pages `dash-web`, branch `staging` | Cloudflare Pages `dash-web`, branch `main` |
| waitlist worker | `atrium-waitlist-staging` (wrangler env `staging`) | `atrium-waitlist` |
| website (`apps/website`) | Cloudflare Pages `dashsquad-homepage`, branch `staging` | Cloudflare Pages `dashsquad-homepage`, branch `main` |
| Mission Control | — | DMG + zip on the draft GitHub Release |
| iOS | — | TestFlight upload |
| Android | — | signed AAB + APK on the release, Play internal track when configured |

## Day to day

**Ship to staging:** merge to `main`. When the **CI** workflow succeeds,
**Deploy staging** runs. Watch it under Actions; each job says what it deployed
or why it skipped.

**Cut a release:**

```bash
git checkout main && git pull
scripts/release.sh minor        # or patch / major; --dry-run to preview
```

That bumps every version file, commits `chore(release): vX.Y.Z`, tags, and
pushes. The **Release** workflow then verifies the tag, runs the full test
suite, builds the server image and desktop packages, and waits at the
`production` environment for approval before touching production targets.

**Approve production:** open the run, click *Review deployments*, approve
`production`. The web, website, waitlist, server, iOS and Android jobs proceed.

**Publish desktop:** open the draft release, check the notes, click *Publish*.
`install.sh` follows `releases/latest`, so this is the moment desktop users get
the new build.

## Roll back

| Surface | How |
|---|---|
| server | on the host: `cd <deploy dir> && ./deploy.sh ghcr.io/volumegambit/dash-server:<previous tag>` — `deploy.sh` prints the previous image after every deploy. Every image is also tagged `sha-<commit>`. |
| web / website | `npx wrangler pages deployment list --project-name <project>`, then `npx wrangler pages deployment rollback <id> --project-name <project>` (`dash-web` / `dashsquad-homepage`). Or re-run **Deploy staging** / **Release** at the previous ref. |
| waitlist | `cd apps/waitlist && npx wrangler rollback` (Workers keep recent versions). |
| desktop | unpublish or delete the release; `releases/latest` falls back to the previous one. |
| iOS / Android | expire the TestFlight build / halt the Play rollout in the store console. |

## One-time setup

All commands use the `gh` CLI against `volumegambit/Dash`. Run them yourself;
sessions and agents must not create secrets or environments.

This repository is public. Placeholders in angle brackets below (host IPs,
usernames, paths, account identifiers) are deliberately not written here; the
real values live in the private plans repo (`dash-dev-plans`,
`2026-09-08-devops-private-values.md`) and in GitHub environment secrets.

### 1. GitHub environments

```bash
gh api -X PUT repos/volumegambit/Dash/environments/staging
gh api -X PUT repos/volumegambit/Dash/environments/production \
  -F 'reviewers[][type]=User' -F "reviewers[][id]=$(gh api user -q .id)" \
  -F 'deployment_branch_policy[protected_branches]=false' \
  -F 'deployment_branch_policy[custom_branch_policies]=true'
gh api -X POST repos/volumegambit/Dash/environments/production/deployment-branch-policies \
  -f name='v*' -f type=tag
```

### 2. Repository-level configuration (shared by both environments)

Already present: secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`; variable
`CF_PAGES_PROJECT` (website). Add:

```bash
npx wrangler pages project create dash-web --production-branch main
gh variable set CF_PAGES_PROJECT_WEB --body dash-web
```

The Cloudflare API token needs *Account / Cloudflare Pages / Edit* and, for the
waitlist, *Account / Workers Scripts / Edit* and *D1 / Edit*.

### 3. Staging server (`server-do`)

The stack already runs there under `~/dash-relay-staging/` from a hand-built
image. Move it onto the in-repo compose file once:

```bash
ssh server-do 'mkdir -p ~/dash-server/{data/relay,data/cp,secrets}'
scp deploy/server/.env.example server-do:~/dash-server/.env
ssh server-do 'chmod 600 ~/dash-server/.env'
# copy the existing keypair, DBs and ADMIN_SECRET from ~/dash-relay-staging:
ssh server-do 'cp ~/dash-relay-staging/secrets/dial-token.* ~/dash-server/secrets/ && \
  cp ~/dash-relay-staging/data/relay/relay-creds.db ~/dash-server/data/relay/ && \
  cp ~/dash-relay-staging/data/cp/control-plane.db ~/dash-server/data/cp/ && \
  chown -R 1000:1000 ~/dash-server/data'
ssh server-do 'nano ~/dash-server/.env'      # ADMIN_SECRET, CLERK_CLIENT_ID, WEB_ORIGINS
```

Then a deploy key the workflow can use:

```bash
ssh-keygen -t ed25519 -N '' -f /tmp/dash-deploy -C dash-deploy-staging
ssh server-do 'cat >> ~/.ssh/authorized_keys' < /tmp/dash-deploy.pub
gh secret set SERVER_SSH_KEY  --env staging < /tmp/dash-deploy
gh secret set SERVER_SSH_HOST --env staging --body <staging host ip>
gh secret set SERVER_SSH_USER --env staging --body <ssh user>
ssh-keyscan <staging host ip> | gh secret set SERVER_KNOWN_HOSTS --env staging
gh variable set SERVER_DEPLOY_DIR --env staging --body <absolute path of the stack dir>
gh variable set CP_PUBLIC_URL     --env staging --body https://api.stg.relay.dash.volumegambit.com
gh variable set RELAY_PROBE_URL   --env staging --body https://smoke.stg.relay.dash.volumegambit.com
rm /tmp/dash-deploy /tmp/dash-deploy.pub
```

First deploy by hand to prove the stack, then stop the old one:

```bash
ssh server-do 'cd ~/dash-server && docker login ghcr.io && ./deploy.sh ghcr.io/volumegambit/dash-server:staging'
ssh server-do 'cd ~/dash-relay-staging && docker compose down'
```

The `staging` image tag exists after the first **Deploy staging** run. Before
the server is configured, run **Deploy staging** by hand (`workflow_dispatch`,
`ref=main`): it builds and pushes the image even while the server job skips.

### 4. Staging web and waitlist

```bash
gh variable set WEB_CLERK_PUBLISHABLE_KEY --env staging --body 'pk_test_…'
gh variable set WEB_CONTROL_PLANE_URL     --env staging --body https://api.stg.relay.dash.volumegambit.com
gh variable set WEB_RELAY_DOMAIN          --env staging --body stg.relay.dash.volumegambit.com
cd apps/waitlist && npx wrangler d1 create atrium-waitlist-staging   # paste the id into wrangler.toml [env.staging]
gh variable set WAITLIST_ENABLED --env staging --body true
```

After the first web deploy, put the Pages staging origin
(`https://staging.dash-web.pages.dev`) into `WEB_ORIGINS` in the server's `.env`
and redeploy, or browser calls to the control plane fail CORS.

### 5. Production server (`relay.dashsquad.ai`)

Naming, derived from how the code composes hostnames (the gateway allows the
web client at `app.<relay zone>` by default; the control plane reserves the
`api` label inside its zone):

| Role | Hostname |
|---|---|
| relay zone (one wildcard cert) | `relay.dashsquad.ai` |
| gateways | `<gateway-id>.relay.dashsquad.ai` |
| control plane | `api.relay.dashsquad.ai` |
| web app (Cloudflare Pages custom domain) | `app.relay.dashsquad.ai` |

Provision a host with Docker and a Traefik v3 instance on the `traefik` docker
network with a Cloudflare DNS-01 certificate resolver (server-do's `~/traefik`
compose is the reference; the Cloudflare API token needs *Zone / DNS / Edit* on
`dashsquad.ai`). DNS on Cloudflare, **DNS-only (grey cloud)** — the relay carries
long-lived WebSockets and terminates its own TLS:

```
A  relay.dashsquad.ai     <host ip>
A  *.relay.dashsquad.ai   <host ip>
```

Then repeat step 3 with `--env production`, `SERVER_SSH_*` for the new host, a
fresh keypair (`openssl genpkey -algorithm ed25519`), a fresh `ADMIN_SECRET`, and
in `.env`: `RELAY_ZONE=relay.dashsquad.ai`, `CP_HOST=api.relay.dashsquad.ai`,
`CP_PUBLIC_URL=https://api.relay.dashsquad.ai`,
`RELAY_PROBE_URL=https://smoke.relay.dashsquad.ai`,
`WEB_ORIGINS=https://app.relay.dashsquad.ai`, and the Clerk production values
from step 5a.

### 5a. Clerk production instance

The dev instance (`resolved-seahorse-39.clerk.accounts.dev`) stays for staging.
Production needs its own instance in the same Clerk application:

1. Clerk dashboard → the Dash application → **Create production instance**.
   Clerk asks for a domain: use `dashsquad.ai`. It gives you DNS records
   (`clerk.dashsquad.ai`, `accounts.dashsquad.ai`, and email CNAMEs); add them in
   Cloudflare as DNS-only and wait for *Verified*.
2. **Passkeys** must be enabled for the production instance (User & Authentication
   → Passkeys) — the web app signs in with passkeys only.
3. **OAuth application** for Mission Control / iOS (Configure → OAuth
   applications): create one like the dev app, with redirect URIs
   `dash://oauth-callback` and the scope `user:org:read` (this is what puts
   `org_id` on the token the control plane keys on). Note the client id.
4. **Organizations** must be enabled (the control plane maps `org_id` → account).
5. Collect: the publishable key (`pk_live_…`), the Frontend API host
   (`clerk.dashsquad.ai`), and the OAuth client id. Then:

```bash
gh variable set WEB_CLERK_PUBLISHABLE_KEY --env production --body 'pk_live_…'
# in the production server's .env:
#   CLERK_FRONTEND_API=clerk.dashsquad.ai
#   CLERK_CLIENT_ID=<oauth client id>
```

6. The web app's CSP allows `https://*.clerk.accounts.dev` and
   `https://*.clerk.com`; a production instance on `clerk.dashsquad.ai` is a new
   origin, so add it to `script-src`, `connect-src`, and `frame-src` in
   `apps/web/index.html` (and the README the CSP test mirrors) before the first
   production web deploy. Verify with a real passkey sign-in and zero CSP errors
   in the browser console — see `apps/web/README.md` "Launch checklist".
7. Mission Control and iOS Release builds read the control-plane URL and Clerk
   values from their build environment (`DASH_CONTROL_PLANE_URL`,
   `DASH_CLERK_FRONTEND_API`, `DASH_CLERK_CLIENT_ID`; iOS `IOS_CONTROL_PLANE_URL`
   via the release job). Point them at `https://api.relay.dashsquad.ai`.

### 6. Production web, waitlist, iOS, Android, desktop

```bash
gh variable set WEB_CONTROL_PLANE_URL     --env production --body https://api.relay.dashsquad.ai
gh variable set WEB_RELAY_DOMAIN          --env production --body relay.dashsquad.ai
gh variable set WAITLIST_ENABLED          --env production --body true
gh variable set IOS_CONTROL_PLANE_URL     --env production --body https://api.relay.dashsquad.ai
# Pages custom domain for the web app: Cloudflare → Pages → dash-web → Custom domains → app.relay.dashsquad.ai

# iOS — App Store Connect → Users and Access → Integrations → App Store Connect API
gh secret set ASC_KEY_ID      --env production --body 'ABC123DEFG'
gh secret set ASC_ISSUER_ID   --env production --body '…'
gh secret set ASC_PRIVATE_KEY --env production < AuthKey_ABC123DEFG.p8
gh secret set APPLE_TEAM_ID   --env production --body '<team id>'

# Android — keytool -genkeypair -v -keystore dash-release.keystore -alias dash -keyalg RSA -keysize 4096 -validity 10000
base64 -i dash-release.keystore | gh secret set ANDROID_KEYSTORE_BASE64 --env production
gh secret set ANDROID_KEYSTORE_PASSWORD --env production
gh secret set ANDROID_KEY_ALIAS         --env production --body dash
gh secret set ANDROID_KEY_PASSWORD      --env production
gh secret set PLAY_SERVICE_ACCOUNT_JSON --env production < play-service-account.json   # optional

# Desktop signing + notarization (optional; unsigned builds work via install.sh).
# The desktop job has no environment, so these are repository-level secrets.
base64 -i DeveloperID.p12 | gh secret set MAC_CSC_LINK
gh secret set MAC_CSC_KEY_PASSWORD
gh secret set APPLE_ID --body '<apple id email>'
gh secret set APPLE_APP_SPECIFIC_PASSWORD
gh secret set APPLE_TEAM_ID --body '<team id>'
```

## Development environment: spark-2 (not automated)

- **spark-2** runs relay, control plane and web as systemd user units on a
  private tailnet. Redeploy with the operator's local `spark2-deploy.sh` (see the
  private plans repo for paths). After any deploy,
  confirm an unauthenticated `GET <cp origin>/v1/gateways` returns `401`.
- **Mac gateway** is supervised by launchd (`com.dash.selfhost`) and runs the
  main checkout's `apps/gateway/dist`. Rebuild, then `pkill -f gateway/dist/index.js`
  and let launchd restart it. Do not start a second copy by hand.
- spark-2 stays a hand-deployed development environment by decision (2026-09-08);
  it is not a release target and the workflows never touch it.

## Notes

- `scripts/check-release-version.mjs` fails the release if any workspace,
  bundled plugin, or `ios/Config/Base.xcconfig` disagrees with the tag.
  `apps/web/package.json` is at `0.0.1` on `main` today; the next
  `scripts/release.sh` run brings it in line.
- The server image is built once per commit (`sha-<7>`) and retagged for
  `staging`, `vX.Y.Z`, and `latest`. Web bundles are built per environment
  because Vite bakes the control-plane and relay origins into the CSP.
- iOS build numbers are the release run number; Android `versionCode` likewise.
- The desktop job builds both `--x64` and `--arm64` because `install.sh` picks the
  no-suffix DMG for Intel and `-arm64.dmg` for Apple Silicon. `npmRebuild: false`
  in `electron-builder.yml` is required: inside an npm workspace the default
  production-install step prunes the root `node_modules` and the build dies.
  Native modules shipped via `extraResources` are therefore not rebuilt per arch —
  a pre-existing packaging gap, out of scope here.
- `apps/homepage` is an empty workspace directory and has no deploy lane.
- A standalone gateway image was removed with the stale root `Dockerfile`;
  reintroduce it under `deploy/gateway/` when a headless deployment needs it.
