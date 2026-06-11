# Operator

Operator is Devic's open-source sandbox orchestration layer for ephemeral, secure code execution environments.

Two pluggable runtime backends are supported:

- **[microsandbox](https://github.com/nichochar/microsandbox)** — libkrun microVMs with their own kernel. Strongest isolation. Requires `/dev/kvm` on the host (bare metal, dedicated server, or VPS with nested virtualization).
- **Docker** — runs each sandbox as a Docker container. No KVM required. For production use, the host should have [`sysbox-runc`](https://github.com/nestybox/sysbox) installed; the runtime falls back gracefully to plain `runc` if sysbox is unavailable.

The runtime is selected via `runtime.type` in `config.yml` and can be swapped at any time without changing application code, schemas, or API surface.

## Features

- **Sandbox Lifecycle** — Create, stop, destroy lightweight microVMs with configurable TTL
- **Command Execution** — Run commands inside sandboxes with CWD tracking and environment variables
- **File Operations** — Read and write files inside running sandboxes, with upload/download support
- **Snapshots** — Capture sandbox filesystem state as `.tar.gz` archives, restore (linked) or fork (independent)
- **Profiles** — Reusable configuration templates (image, resources, env vars, init scripts, ports)
- **Interactive Terminal** — WebSocket-based terminal with streaming stdout/stderr
- **MCP Server** — Built-in HTTP MCP server exposing sandbox tools for AI agents
- **MCP Profiles** — Scoped access control for MCP sessions
- **TTL Management** — Auto-expiration with configurable TTL, extend-on-demand, and linked snapshot auto-persist
- **Binding System** — Associate sandboxes with external identifiers (threads, sessions)
- **Extension System** — Config-driven multi-tenancy (no code changes needed for Devic integration)

## Quick Start

### Prerequisites

- Node.js >= 24
- MongoDB
- Redis
- Either:
  - [microsandbox](https://github.com/nichochar/microsandbox) runtime, **or**
  - Docker daemon (with `sysbox-runc` installed for production-grade isolation — see [Runtime backends](#runtime-backends))

### 1. Install

```bash
yarn install
cd frontend && yarn install && cd ..
```

### 2. Configure

```bash
cp config.example.yml config.yml
# Edit config.yml with your database URIs
```

### 3. Run (development)

```bash
# Start infrastructure locally (if needed)
docker compose --profile infra up -d

# Start backend
yarn start:dev

# Start frontend (separate terminal)
cd frontend && yarn dev
```

### 4. Run (Docker)

```bash
# Full stack with local infrastructure
docker compose --profile infra up

# Or just app + frontend (external infrastructure)
docker compose up
```

Backend: http://localhost:3200
Frontend: http://localhost:5174
API Docs: http://localhost:3200/api/v1/docs
MCP: http://localhost:3200/api/v1/mcp
Terminal WS: ws://localhost:3200/ws/terminal

## Configuration

All configuration is in `config.yml`. Environment variables are supported via `${VAR:-default}` syntax.

| Section | Description |
|---------|-------------|
| `server` | Port, base path, CORS |
| `database` | MongoDB connection URI |
| `redis` | Redis connection URL |
| `defaults` | Default image, CPUs, memory, TTL — applied to any backend |
| `runtime` | Selects the backend (`microsandbox` or `docker`) and its options |
| `mcp` | MCP server (enabled, path) |
| `extensions` | Dynamic entity scoping (for multi-tenancy) |
| `auth` | API key or JWT authentication |
| `webhooks` | Event-driven HTTP callbacks |
| `resourceLimits` | Module-wide caps for total RAM and snapshot disk usage |

### Sandbox defaults

Applied when a `POST /sandboxes` or `POST /snapshots/:id/restore` request omits the corresponding field. Shared by both runtime backends.

```yaml
defaults:
  defaultImage: node:24
  defaultCpus: 1
  defaultMemoryMib: 256
  defaultTtlSeconds: 1800    # 30 minutes
  maxTtlSeconds: 7200        # 2 hours max
  ttlCheckIntervalMs: 30000  # Check every 30s
```

> The legacy block name `microsandbox:` is still accepted for backwards compatibility — it is read as `defaults:` if `defaults:` is missing.

### Runtime backends

```yaml
runtime:
  type: microsandbox          # microsandbox | docker

  # Only consulted when type=docker
  docker:
    socketPath: /var/run/docker.sock
    runtime: sysbox-runc      # sysbox-runc | runc
    network: bridge           # used when networkPolicy=allow-all
    hardening:
      dropAllCaps: true
      noNewPrivileges: true
      readOnlyRootfs: false   # most workloads (apt, npm install) break with this
      seccompProfile: default
      pidsLimit: 512
```

#### When to pick which

|                              | `microsandbox`                                | `docker` (sysbox-runc)                         | `docker` (runc)                          |
| ---------------------------- | --------------------------------------------- | ---------------------------------------------- | ---------------------------------------- |
| Isolation level              | microVM with dedicated kernel                 | hardened container, virtualised /proc + /sys   | standard container, kernel shared        |
| KVM required                 | **yes**                                       | no                                             | no                                       |
| Snapshots                    | tar archive of the workdir                    | tar archive of the workdir                     | tar archive of the workdir               |
| Memory / CPU caps            | enforced by libkrun                           | cgroup v2 (`--memory`, `--nano-cpus`)          | cgroup v2 (`--memory`, `--nano-cpus`)    |
| Workload compatibility       | 100 % (real Linux)                            | ~99 % (DinD, systemd OK)                       | 100 %                                    |
| Use against untrusted code   | recommended                                   | recommended                                    | only after additional hardening          |

#### Installing `sysbox-runc` on the host

`sysbox-runc` is an OCI-compatible runtime that runs containers under user namespaces with a virtualized `/proc` and `/sys`, blocking the most common container escape vectors. Once installed Docker treats it as a regular runtime; Operator requests it with `runtime.docker.runtime: sysbox-runc`.

```bash
# Ubuntu 22.04+ / Debian 12+
wget https://downloads.nestybox.com/sysbox/releases/v0.6.5/sysbox-ce_0.6.5-0.linux_amd64.deb
sudo apt install ./sysbox-ce_0.6.5-0.linux_amd64.deb

# Verify
docker info | grep -i sysbox-runc
```

If `sysbox-runc` is not present on the host, set `runtime.docker.runtime: runc` instead — the rest of the hardening (cap drop, no-new-privileges, seccomp, pids limit) still applies, but kernel-level isolation drops to standard container boundaries. Do not run untrusted code with `runc` unless additional layers (network policies, AppArmor profiles, dedicated VMs) are in place.

#### Hardening flags

All flags default to safe values when `type=docker`. Override them in `config.yml` only with reason:

| Flag               | Default   | Effect when enabled                                                                  |
| ------------------ | --------- | ------------------------------------------------------------------------------------ |
| `dropAllCaps`      | `true`    | Drops all Linux capabilities (`CAP_DROP=ALL`). Required for sysbox-runc to be safe.  |
| `noNewPrivileges`  | `true`    | Sets `--security-opt=no-new-privileges`. Stops setuid escalation inside the sandbox. |
| `readOnlyRootfs`   | `false`   | `--read-only`. Useful for ephemeral execution; breaks `apt`, `npm install`, `pip install`. Tmpfs mounts for `/tmp` need to be added if enabled. |
| `seccompProfile`   | `default` | Path to a seccomp profile, or `default` to use Docker's default profile.             |
| `pidsLimit`        | `512`     | Maximum number of processes allowed inside the sandbox.                              |


### Resource Limits

Module-wide hard caps that protect a single host from being exhausted by runaway sandbox or snapshot creation. Limits are aggregated **globally** across all tenants/extension scopes — they are a host-level guardrail, not per-customer quotas.

```yaml
resourceLimits:
  # Sum of memoryMib across sandboxes in pending/creating/running/stopping state.
  # New sandboxes (and snapshot restores) are rejected with HTTP 400 when the
  # projected total would exceed this value.
  maxTotalMemoryMib: 8192            # 8 GiB
  # Real on-disk usage of snapshot tarballs (measured via fs.stat, not the DB
  # `sizeBytes` cache). New snapshots are rejected once total usage reaches
  # this value.
  maxTotalDiskBytes: 21474836480     # 20 GiB
```

#### What gets enforced where

| Endpoint | Limit checked | Rejection trigger |
|----------|---------------|-------------------|
| `POST /sandboxes` | `maxTotalMemoryMib` | Active RAM + requested `memoryMib` would exceed the limit |
| `POST /snapshots/:id/restore` | `maxTotalMemoryMib` | Active RAM + requested `memoryMib` (or snapshot default) would exceed the limit |
| `POST /snapshots` | `maxTotalDiskBytes` | Current on-disk snapshot bytes already meet or exceed the limit |

Rejections are surfaced as `HTTP 400 BadRequestException` with a descriptive message (e.g. `RAM limit exceeded: requested 1024 MiB + in-use 7680 MiB would surpass the configured maximum of 8192 MiB`). The check runs **before** any sandbox or snapshot is created, so a 400 means no side effects took place.

#### Disabling a limit

Each field is independent and optional:

- Omit the field entirely, **or** set it to `0` to disable that specific check.
- Omit the whole `resourceLimits` block to disable both.

```yaml
resourceLimits:
  maxTotalMemoryMib: 8192   # RAM ceiling enforced
  # maxTotalDiskBytes:      # disk check disabled
```

#### How each metric is computed

- **RAM (`memory.usedMib`)** — sum of `memoryMib` over `Sandbox` documents whose status is one of `pending`, `creating`, `running`, `stopping`. Treated as a *reservation*: the limit accounts for capacity the runtime could use, not what the sandbox currently allocates from RSS.
- **Disk (`disk.usedBytes`)** — `fs.stat` over each `Snapshot` document in `ready` status, summed live. The DB's `sizeBytes` field is only refreshed on snapshot creation/persist and drifts while linked sandboxes are running, so it is **not** used for limit accounting. Snapshots whose file is missing on disk count as `0` bytes — they don't block new creations even if the document still reports a size.

The frontend Snapshots page exposes both numbers side by side in the table footer (DB-reported total vs. real on-disk total) so the drift is visible.

#### Reading current usage

Live values are exposed via `GET /api/v1/usage` (see [Usage](#usage) below). The frontend polls this endpoint every 10 s and renders a progress bar above both the Sandboxes and Snapshots tables, plus per-row "RAM share" / "Disk share" columns.

## API Reference

### Sandboxes

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/v1/sandboxes` | Create sandbox |
| GET | `/api/v1/sandboxes` | List sandboxes (with status filter) |
| GET | `/api/v1/sandboxes/:id` | Get sandbox |
| GET | `/api/v1/sandboxes/:id/status` | Get status with remaining TTL |
| GET | `/api/v1/sandboxes/by-binding/:bindingId` | Get sandbox by binding ID |
| POST | `/api/v1/sandboxes/:id/command` | Execute command |
| POST | `/api/v1/sandboxes/by-binding/:bindingId/command` | Execute command by binding |
| POST | `/api/v1/sandboxes/:id/stop` | Stop sandbox |
| POST | `/api/v1/sandboxes/:id/extend-ttl` | Extend TTL |
| GET | `/api/v1/sandboxes/:id/files?path=` | Read file |
| POST | `/api/v1/sandboxes/:id/files` | Write file |
| DELETE | `/api/v1/sandboxes/:id` | Destroy sandbox |

### Snapshots

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/v1/snapshots` | Create snapshot from running sandbox |
| GET | `/api/v1/snapshots` | List snapshots (filter by `sandboxId`) |
| GET | `/api/v1/snapshots/:id` | Get snapshot |
| POST | `/api/v1/snapshots/:id/restore` | Restore sandbox from snapshot |
| DELETE | `/api/v1/snapshots/:id` | Delete snapshot |

#### Snapshot Restore Modes

The restore endpoint accepts a `linked` flag:

- **`linked: true`** (default) — Sandbox stays linked to the snapshot. On stop or TTL expiry, changes are automatically persisted back to the snapshot.
- **`linked: false`** — Fully independent sandbox (fork). The snapshot remains unchanged regardless of what happens in the sandbox.

### Sandbox Profiles

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/v1/sandbox-profiles` | Create profile |
| GET | `/api/v1/sandbox-profiles` | List profiles |
| GET | `/api/v1/sandbox-profiles/:id` | Get profile |
| PATCH | `/api/v1/sandbox-profiles/:id` | Update profile |
| DELETE | `/api/v1/sandbox-profiles/:id` | Delete profile |

### MCP Server

The MCP server is available at `POST /api/v1/mcp` (Streamable HTTP).

Tools exposed:
- `create_sandbox` — Create a new sandbox
- `run_command` — Execute a command in a sandbox
- `read_file` — Read file contents from a sandbox
- `write_file` — Write file to a sandbox
- `stop_sandbox` — Stop a running sandbox
- `list_sandboxes` — List all sandboxes

### WebSocket Terminal

Connect to `ws://host/ws/terminal` for interactive terminal sessions.

### Health

| Endpoint | Description |
|----------|-------------|
| GET `/health` | Basic health check |
| GET `/health/ready` | Readiness (DB + Redis) |

### Usage

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/v1/usage` | Aggregated RAM and disk usage with configured limits |

Sample response:

```json
{
  "memory": { "usedMib": 1280, "limitMib": 8192 },
  "disk":   { "usedBytes": 524288000, "limitBytes": 21474836480 }
}
```

`limitMib` / `limitBytes` are `null` when the corresponding limit is disabled in `config.yml` (omitted or set to `0`). `usedMib` is the live reservation sum across active sandboxes; `usedBytes` is the live `fs.stat` total across ready snapshot tarballs (see [Resource Limits](#resource-limits) for details). The endpoint is unauthenticated when `auth.enabled: false`; otherwise it requires the same credentials as the rest of the API.

## Architecture

```
operator/
  src/                          # NestJS backend
    config/                     # YAML config loader with env var resolution
    schemas/                    # Mongoose schemas (Sandbox, SandboxProfile, Snapshot, McpProfile)
    repositories/               # Base repository with extension scoping
    sandboxes/                  # Sandbox CRUD, command execution, TTL service, registry
    snapshots/                  # Snapshot create/restore/persist/delete
    sandbox-profiles/           # Reusable sandbox configuration templates
    mcp/                        # MCP HTTP server
    terminal/                   # WebSocket terminal gateway
    health/                     # Health checks
  frontend/                     # React SPA
    src/
      components/Sandboxes/     # SandboxesPage, TerminalDrawer, FilePreviewDrawer
      components/Snapshots/     # SnapshotsPage
      components/Profiles/      # ProfilesPage, ProfileModal
      components/Mcp/           # McpPage, McpProfileModal
      api/                      # API client + types
      hooks/                    # React Query hooks
```

## Docker Compose

Both backend (`./Dockerfile`) and frontend (`./frontend/Dockerfile`) ship as Docker images. The frontend image is a multi-stage Vite build served by nginx, with `/api` and `/ws` proxied to the `app` service. Infrastructure services use the `infra` profile and are optional:

```bash
# App + frontend only (connect to external Mongo/Redis/runtime)
docker compose up

# Everything local (Mongo, Redis, microsandbox)
docker compose --profile infra up
```

The frontend listens on `${FRONTEND_PORT:-5174}` and proxies API traffic to the `app` container internally.

Connection URIs are configured via environment variables or `config.yml`:
- `DATABASE_URI` — MongoDB
- `REDIS_URL` — Redis

## Devic Integration

To use with the Devic platform, configure extensions in `config.yml`:

```yaml
extensions:
  properties:
    - name: clientUID
      type: string
      required: true
      index: true
      entities: "*"
      source: header
      headerName: x-client-uid
    - name: projectId
      type: string
      required: false
      index: true
      entities: "*"
      source: header
      headerName: x-project-id
```

Devic sends these headers automatically. No code changes needed.

## Roadmap

Planned improvements:

- **External snapshot storage** — Support for pluggable storage backends (S3, GCS, Azure Blob) for snapshot archives. Currently stored on the local filesystem under `~/.devic-sandbox/snapshots/` (legacy `~/.microsandbox/snapshots/` is still read transparently).
- **Snapshot scheduling** — Periodic auto-snapshots for long-running sandboxes.
- **Resource metrics** — Per-sandbox CPU, memory, disk and network usage from the active runtime backend.
- **Additional runtime backends** — gVisor (`runsc`) and Daytona self-hosted are candidates once the abstraction stabilises.

## License

Apache-2.0
