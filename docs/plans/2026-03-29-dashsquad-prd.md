# DashSquad — Product Requirements Document

**Version:** 1.0
**Date:** 2026-03-29
**Status:** Draft

---

## 1. Vision

DashSquad lets anyone run a team of AI agents that work autonomously — handling tasks, making decisions, and getting things done — so you don't have to.

The product is a locally-run, privacy-first platform where users deploy AI agents, connect them to messaging apps, and give them tools to act in the real world. Mission Control is the desktop command center for the entire experience.

---

## 2. Current State (v0.1.0)

### What works today

1. **Agent runtime** — PiAgentBackend with tool execution, JSONL session persistence, conversation pooling, and 25-round tool loops
2. **LLM providers** — Anthropic (Claude), OpenAI (GPT), Google (Gemini) via unified streaming interface
3. **13 built-in tools** — file ops (read, write, edit, ls, glob, grep), bash execution, web search/fetch, skill load/create
4. **MCP integration** — connect any Model Context Protocol server as an external tool source
5. **Messaging channels** — Telegram (Grammy), WhatsApp (Baileys), built-in WebSocket chat
6. **Mission Control** — Electron + React desktop app for deploying agents, managing secrets, chatting, and configuring everything
7. **Security** — AES-256-GCM encrypted secrets, workspace sandboxing, bearer token auth, OS keychain integration
8. **Gateway** — single process hosting all agents, management API (:9100), chat WebSocket (:9101)

### Known limitations

1. Single agent backend (no alternative runtimes)
2. No multi-agent coordination or delegation
3. No Slack, Discord, or email channels
4. WhatsApp relies on unofficial Baileys library
5. No analytics, usage tracking, or observability
6. No agent scheduling or cron-based automation
7. Skills v1 is basic — no model overrides, context forking, or dependency resolution
8. No cloud deployment option — local only
9. Mission Control visual redesign not yet shipped
10. No marketplace or community tool/skill sharing

---

## 3. Product Roadmap

### Phase 1 — Foundation Polish (v0.2.0)

**Goal:** Ship a polished, reliable single-agent experience.

#### 1.1 Mission Control Redesign
- Brand refresh: orange (#FF5500) palette, Outfit + JetBrains Mono fonts
- Redesigned sidebar with grouped navigation (Agents, Channels, Settings)
- New dashboard with real agent activity metrics
- Agent detail page with 4-tab layout (Overview, Chat, Sessions, Settings)
- Improved chat UX: streaming indicators, tool execution visualization, content block rendering

#### 1.2 Agent Reliability
- Configurable tool-use round limits (currently hardcoded at 25)
- Graceful error recovery in agent loop — retry transient LLM errors with exponential backoff
- Session export (JSONL → JSON/Markdown) for debugging and sharing
- Agent health checks — auto-restart on crash, surface errors in Mission Control

#### 1.3 Extended Thinking
- Ship extended thinking support end-to-end (config → UI visualization)
- Thinking token budget per agent
- Toggle thinking on/off per conversation

#### 1.4 Documentation & Onboarding
- Rebuild homepage (Next.js static site with waitlist)
- First-run tutorial in Mission Control
- Improve error messages and troubleshooting docs

---

### Phase 2 — Multi-Agent & Channels (v0.3.0)

**Goal:** Enable teams of agents that coordinate, and reach them from more platforms.

#### 2.1 Multi-Agent Coordination
- **Agent delegation** — one agent can spawn tasks for another via a `delegate` tool
- **Shared context** — agents within a team share a read-only context pool (documents, notes, decisions)
- **Orchestration modes:**
  - Sequential: Agent A finishes → Agent B starts
  - Parallel: Multiple agents work simultaneously, results merged
  - Supervisor: One agent coordinates and assigns work to others
- **Conflict resolution** — when two agents produce conflicting outputs, surface the conflict to the user or supervisor agent

#### 2.2 New Channels
- **Slack** — Bot integration via Slack Events API (official, stable)
- **Discord** — Bot integration via Discord.js
- **Email** — IMAP/SMTP adapter for email-based agent interaction
- **SMS** — Twilio adapter for text message access

#### 2.3 Advanced Routing
- Condition-based routing with content matching, regex, and keyword triggers
- Priority queues — urgent messages skip the line
- Fallback chains — if Agent A can't handle it, route to Agent B
- Channel-specific agent personas (different tone on Slack vs. Telegram)

#### 2.4 Skill System v2
- Model override per skill (use a cheaper model for simple skills)
- Context forking — skills run in isolated context branches
- Tool restrictions — limit which tools a skill can use
- Skill dependencies — declare and auto-load prerequisite skills
- Skill versioning and rollback

---

### Phase 3 — Automation & Intelligence (v0.4.0)

**Goal:** Agents that act proactively, not just reactively.

#### 3.1 Scheduled Tasks
- Cron-based agent triggers (e.g., "summarize my email every morning at 8am")
- Event-driven triggers (e.g., "when a new file appears in this folder, process it")
- Webhook triggers — external services can kick off agent tasks via HTTP
- Task queue with retry logic and dead-letter handling

#### 3.2 Agent Memory
- Long-term memory store per agent (vector DB or structured knowledge base)
- Automatic memory extraction from conversations (key facts, preferences, decisions)
- Cross-conversation recall — agents remember context from previous interactions
- Memory management UI in Mission Control (view, edit, delete memories)

#### 3.3 Observability
- Real-time dashboard: active conversations, tool calls/min, token usage, error rates
- Per-agent analytics: response times, success rates, most-used tools
- Cost tracking: token usage by provider, estimated spend per agent per day
- Exportable logs for external monitoring (structured JSON, OpenTelemetry-compatible)

#### 3.4 Model Chains
- Sequential model pipelines: fast model drafts → capable model refines
- Router model: cheap classifier picks which model handles each message
- Consensus mode: multiple models answer, best response selected
- Configurable via Mission Control UI (ModelChainEditor already scaffolded)

---

### Phase 4 — Platform & Ecosystem (v0.5.0)

**Goal:** Make DashSquad extensible and shareable.

#### 4.1 Tool & Skill Marketplace
- Community-contributed tools and skills
- One-click install from Mission Control
- Publishing workflow: package, validate, submit
- Rating and review system
- Curated "starter packs" for common use cases (customer support, research, DevOps)

#### 4.2 Agent Templates
- Pre-built agent configurations for common roles:
  - Research assistant
  - Customer support agent
  - Code reviewer
  - Content writer
  - Data analyst
- Import/export agent configs as shareable JSON

#### 4.3 API & SDK
- REST API for programmatic agent management (beyond internal management API)
- JavaScript/TypeScript SDK for embedding DashSquad agents in external applications
- Webhook subscriptions for agent events (message received, task completed, error)
- OAuth2 for third-party integrations

#### 4.4 Optional Cloud Deployment
- Docker container packaging for self-hosted cloud deployment
- Gateway as a standalone server (no Electron dependency)
- Multi-user support with role-based access control
- Shared agent teams across users

---

### Phase 5 — Enterprise & Scale (v1.0.0)

**Goal:** Production-ready for teams and businesses.

#### 5.1 Multi-User
- User accounts and authentication
- Role-based access: admin, operator, viewer
- Per-user agent permissions and quotas
- Audit log for all agent actions

#### 5.2 Compliance & Security
- SOC 2 readiness (audit logs, access controls, encryption at rest and in transit)
- Data retention policies (auto-delete sessions after N days)
- PII detection and redaction in agent conversations
- Configurable content filters and safety guardrails per agent

#### 5.3 Performance & Scale
- Horizontal scaling: multiple gateway instances behind a load balancer
- Connection pooling for LLM providers
- Rate limiting per agent, per user, per provider
- Queue-based architecture for high-throughput workloads

#### 5.4 Enterprise Integrations
- SSO (SAML, OIDC)
- LDAP/Active Directory for user management
- Jira, Linear, Asana integration for task-driven agents
- Salesforce, HubSpot integration for CRM agents
- Custom LLM endpoints (Azure OpenAI, AWS Bedrock, self-hosted models)

---

## 4. Technical Strategy

### Architecture Evolution

| Phase | Architecture |
|-------|-------------|
| v0.1–0.2 | Monolith gateway, single-process, local only |
| v0.3–0.4 | Modular gateway with plugin system, optional multi-process agents |
| v0.5+ | Distributed gateway, containerized, multi-node capable |

### Key Technical Decisions

1. **Keep local-first as the default** — cloud is optional, never required
2. **Streaming-first** — all agent communication uses async generators and WebSocket streaming; never batch-only
3. **MCP as the extension point** — external tools connect via MCP, not custom plugin APIs
4. **JSONL sessions as source of truth** — append-only, replayable, exportable
5. **No vendor lock-in** — provider abstraction stays clean; switching LLMs is a config change

### Testing Strategy

1. Unit tests for all packages (vitest, no SDK mocking)
2. Integration tests for gateway (agent + tools + channels end-to-end)
3. E2E tests for Mission Control (Playwright)
4. Load tests for gateway under concurrent conversations
5. Security testing: workspace sandbox escapes, injection attacks, credential handling

---

## 5. Success Metrics

| Metric | v0.2 Target | v0.5 Target | v1.0 Target |
|--------|-------------|-------------|-------------|
| Supported LLM providers | 3 | 5+ | 10+ |
| Built-in tools | 13 | 20+ | 30+ |
| Messaging channels | 3 | 6+ | 8+ |
| Max concurrent agents | 5 | 20+ | 100+ |
| Mission Control startup time | < 5s | < 3s | < 2s |
| Agent response latency (p95) | < 10s | < 5s | < 3s |
| Community tools/skills | 0 | 50+ | 200+ |
| Active users (if cloud) | N/A | Beta | GA |

---

## 6. Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| WhatsApp Baileys breaks | Channel goes down | Prioritize official API when available; maintain Baileys fork |
| LLM provider API changes | Agent failures | Provider abstraction layer; version-pinned SDK deps; integration tests |
| Scope creep in multi-agent | Delayed delivery | Ship delegation first, orchestration modes incrementally |
| Security vulnerability in tool sandbox | Data exposure | Regular security audits; strict path validation; consider containerized execution |
| Community marketplace abuse | Malicious tools | Code review process; sandboxed execution; reputation system |
| Electron app size/performance | Poor UX | Lazy loading; minimize bundle; consider Tauri for v2 |

---

## 7. Non-Goals

1. **Not a hosted SaaS** (at least not until v0.5+) — local-first is the identity
2. **Not a no-code builder** — users should understand what their agents do
3. **Not a general-purpose automation tool** — agents are conversational AI, not Zapier
4. **No mobile app** — desktop-first; mobile access via messaging channels
5. **No fine-tuning or model training** — use off-the-shelf models via API

---

## 8. Priority Summary

| Priority | Item | Phase |
|----------|------|-------|
| P0 | Mission Control redesign | v0.2 |
| P0 | Agent reliability & error recovery | v0.2 |
| P0 | Extended thinking end-to-end | v0.2 |
| P1 | Multi-agent delegation | v0.3 |
| P1 | Slack + Discord channels | v0.3 |
| P1 | Skill system v2 | v0.3 |
| P1 | Scheduled tasks | v0.4 |
| P1 | Agent memory | v0.4 |
| P2 | Observability dashboard | v0.4 |
| P2 | Model chains | v0.4 |
| P2 | Tool marketplace | v0.5 |
| P2 | API/SDK for embedding | v0.5 |
| P3 | Cloud deployment | v0.5 |
| P3 | Multi-user & RBAC | v1.0 |
| P3 | Enterprise integrations | v1.0 |
