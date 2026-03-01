# Mission Control — Comprehensive Development Plan

## Vision

Mission Control is a desktop application (Electron) and CLI tool that manages the deployment, configuration, observation, and secrets management of Dash agents. It runs on the user's machine and can deploy Dash agents either locally (via Docker) or to DigitalOcean. Core logic lives in a shared package (`@dash/mc`) consumed by both interfaces, enabling power users and coding agents to drive Mission Control from the command line.

## Architecture

```
┌─────────────────────────────────────────────────┐
│              Mission Control (Electron)          │
│  ┌──────────┐       ┌──────────────────────┐    │
│  │  React   │──IPC──│  Thin Main Process   │    │
│  │   UI     │       │  (delegates to       │    │
│  └──────────┘       │   @dash/mc)          │    │
│                     └──────────┬───────────┘    │
└──────────────────────────────────────────────────┘
                                 │
           ┌─────────────────────┼─────────────────────┐
           │              @dash/mc                      │
           │  ┌──────────┐ ┌────────┐ ┌─────────────┐  │
           │  │  Docker  │ │Secrets │ │ Agent       │  │
           │  │  Client  │ │Manager │ │ Registry    │  │
           │  └────┬─────┘ └────────┘ └──────┬──────┘  │
           │       │                         │         │
           │       │    ┌──────────────┐     │         │
           │       │    │ Management   │     │         │
           │       │    │ Client       │─────┘         │
           │       │    └──────┬───────┘               │
           └───────┼───────────┼───────────────────────┘
                   │           │
┌──────────────┐   │           │
│  mc CLI      │───┘           │
│  (commands   │       ┌───────┼───────────┐
│   delegate   │       │ localhost │ SSH    │
│   to @dash/mc│       ▼           ▼       ▼
└──────────────┘  ┌──────────┐  ┌──────────┐
                  │ Dash     │  │ Dash     │
                  │ (local)  │  │ (cloud)  │
                  └──────────┘  └──────────┘
```

## Tech Stack

| Component | Choice | Rationale |
|-----------|--------|-----------|
| Core package | @dash/mc | Shared logic for desktop + CLI — Docker, SSH, secrets, agent registry |
| Desktop shell | Electron | Battle-tested, rich Node.js API access, widest ecosystem |
| Build tool | electron-vite | Vite for all three Electron contexts (main/preload/renderer) |
| CLI framework | Commander.js | Most popular, declarative API, subcommands, auto-generated help |
| Frontend | React 19 + TypeScript | Largest ecosystem, best Electron support |
| UI components | shadcn/ui + Radix | Professional, accessible, composable |
| Styling | Tailwind CSS 4 | Required by shadcn/ui, rapid iteration |
| State (server) | TanStack Query | Polling agent status, caching, auto-refetch |
| State (client) | Zustand | Lightweight, no boilerplate |
| Routing | TanStack Router | Type-safe, SPA-native, integrates with TanStack Query — no server-side concepts to ignore |
| Docker | dockerode | Programmatic Docker API from Node.js |
| SSH | ssh2 | Pure JS SSH client, no native deps |
| Cloud | do-wrapper or raw fetch | DigitalOcean API v2 |
| Secrets | OS keychain (keytar) | Shared keychain access across desktop and CLI interfaces |
| Packaging | electron-builder | Cross-platform builds, auto-update |

---

## Channel & Agent Architecture

### The Problem

Channels (Telegram, Slack, WhatsApp) need to be **always listening** to receive messages. Agents only activate when processing a message. Today these are tightly coupled — `MessageRouter` holds a direct reference to `DashAgent` and calls `agent.chat()` in-process. This works when everything is in one container but prevents channels and agents from running on different machines.

### Channel Types by Connectivity

Not all channels are equal. Some can run anywhere, others need public internet access:

| Channel | Mode | Public Endpoint? | Can Run Locally? |
|---------|------|-------------------|-----------------|
| Telegram | Long-polling | No | Yes |
| Slack | Socket Mode | No | Yes |
| Discord | Gateway (WebSocket) | No | Yes |
| WhatsApp | Webhook | **Yes (HTTPS)** | **No** |
| Slack (HTTP) | Webhook | **Yes (HTTPS)** | **No** |
| Telegram (webhook) | Webhook | **Yes (HTTPS)** | **No** |

**Implication**: If a user wants WhatsApp, they MUST deploy to the cloud. Mission Control's deploy wizard must enforce this — if a webhook-based channel is selected, local deployment is not an option.

### v1: Bundled (Channel + Agent in one container)

The simplest deployment model. One container runs everything.

```
┌──────────────────────────────────────────────┐
│  Dash Container                              │
│                                              │
│  ┌────────────┐       ┌───────────────────┐  │
│  │  Channel   │ in-   │  Agent Runtime    │  │
│  │  Adapters  │process│  (DashAgent)      │  │
│  │            │──────►│                   │  │
│  │  Telegram  │       │  LLM + Tools +    │  │
│  │  Slack     │◄──────│  Sessions         │  │
│  └────────────┘       └───────────────────┘  │
│                                              │
│  ┌────────────────────────────────────────┐  │
│  │  Management API (127.0.0.1:9100)      │  │
│  └────────────────────────────────────────┘  │
│                                              │
│  ┌────────────────────────────────────────┐  │
│  │  Webhook Endpoint (0.0.0.0:443)       │  │
│  │  (only if webhook channels configured) │  │
│  └────────────────────────────────────────┘  │
└──────────────────────────────────────────────┘
```

**This is the deployment model for all of v1.** One container per deployment. Channels and agent live together.

**Pros:**
- Simplest to deploy (one container = one thing to manage)
- No inter-process communication latency
- Mission Control manages one container per deployment

**Cons:**
- Agent crash kills channel connections (auto-restart mitigates this)
- Can't scale channels and agents independently
- Restarting the agent drops channel connections briefly

### v2 (Future): Separated Gateway + Worker

When the system needs to support multiple agents per channel gateway, or zero-downtime agent updates, the architecture can split:

```
┌────────────────────┐         ┌──────────────────────┐
│  Channel Gateway   │  HTTP   │  Agent Worker         │
│                    │         │                       │
│  Telegram Adapter  │────────►│  POST /chat           │
│  Slack Adapter     │         │  (SSE response)       │
│  WhatsApp Adapter  │◄────────│                       │
│                    │         │  DashAgent runtime    │
│  MessageRouter     │         │  Management API       │
│  (uses AgentClient)│         │                       │
└────────────────────┘         └──────────────────────┘
```

### Designing for Separability (Build in v1)

Even though v1 is bundled, we introduce an `AgentClient` interface so the MessageRouter doesn't depend on `DashAgent` directly. This is a small abstraction that makes future separation possible without rewriting the router.

```typescript
// packages/agent/src/client.ts

/** Abstraction over agent communication — in-process or remote */
interface AgentClient {
  chat(
    channelId: string,
    conversationId: string,
    text: string,
  ): AsyncGenerator<AgentEvent>;
}

/** v1: In-process — delegates directly to DashAgent */
class LocalAgentClient implements AgentClient {
  constructor(private agent: DashAgent) {}
  async *chat(channelId, conversationId, text) {
    yield* this.agent.chat(channelId, conversationId, text);
  }
}

/** v2 (future): Remote — calls agent over HTTP, receives SSE stream */
class RemoteAgentClient implements AgentClient {
  constructor(private baseUrl: string, private token: string) {}
  async *chat(channelId, conversationId, text) {
    // POST /chat → receive SSE stream → yield AgentEvent objects
  }
}
```

The `MessageRouter` is updated to accept `AgentClient` instead of `DashAgent`:

```typescript
// packages/channels/src/router.ts (updated)
class MessageRouter {
  private adapters: { adapter: ChannelAdapter; client: AgentClient }[] = [];

  addAdapter(adapter: ChannelAdapter, client: AgentClient): void { ... }
}
```

When Dash starts in bundled mode, it creates `LocalAgentClient` instances. If channels are later separated, the gateway creates `RemoteAgentClient` instances instead. The router code stays the same.

### Chat API (Added to Management API)

For the separated architecture (and for Mission Control to send test messages), the agent exposes a chat endpoint:

```
POST /chat
Authorization: Bearer <token>
Content-Type: application/json

{
  "channelId": "telegram",
  "conversationId": "12345",
  "senderId": "user1",
  "senderName": "Alice",
  "text": "Hello agent"
}

Response: text/event-stream (SSE)
data: {"type":"thinking","content":"..."}
data: {"type":"tool_use","name":"bash","input":{...}}
data: {"type":"tool_result","content":"..."}
data: {"type":"response","content":"Hello! How can I help?"}
data: {"type":"done"}
```

### Webhook Handling for Cloud Deployments

When a deployment includes webhook-based channels (WhatsApp, Slack HTTP mode), the container must expose a public HTTPS endpoint. This changes the deployment requirements:

**Polling-only deployment (Telegram, Slack Socket Mode):**
- DigitalOcean firewall: port 22 (SSH) only
- No TLS certificate needed
- No domain needed

**Webhook deployment (WhatsApp, Slack HTTP):**
- DigitalOcean firewall: port 22 (SSH) + port 443 (HTTPS)
- TLS certificate required (Let's Encrypt via certbot, auto-renewed)
- Domain optional (can use IP, but some platforms require a domain)
- Webhook URL configured with the IM platform during deployment

Mission Control handles this automatically:
1. Deploy wizard detects webhook channels in the config
2. Warns user that cloud deployment is required
3. During provisioning: installs certbot, obtains TLS cert, opens port 443
4. Registers webhook URL with the IM platform's API
5. On teardown: deregisters webhook

---

## Networking & Security

### Local Deployment
- Dash runs as a Docker container on the user's machine
- Management API exposed on `localhost:9100` (configurable)
- API token still required (defense in depth against other local processes)
- Mission Control connects directly via HTTP to `localhost:9100`

### Cloud Deployment (DigitalOcean)

#### SSH Tunnel — Fully Transparent to the User

The user never sees, configures, or knows about SSH. Mission Control handles everything programmatically using the `ssh2` library (pure JavaScript, no system SSH needed).

**What the user experiences:**
1. Enters DigitalOcean API token in Mission Control
2. Clicks "Deploy" in the wizard
3. Sees a progress bar
4. Agent appears as "Running" in the dashboard

**What Mission Control does behind the scenes:**
1. Generates Ed25519 SSH keypair using Node.js `crypto`
2. Stores private key in Electron safeStorage (OS keychain)
3. Uploads public key to DigitalOcean via API
4. Creates droplet with that SSH key
5. Creates Cloud Firewall (port 22 only — or +443 if webhook channels)
6. Waits for droplet to boot
7. Connects via `ssh2` library (no system SSH binary needed)
8. Provisions Docker + deploys Dash container
9. Opens SSH port-forward tunnel: `local:random_port → remote:127.0.0.1:9100`
10. Routes all management API calls through the tunnel
11. Auto-reconnects tunnel on connection drop (exponential backoff)

```
Mission Control                          DigitalOcean Droplet
┌──────────────────┐                   ┌─────────────────────────┐
│                  │   ssh2 library    │                         │
│  MC Management ──┼──(port forward)──►│── 127.0.0.1:9100       │
│  Client          │   transparent     │   Management API       │
│                  │                   │   (never on 0.0.0.0)   │
└──────────────────┘                   │                         │
                                       │   0.0.0.0:443 ◄────────│── Webhooks
                                       │   (only if needed)     │   (WhatsApp etc.)
                                       └─────────────────────────┘

Firewall: port 22 required, port 443 only if webhook channels configured
```

#### Real-Time Communication: SSE over SSH Tunnel

For real-time data (log streaming, status updates), Mission Control uses **Server-Sent Events (SSE)** over the SSH tunnel. This is one-directional (Dash → Mission Control) and works reliably over tunneled HTTP.

- **Log streaming**: `GET /logs` → SSE stream of structured log lines
- **Status updates**: Mission Control polls `GET /health` every 5 seconds via TanStack Query
- **Commands** (restart, config update, shutdown): Regular HTTP POST through the tunnel

No WebSocket is needed for v1. SSE + polling covers all use cases:
- Logs: SSE (push)
- Agent status: Polling (every 5s)
- Channel status: Polling (every 5s)
- Config changes: HTTP POST (on-demand)
- Lifecycle commands: HTTP POST (on-demand)

If bidirectional push becomes necessary in the future (e.g., agent alerts Mission Control about a critical event), the path forward is mTLS + direct WebSocket connection (Phase 5), bypassing the SSH tunnel for that specific connection.

#### Additional Hardening
- SSH key-only authentication (password auth disabled via cloud-init)
- DigitalOcean Cloud Firewall (restrict port 22 to known IPs when possible)
- fail2ban on the droplet
- Non-root SSH user (created during provisioning)
- Management API token required even over the tunnel (defense in depth)
- Automatic security updates (unattended-upgrades)

#### mTLS (Future — Phase 5)
When persistent connections or direct WebSocket is needed:
- Mission Control generates a root CA on first launch
- Server certs issued per-agent during deployment
- Client cert used by Mission Control
- Management port exposed on a non-standard port with mTLS required
- Combined with DigitalOcean firewall for defense in depth
- Enables direct WebSocket without SSH tunnel

---

## Monorepo Reorganization

The repo must be restructured to support both Dash and Mission Control as separate applications sharing common packages.

### Current Structure
```
Dash/
├── packages/
│   ├── llm/            @dash/llm
│   ├── agent/          @dash/agent
│   ├── channels/       @dash/channels
│   ├── tui/            @dash/tui
│   └── server/         @dash/server
```

### Target Structure
```
Dash/
├── apps/
│   ├── dash/                     # Dash agent runtime
│   │   ├── package.json          # name: @dash/app
│   │   ├── src/
│   │   │   ├── index.ts          # Entry point
│   │   │   ├── gateway.ts        # Bootstrap channels + agent + management API
│   │   │   └── config.ts         # Config loader
│   │   └── Dockerfile
│   │
│   ├── tui/                      # Terminal chat UI
│   │   ├── package.json          # name: @dash/tui
│   │   └── src/
│   │
│   ├── mission-control/          # Electron desktop app
│   │   ├── package.json          # name: @dash/mission-control
│   │   ├── electron-builder.yml
│   │   ├── electron.vite.config.ts
│   │   └── src/
│   │       ├── main/             # Thin IPC layer delegating to @dash/mc
│   │       ├── preload/          # Context bridge
│   │       ├── renderer/         # React UI
│   │       └── shared/           # IPC contract types
│   │
│   └── mc-cli/                   # CLI tool
│       ├── package.json          # name: @dash/mc-cli, bin: { "mc": ... }
│       └── src/
│           ├── index.ts          # Entry point + Commander setup
│           └── commands/         # deploy, status, logs, secrets, ...
│
├── packages/
│   ├── llm/                      # Unchanged
│   ├── agent/                    # Unchanged
│   ├── channels/                 # Unchanged
│   ├── management/               # Management API (types, server, client)
│   │   ├── package.json          # name: @dash/management
│   │   └── src/
│   │       ├── index.ts
│   │       ├── types.ts          # Shared API types (request/response shapes)
│   │       ├── server.ts         # HTTP routes (embedded in Dash)
│   │       └── client.ts         # HTTP client (used by Mission Control)
│   │
│   └── mc/                       # Mission Control core logic
│       ├── package.json          # name: @dash/mc
│       └── src/
│           ├── index.ts
│           ├── types.ts          # Shared types (DeployConfig, AgentDeployment, etc.)
│           ├── docker/           # Docker client, images, containers
│           ├── cloud/            # DigitalOcean, SSH, provisioner
│           ├── security/         # Secrets (keychain abstraction), keygen
│           └── agents/           # Registry, connector
│
├── package.json                  # Workspace paths: ["packages/*", "apps/*"]
├── Dockerfile                    # For apps/dash
├── tsconfig.base.json            # Unchanged
└── biome.json                    # Unchanged
```

### Key Changes During Reorganization
1. `packages/server` → `apps/dash` — all internal imports stay the same, just the location changes
2. `packages/tui` → `apps/tui` — same treatment
3. Root `package.json` workspaces updated to `["packages/*", "apps/*"]`
4. Dockerfile `COPY` paths updated to reference `apps/dash`
5. CI workflow paths updated
6. `CLAUDE.md` quick reference updated

---

## Management API Design

The management API is a lightweight HTTP server embedded in the Dash runtime. It runs alongside the gateway and provides operational control.

### Endpoints

```
Authentication: Bearer token in Authorization header
Content-Type: application/json (except SSE endpoints)

GET  /health
  → { status: "healthy", uptime: 12345, version: "1.0.0" }

GET  /info
  → { agents: [...], channels: [...], config: {...} }

GET  /agents
  → [{ name: "default", status: "running", model: "...", tools: [...] }]

POST /agents/:name/restart
  → { success: true }

GET  /channels
  → [{ name: "telegram", type: "telegram", status: "connected", agent: "default" }]

GET  /config
  → { agents: {...}, channels: {...}, sessions: {...} }

PUT  /config
  ← { agents: {...}, channels: {...} }
  → { success: true, restartRequired: boolean }

POST /chat
  ← { channelId, conversationId, senderId, senderName, text }
  → SSE stream of AgentEvent objects (for separated architecture + test messages)

GET  /sessions
  ?channelId=telegram&limit=50
  → [{ id, channelId, userId, messageCount, lastActive }]

GET  /sessions/:id
  → { id, messages: [...] }

GET  /logs
  Accept: text/event-stream
  → SSE stream of structured log lines (pino JSON logs)

POST /lifecycle/shutdown
  → { success: true } (then process exits gracefully)
```

### Authentication
- Token generated by Mission Control during deployment
- Stored in Mission Control's encrypted store (Electron safeStorage)
- Injected into Dash container as `MANAGEMENT_API_TOKEN` env var
- Validated on every request via middleware
- For localhost deployments: token still required (protects against other local processes)

---

## Secrets Management

Mission Control is the single source of truth for secrets. It stores them encrypted and injects them during deployment.

### Storage
- **OS Keychain** — accessed via keytar (works in both Electron and CLI contexts)
  - macOS: Keychain
  - Windows: DPAPI
  - Linux: libsecret (GNOME Keyring / KWallet)
- The `@dash/mc` security module provides a `SecretStore` interface with a `KeytarSecretStore` implementation
- Both desktop and CLI share the same OS keychain, so secrets set in one are available in the other
- Secrets stored as encrypted blobs in `~/.mission-control/secrets.enc`
- Decrypted only in memory, never written to disk in plaintext

### Secret Types
```typescript
interface SecretStore {
  // LLM provider keys
  anthropicApiKey?: string;
  openaiApiKey?: string;

  // Channel tokens
  telegramBotToken?: string;
  slackBotToken?: string;
  whatsappAccessToken?: string;

  // Infrastructure
  digitaloceanApiToken?: string;
  sshKeys: Record<string, { publicKey: string; privateKey: string }>;  // per deployment

  // Per-agent management tokens
  agentTokens: Record<string, string>;  // deploymentId → management API token
}
```

### Injection Flow
1. User enters secrets in Mission Control UI
2. Secrets encrypted and stored locally
3. During deployment, Mission Control:
   - For local Docker: passes secrets as environment variables to container
   - For DigitalOcean: passes secrets via SSH (direct file write to container env), never through DO API metadata

---

## Electron App Architecture

### Main Process (`src/main/`)
Runs in Node.js. A thin IPC adapter — all business logic lives in `@dash/mc`, and the main process delegates to it.

```
src/main/
├── index.ts                # App lifecycle, window creation
├── ipc.ts                  # IPC handler registration — each handler delegates to @dash/mc
└── windows.ts              # Window management
```

All docker/, cloud/, security/, and agents/ logic lives in `packages/mc/src/` and is shared with the CLI. The main process simply imports and calls these modules in response to IPC requests from the renderer.

### Preload (`src/preload/`)
Minimal bridge exposing typed APIs to the renderer via contextBridge.

```typescript
// Exposed API shape
interface MissionControlAPI {
  agents: {
    list(): Promise<AgentDeployment[]>;
    deploy(config: DeployConfig): Promise<void>;
    remove(id: string): Promise<void>;
    getStatus(id: string): Promise<AgentStatus>;
    getLogs(id: string, callback: (line: string) => void): () => void;
    updateConfig(id: string, config: Partial<AgentConfig>): Promise<void>;
  };
  secrets: {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<void>;
    delete(key: string): Promise<void>;
    list(): Promise<string[]>;  // Returns keys only, never values
  };
  docker: {
    isAvailable(): Promise<boolean>;
    getInfo(): Promise<DockerInfo>;
  };
  cloud: {
    testConnection(token: string): Promise<boolean>;
    listDroplets(): Promise<Droplet[]>;
  };
  app: {
    getVersion(): Promise<string>;
    getPlatform(): Promise<string>;
  };
}
```

### Renderer (`src/renderer/`)
React SPA with TanStack Router, TanStack Query, and shadcn/ui components.

```
src/renderer/
├── index.html
├── main.tsx                # React root + providers
├── App.tsx                 # Router outlet + layout
├── router.tsx              # Route definitions
├── components/
│   ├── layout/
│   │   ├── Shell.tsx       # App shell (sidebar + content area)
│   │   ├── Sidebar.tsx     # Navigation sidebar
│   │   └── Header.tsx      # Top bar with status indicators
│   ├── agents/
│   │   ├── AgentList.tsx        # Overview of all deployed agents
│   │   ├── AgentCard.tsx        # Single agent status card
│   │   ├── AgentDetail.tsx      # Full agent view (config, logs, sessions)
│   │   └── AgentConfigForm.tsx  # Edit agent configuration
│   ├── deploy/
│   │   ├── DeployWizard.tsx     # Step-by-step deployment flow
│   │   ├── TargetSelect.tsx     # Choose local vs cloud (enforces cloud for webhooks)
│   │   ├── AgentConfig.tsx      # Configure agent settings
│   │   ├── ChannelConfig.tsx    # Configure channels (shows requirements per channel)
│   │   └── Review.tsx           # Review and deploy
│   ├── logs/
│   │   ├── LogViewer.tsx        # Real-time log stream
│   │   └── LogFilters.tsx       # Filter by level, search
│   ├── secrets/
│   │   ├── SecretsManager.tsx   # List and manage secrets
│   │   └── SecretForm.tsx       # Add/edit a secret
│   └── settings/
│       └── Settings.tsx         # App-level settings
├── hooks/
│   ├── useAgents.ts        # TanStack Query hooks for agent data
│   ├── useLogs.ts          # Log streaming hook
│   └── useSecrets.ts       # Secrets management hook
├── stores/
│   ├── app.ts              # Zustand: UI state (sidebar open, selected agent, etc.)
│   └── deploy.ts           # Zustand: deployment wizard state
└── lib/
    ├── api.ts              # Typed wrapper around window.api (preload bridge)
    └── utils.ts            # Shared utilities (cn, formatters)
```

### UI Pages & Navigation

```
Sidebar:
  ├── Dashboard         → Overview of all agents, quick health check
  ├── Agents            → Agent list with deploy/manage actions
  │   └── [Agent]       → Detail view (config, logs, sessions, channels)
  ├── Deploy            → Deployment wizard
  ├── Secrets           → Secrets management
  └── Settings          → App preferences, Docker config, DO credentials
```

---

## Deployment Flows (Detailed)

### Local Deployment (Docker on User's Machine)

**Prerequisites**: Docker Desktop installed and running.

**Deploy Wizard Flow:**
1. **Target**: "Local (Docker)" selected
2. **Agent Config**: Model, system prompt, tools, max tokens
3. **Channels**: Select from available channels
   - Telegram: enter bot token, allowed users
   - Slack (Socket Mode): enter bot token, app token
   - *WhatsApp grayed out with tooltip: "Requires cloud deployment"*
4. **Review**: Summary of config, estimated resource usage
5. **Deploy**: Click to start

**What Mission Control does:**
```
1. Validate Docker is running (dockerode ping)
2. Generate management API token (crypto.randomBytes)
3. Store all secrets in safeStorage
4. Check if Dash Docker image exists locally
   → If not: build from repo source (docker build) or pull from registry
5. Create container:
   - Image: dash:latest
   - Env vars: ANTHROPIC_API_KEY, TELEGRAM_BOT_TOKEN, MANAGEMENT_API_TOKEN, etc.
   - Port mapping: host:random_port → container:9100 (management API)
   - Volume: ~/.mission-control/data/{deploymentId}/sessions → /app/data/sessions
   - Restart policy: unless-stopped
6. Start container
7. Poll GET /health until healthy (timeout: 30s)
8. Register in agent registry:
   { id, name, target: "local", containerId, managementPort, channels, createdAt }
9. Navigate to Agent Detail page
```

**Teardown:**
1. Stop container (docker stop, graceful with SIGTERM)
2. Remove container (docker rm)
3. Remove from agent registry
4. Secrets retained (user may redeploy)

### Cloud Deployment (DigitalOcean)

**Prerequisites**: DigitalOcean API token entered in Secrets.

**Deploy Wizard Flow:**
1. **Target**: "DigitalOcean" selected
2. **Region & Size**: Select droplet region (auto-suggest nearest) and size
   - Minimum: 1 vCPU, 1 GB RAM ($6/mo) for a single agent
   - Recommended: 1 vCPU, 2 GB RAM ($12/mo) for agents with tools
3. **Agent Config**: Same as local
4. **Channels**: All channels available including webhook-based
   - WhatsApp: enter access token, phone number ID, verify token
   - Shows: "This channel requires a public HTTPS endpoint. A TLS certificate will be automatically configured."
5. **Review**: Summary + estimated monthly cost
6. **Deploy**: Click to start

**What Mission Control does (provisioning):**
```
 1. Generate Ed25519 SSH keypair (Node.js crypto)
 2. Store private key in safeStorage
 3. Upload public key to DigitalOcean (POST /v2/account/keys)
 4. Create droplet:
    - Image: ubuntu-24-04-x64
    - Size: selected by user
    - Region: selected by user
    - SSH key: the one just uploaded
    - User-data (cloud-init) script:
      #!/bin/bash
      # Install Docker
      curl -fsSL https://get.docker.com | sh
      # Create non-root user
      useradd -m -s /bin/bash dash
      usermod -aG docker dash
      # Copy SSH authorized_keys to dash user
      mkdir -p /home/dash/.ssh
      cp /root/.ssh/authorized_keys /home/dash/.ssh/
      chown -R dash:dash /home/dash/.ssh
      # Disable root SSH login
      sed -i 's/PermitRootLogin yes/PermitRootLogin no/' /etc/ssh/sshd_config
      systemctl restart sshd
      # Install fail2ban
      apt-get install -y fail2ban
      systemctl enable fail2ban
      # Install certbot (if webhook channels)
      apt-get install -y certbot
      # Enable unattended upgrades
      apt-get install -y unattended-upgrades
      dpkg-reconfigure -f noninteractive unattended-upgrades
 5. Create Cloud Firewall:
    - Inbound: port 22 (SSH)
    - Inbound: port 443 (HTTPS) — only if webhook channels configured
    - Outbound: all (agent needs to reach LLM APIs and IM platform APIs)
    - Attach to droplet
 6. Wait for droplet status: "active" (poll GET /v2/droplets/{id})
 7. Wait for cloud-init to complete:
    - SSH in as dash user
    - Run: cloud-init status --wait
 8. If webhook channels configured:
    - Run certbot for TLS certificate
    - (Or use DigitalOcean load balancer with managed cert — evaluate tradeoff)
 9. Transfer Dash Docker image:
    - Option A: docker save → SCP → docker load (simple, ~200MB transfer)
    - Option B: Push to DO Container Registry → docker pull (faster for updates)
10. Create .env file on droplet (via SSH, written to /home/dash/dash/.env)
    - Contains all secrets: API keys, tokens, management token
11. Create docker-compose.yml on droplet (via SSH)
12. Run: docker compose up -d
13. Open SSH tunnel: local:random_port → remote:127.0.0.1:9100
14. Poll GET /health through tunnel until healthy (timeout: 60s)
15. If webhook channels:
    - Register webhook URL with IM platform API
    - e.g., POST to WhatsApp API with callback URL = https://{droplet_ip}/webhook
16. Register in agent registry:
    { id, name, target: "digitalocean", dropletId, dropletIp, region,
      sshKeyId, managementPort, channels, monthlyCost, createdAt }
17. Navigate to Agent Detail page
```

**Teardown:**
1. If webhook channels: deregister webhooks with IM platforms
2. SSH in: `docker compose down`
3. Destroy droplet (DELETE /v2/droplets/{id})
4. Remove SSH key from DO (DELETE /v2/account/keys/{id})
5. Remove firewall (DELETE /v2/firewalls/{id})
6. Remove from agent registry
7. Remove SSH private key from safeStorage

### Updating a Deployed Agent

When the user changes agent config (model, system prompt, tools, channels) in Mission Control:

**For local deployments:**
1. Stop existing container
2. Remove existing container
3. Create new container with updated env vars / config
4. Start new container
5. Wait for health check

**For cloud deployments:**
1. SSH in, update .env and/or docker-compose.yml
2. Run: `docker compose down && docker compose up -d`
3. Re-establish SSH tunnel
4. Wait for health check
5. If channel webhook URLs changed: update webhook registrations

**Config hot-reload (future enhancement):** Add a `POST /config/reload` endpoint to Dash that re-reads config and restarts internal components without container restart.

---

## Development Phases

---

### Phase 0: Monorepo Reorganization
**Goal**: Restructure the repo without breaking existing functionality.

**Steps:**
1. Create `apps/` directory
2. Move `packages/server/` → `apps/dash/`
   - Update `package.json` name to `@dash/app`
   - Update internal import paths (they use relative paths, so most stay the same)
   - Move Dockerfile into `apps/dash/` or update root Dockerfile paths
3. Move `packages/tui/` → `apps/tui/`
   - Update `package.json` name to `@dash/tui`
4. Update root `package.json` workspaces: `["packages/*", "apps/*"]`
5. Update root `Dockerfile` COPY paths to reference `apps/dash`
6. Update `docker-compose.yml` if needed
7. Update `biome.json` include/exclude paths
8. Update `.github/workflows/ci.yml` paths
9. Update `CLAUDE.md` with new paths and commands
10. Run `npm install` to regenerate lockfile
11. Run `npm run build` — verify all packages build
12. Run `npm test` — verify all tests pass
13. Run `docker build .` — verify Docker still works

**Verification**: `npm run build && npm test` passes. `docker build .` succeeds.

---

### Phase 1: Management API + AgentClient (`@dash/management`)
**Goal**: Dash exposes a management API. Introduce AgentClient interface for separability.

**Steps:**
1. Create `packages/management/` with standard package setup (tsup, tsconfig)
2. Define API types in `types.ts`:
   - Request/response shapes for all endpoints including `/chat`
   - `AgentStatus`, `ChannelStatus`, `HealthResponse`, `ChatRequest`, `ChatEvent`
3. Implement server in `server.ts`:
   - Use Node.js built-in `http` module (no framework dependency)
   - Implement endpoints: `/health`, `/agents`, `/channels`, `/config`, `/chat` (SSE), `/sessions`, `/logs` (SSE), `/lifecycle/shutdown`
   - Bearer token authentication middleware
   - SSE helper for streaming endpoints
4. Implement client in `client.ts`:
   - Typed HTTP client matching all endpoints
   - SSE client for log streaming and chat streaming
   - Configurable base URL and auth token
5. Introduce `AgentClient` interface in `packages/agent/`:
   - `AgentClient` interface with `chat()` method
   - `LocalAgentClient` implementing it by delegating to `DashAgent`
   - Update `MessageRouter` to accept `AgentClient` instead of `DashAgent`
6. Integrate management server into `apps/dash`:
   - Start HTTP server alongside gateway in `index.ts`
   - Wire routes to gateway state (agents map, router, config)
   - `MANAGEMENT_API_PORT` (default 9100) and `MANAGEMENT_API_TOKEN` env vars
   - Bind to `127.0.0.1` by default
7. Write tests:
   - Unit tests for client (mock HTTP responses)
   - Integration test: start management server, hit all endpoints, verify responses
   - Test AgentClient abstraction (LocalAgentClient delegates correctly)

**Verification**: `curl http://localhost:9100/health` returns valid JSON. All tests pass.

---

### Phase 2a: Mission Control Core + CLI
**Goal**: Core package with foundational modules. CLI skeleton that proves the architecture.

**Steps:**
1. Create `packages/mc/` — types, secrets abstraction (keytar), keygen (crypto.randomBytes), agent registry (JSON file at `~/.mission-control/agents.json`), agent connector (wraps ManagementClient)
2. Create `apps/mc-cli/` — Commander.js setup with initial commands: `mc version`, `mc health <url>`, `mc info <url>`
3. Wire CLI commands to `@dash/mc` + `@dash/management` ManagementClient
4. Tests for core modules (keygen, registry) + CLI smoke tests

**Verification**: `mc version` prints version. `mc health http://localhost:9100 -t <token>` (with a running Dash instance) returns health status.

---

### Phase 2b: Mission Control Desktop Shell
**Goal**: Electron app launches with React UI, navigation works, trivial IPC proves the bridge.

**Steps:**
1. Initialize `apps/mission-control/` with `electron-vite`:
   - Configure `electron.vite.config.ts` for main/preload/renderer
   - Add `electron-builder.yml` for packaging config
2. Set up React in renderer:
   - React 19, TanStack Router, TypeScript
   - Tailwind CSS 4 configuration
   - shadcn/ui initialization
3. Build the app shell:
   - `Shell.tsx` — sidebar + content layout
   - `Sidebar.tsx` — navigation links
   - Placeholder pages: Dashboard, Agents, Deploy, Secrets, Settings
4. Set up IPC bridge with one trivial command (`app.getVersion`) to prove main↔renderer works:
   - `src/shared/ipc.ts` — define MissionControlAPI interface
   - `preload/index.ts` — contextBridge exposing typed API
   - `main/ipc.ts` — handle `app:getVersion`, delegate to @dash/mc or Electron API
5. Set up state management:
   - Zustand store for UI state
   - TanStack Query provider
6. Configure build and dev scripts:
   - `npm run mc:dev` — starts Electron in dev mode with HMR
   - `npm run mc:build` — builds the Electron app
   - NOT included in root `npm run build` (different pipeline, too slow)

**Verification**: `npm run mc:dev` launches an Electron window with sidebar navigation. Settings page shows app version via IPC.

---

### Phase 3: Local Agent Deployment
**Goal**: Deploy and manage a Dash agent running in Docker on the user's machine.

**Steps:**
1. Docker detection and management (`packages/mc/src/docker/`):
   - `client.ts` — detect if Docker is running, get Docker info via dockerode
   - `images.ts` — build Dash Docker image from the repo (or pull from registry)
   - `containers.ts` — create, start, stop, remove containers with env vars + volumes
   - Handle Docker not installed / not running with clear error messages and guidance
2. Secrets and keygen already exist in `packages/mc/src/security/` from Phase 2a
3. Agent registry already exists in `packages/mc/src/agents/` from Phase 2a
4. Management client connector (`packages/mc/src/agents/connector.ts`):
   - Use `@dash/management` client to talk to local agent
   - For local: direct HTTP to `localhost:{port}`
   - Expose via IPC in desktop, via commands in CLI
5. Deploy wizard UI (`renderer/components/deploy/`):
   - Step 1: Target — "Local (Docker)" (cloud grayed out with "Coming soon")
   - Step 2: Agent config — model, system prompt, tools, workspace
   - Step 3: Channels — select channels, enter tokens
     - Webhook channels show warning: "Requires cloud deployment"
   - Step 4: Review — summary of what will be deployed
   - Step 5: Deploying — progress bar with real status updates
   - On completion: navigate to Agent Detail page
6. Agent management UI (`renderer/components/agents/`):
   - `AgentList.tsx` — all deployed agents with status badges
   - `AgentCard.tsx` — name, model, channels, status (running/stopped/error), actions
   - `AgentDetail.tsx` — full view with tabs: Overview, Config, Logs, Sessions
   - Status polling via TanStack Query (poll `/health` every 5s)
7. Log viewer (`renderer/components/logs/`):
   - Connect to management API `/logs` SSE endpoint via IPC
   - Real-time log display with auto-scroll
   - Filter by log level (info, warn, error)
   - Search within visible logs
8. Config editor:
   - Edit agent config (model, system prompt, tools) in the UI
   - Save triggers container restart (stop → recreate → start)
   - Shows restart confirmation dialog

**Verification**: User can open Mission Control → Deploy Wizard → configure a local agent → click Deploy → see it running → view logs → edit config → stop it → remove it.

---

### Phase 4: Cloud Deployment (DigitalOcean)
**Goal**: Deploy Dash agents to DigitalOcean droplets and manage them remotely.

**Steps:**
1. DigitalOcean integration (`packages/mc/src/cloud/digitalocean.ts`):
   - API client for: droplets, SSH keys, firewalls, regions, sizes
   - Store DO API token in secrets manager
   - Connection test endpoint for Settings page
2. SSH infrastructure (`packages/mc/src/cloud/ssh.ts`):
   - SSH connection manager using `ssh2`:
     - Connect with private key (from safeStorage)
     - Execute commands
     - Open port-forward tunnels
     - Upload files (SFTP)
   - Auto-reconnect with exponential backoff
   - Connection state tracking (connected/connecting/disconnected)
3. SSH keypair generation (`packages/mc/src/security/keygen.ts`):
   - Generate Ed25519 keypair per deployment
   - Store private key in safeStorage
   - Upload public key to DigitalOcean
4. Provisioner (`packages/mc/src/cloud/provisioner.ts`):
   - End-to-end deployment flow (see "Cloud Deployment" section above)
   - Cloud-init script for server hardening
   - TLS certificate setup (certbot) for webhook channels
   - Progress reporting via IPC events
5. Update Deploy Wizard:
   - Enable DigitalOcean target option
   - Add region/size selection step
   - Show webhook channel requirements
   - Show estimated monthly cost
   - Show detailed provisioning progress
6. Update connector (`packages/mc/src/agents/connector.ts`):
   - For cloud: management API calls route through SSH tunnel
   - Tunnel lifecycle management (open on app start, reconnect on drop)
   - Transparent to the renderer — same IPC API as local agents
7. Update Agent management UI:
   - Show deployment target (local vs DO region)
   - Show droplet info (IP, size, cost estimate)
   - SSH tunnel status indicator
   - "Destroy" action (tears down droplet + firewall + SSH key)

**Verification**: User can deploy to DigitalOcean → see it running → view logs → manage it → destroy the droplet. Management API is never publicly exposed.

---

### Phase 5: Security Hardening
**Goal**: Production-grade security for cloud deployments.

**Steps:**
1. mTLS implementation (`packages/mc/src/security/tls.ts`):
   - Generate root CA on first launch (stored in secrets)
   - Issue server certificates per-agent deployment
   - Issue client certificate for Mission Control
   - Certificate rotation (renew before expiry)
2. Update Dash management API:
   - Support TLS configuration (cert + key + CA for client verification)
   - Optional binding to `0.0.0.0` with mTLS (enables direct WebSocket)
3. Droplet hardening (enhance cloud-init):
   - Automated security audit during provisioning
   - Periodic security check from Mission Control
   - OS patch status monitoring
4. Secret rotation:
   - Management API token rotation
   - SSH key rotation
   - Rotation schedule with notifications
5. Audit logging:
   - Log all management operations in Mission Control
   - Stored locally in `~/.mission-control/audit.log`

**Verification**: Cloud agents accessible via mTLS. No unauthorized access paths.

---

### Phase 6: Observability & Polish
**Goal**: Rich monitoring, session inspection, and production-ready UX.

**Steps:**
1. Dashboard page:
   - Overview of all agents (local + cloud) with health status
   - Recent activity feed
   - Quick actions (restart, view logs)
2. Session browser:
   - List sessions per agent (via management API `/sessions`)
   - View full conversation history
   - Search across sessions
3. Agent metrics:
   - Add metrics to Dash (message count, token usage, response times)
   - Expose via management API `/metrics`
   - Simple charts in Mission Control
4. Channel status monitoring:
   - Per-channel connection status and message throughput
5. Notification system:
   - Agent down → desktop notification
   - Channel disconnected → desktop notification
   - Configurable alert thresholds
6. UX polish:
   - Onboarding flow for first-time users
   - Dark/light theme
   - Keyboard shortcuts
   - Error recovery guidance

**Verification**: Full monitoring from dashboard, session inspection, desktop notifications.

---

## Open Questions (To Resolve During Development)

1. **Docker image distribution**: Build locally from source, or pull from container registry? Building locally is simpler for v1 but slow (~2-3 min). Registry pull is faster but requires CI/CD for image publishing. **Recommend**: Build locally for v1, add registry in Phase 4 for cloud (avoid SCP of 200MB images).

2. **Multi-agent on one droplet**: One agent per droplet, or multiple agents as separate containers? **Recommend**: One per droplet for v1 (simplest billing, isolation). Multi-agent per droplet as Phase 6 optimization.

3. **Config hot-reload vs restart**: When user changes config, restart container or reload in-place? **Recommend**: Restart for v1. Add `POST /config/reload` later.

4. **Log persistence**: Store logs locally in Mission Control, or always fetch from agent? **Recommend**: Stream-only for v1. Add local log archival in Phase 6.

5. **Auto-update**: When to implement Electron auto-update? **Recommend**: Phase 6. Requires code signing certificates and an update server or GitHub Releases.

6. **Webhook channel domain**: Use raw droplet IP or a domain? Some IM platforms (WhatsApp) may require HTTPS with a valid domain. **Recommend**: Start with IP + Let's Encrypt. Add custom domain support in Phase 6.

## Dependencies & Prerequisites

| Phase | Depends On | External Dependencies |
|-------|-----------|----------------------|
| Phase 0 | Nothing | None |
| Phase 1 | Phase 0 | None |
| Phase 2a | Phase 1 | commander, keytar |
| Phase 2b | Phase 0 | electron, electron-vite, react, tanstack-router, shadcn/ui, tailwind |
| Phase 3 | Phase 1 + 2a + 2b | dockerode, Docker installed on user machine |
| Phase 4 | Phase 3 | ssh2, DigitalOcean API token, DO account |
| Phase 5 | Phase 4 | node-forge or similar for cert generation |
| Phase 6 | Phase 3+ | None |

Phases 2a and 2b can be developed in parallel. Phase 3 needs both.
