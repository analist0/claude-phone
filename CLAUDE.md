# Claude Phone

Voice interface for Claude Code via SIP/3CX. Call your AI, and your AI can call you.

## Project Overview

Claude Phone gives your Claude Code installation a phone number through 3CX PBX integration:
- **Inbound**: Call an extension and talk to Claude - run commands, check status, ask questions
- **Outbound**: Your server can call YOU with alerts, then have a conversation about what to do

## Tech Stack

| Component | Technology |
|-----------|------------|
| Language | Node.js (ES modules for CLI, CommonJS for voice-app and claude-api-server) |
| SIP Server | drachtio-srf |
| Media Server | FreeSWITCH (via drachtio-fsmrf) |
| STT | OpenAI Whisper API |
| TTS | ElevenLabs API |
| AI Backend | Claude Code CLI (via HTTP wrapper) |
| PBX | 3CX (any SIP-compatible works) |
| Container | Docker Compose |
| CLI Framework | commander + inquirer + chalk + ora |

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Phone Call                                                  │
│      │                                                       │
│      ↓ Call extension (e.g. 9000)                           │
│  ┌─────────────┐                                            │
│  │     3CX     │  ← PBX routes the call                    │
│  └──────┬──────┘                                            │
│         │ SIP                                               │
│         ↓                                                    │
│  ┌─────────────────────────────────────────────────┐       │
│  │           voice-app (Docker)                     │       │
│  │  ┌─────────────────────────────────────────┐   │       │
│  │  │ drachtio  │  FreeSWITCH  │  Node.js     │   │       │
│  │  │ (SIP)     │  (Media)     │  (Logic)     │   │       │
│  │  └─────────────────────────────────────────┘   │       │
│  └────────────────────┬────────────────────────────┘       │
│                       │ HTTP                                │
│                       ↓                                      │
│  ┌─────────────────────────────────────────────────┐       │
│  │   claude-api-server                              │       │
│  │   Wraps Claude Code CLI with session management │       │
│  └─────────────────────────────────────────────────┘       │
└─────────────────────────────────────────────────────────────┘
```

## Directory Structure

```
claude-phone/
├── CLAUDE.md                 # This file
├── README.md                 # User-facing documentation
├── install.sh                # One-command installer
├── start.sh                  # Quick-start script (auto-detects LAN IP)
├── package.json              # Root package (hooks, linting, tests)
├── eslint.config.js          # ESLint flat config (CLI=ESM, voice-app/api=CJS)
├── docker-compose.yml        # Multi-container orchestration (host networking)
├── docker-compose.bridge.yml # Bridge networking override for Mac Docker Desktop
├── .env.example              # Environment template
├── .husky/
│   └── pre-commit            # Runs npm run precommit (lint check)
│
├── assets/                   # Static assets
│   └── logo*.png             # Claude Phone logo variants
│
├── cli/                      # Unified CLI tool (ES Modules)
│   ├── package.json          # "type": "module", deps: commander, inquirer, chalk, ora, axios
│   ├── README.md
│   ├── bin/
│   │   ├── claude-phone.js   # CLI entry point (#!/usr/bin/env node)
│   │   └── cli-main.js       # Command registration with commander
│   ├── lib/
│   │   ├── commands/         # Command implementations
│   │   │   ├── setup.js      # Interactive setup wizard
│   │   │   ├── start.js      # Start services
│   │   │   ├── stop.js       # Stop services
│   │   │   ├── status.js     # Service status
│   │   │   ├── doctor.js     # Health checks
│   │   │   ├── api-server.js # Start API server standalone
│   │   │   ├── logs.js       # Tail service logs
│   │   │   ├── backup.js     # Create backups
│   │   │   ├── restore.js    # Restore backups
│   │   │   ├── update.js     # Self-update
│   │   │   ├── uninstall.js  # Clean removal
│   │   │   ├── config/       # Config subcommands
│   │   │   │   ├── show.js
│   │   │   │   ├── path.js
│   │   │   │   └── reset.js
│   │   │   └── device/       # Device subcommands
│   │   │       ├── add.js
│   │   │       ├── list.js
│   │   │       └── remove.js
│   │   ├── config.js         # Config read/write (~/.claude-phone)
│   │   ├── docker.js         # Docker compose wrapper
│   │   ├── network.js        # Network utilities
│   │   ├── platform.js       # Platform detection (mac/linux/pi)
│   │   ├── port-check.js     # Port availability checks
│   │   ├── prereqs.js        # Prerequisite orchestration
│   │   ├── prerequisites.js  # Pi-specific prereqs
│   │   ├── prereqs/          # Modular prereqs system
│   │   │   ├── platform.js   # Platform-specific prereq logic
│   │   │   ├── checks/       # Individual check modules
│   │   │   │   ├── compose.js, disk.js, docker.js, network.js, node.js
│   │   │   ├── installers/   # Auto-install logic per platform
│   │   │   │   ├── docker.js, docker-desktop.js, node.js
│   │   │   └── utils/        # Shared helpers
│   │   │       ├── execute.js, rollback.js, sudo.js
│   │   ├── process-manager.js# PID-based process management
│   │   ├── utils.js          # Shared utilities
│   │   └── validators.js     # API key validation
│   └── test/                 # Test suite (Node built-in test runner)
│       ├── api-server.test.js
│       ├── config.test.js
│       ├── device.test.js
│       ├── docker.test.js
│       ├── doctor.test.js
│       ├── network.test.js
│       ├── path-resolution.test.js
│       ├── platform.test.js
│       ├── port-check.test.js
│       ├── prerequisites.test.js
│       ├── process-manager.test.js
│       └── validators.test.js
│
├── voice-app/                # Docker container for voice handling (CommonJS)
│   ├── Dockerfile
│   ├── package.json          # deps: drachtio-srf, drachtio-fsmrf, express, openai, ws, uuid, wavefile
│   ├── index.js              # Main entry point (v9 Multi-Extension + Query API)
│   ├── config/
│   │   └── devices.json      # Device configurations (gitignored - create manually)
│   ├── lib/
│   │   ├── audio-fork.js     # WebSocket audio streaming from FreeSWITCH
│   │   ├── claude-bridge.js  # HTTP client for Claude API server
│   │   ├── connection-retry.js # Retry logic for drachtio/FreeSWITCH startup
│   │   ├── conversation-loop.js  # Core STT→Claude→TTS conversation flow
│   │   ├── device-registry.js    # Multi-device management singleton
│   │   ├── http-server.js    # Express server for audio files and API
│   │   ├── logger.js         # Logging utility
│   │   ├── multi-registrar.js    # Multi-extension SIP registration
│   │   ├── outbound-handler.js   # Outbound call logic
│   │   ├── outbound-routes.js    # Outbound API endpoints (/api/outbound-call)
│   │   ├── outbound-session.js   # Outbound call sessions
│   │   ├── query-routes.js   # Query API endpoints (/api/query)
│   │   ├── registrar.js      # Single SIP registration
│   │   ├── sip-handler.js    # Inbound call handling (INVITE)
│   │   ├── tts-service.js    # ElevenLabs TTS integration
│   │   └── whisper-client.js # OpenAI Whisper STT integration
│   ├── test/
│   │   └── freeswitch-retry.test.js
│   ├── DEPLOYMENT.md         # Production deployment guide
│   ├── README-OUTBOUND.md    # Outbound calling API docs
│   └── API-QUERY-CONTRACT.md # Query API specification
│
├── claude-api-server/        # HTTP wrapper for Claude CLI (CommonJS, Node >=20)
│   ├── package.json          # deps: express only
│   ├── server.js             # Express server with session management
│   └── structured.js         # JSON validation helpers for /ask-structured
│
├── docs/
│   ├── TROUBLESHOOTING.md    # Common issues guide
│   └── CLAUDE-CODE-SKILL.md  # Claude Code skill example for outbound calling
│
└── src/features/             # Feature specs (planning docs)
    ├── installation-type-selector/
    ├── pi-deployment/
    ├── prerequisite-checks/
    ├── sbc-simplified-installer/
    └── unified-installer/
```

## CLI Commands

```bash
# One-line install
curl -sSL https://raw.githubusercontent.com/theNetworkChuck/claude-phone/main/install.sh | bash

# Setup and run
claude-phone setup           # Interactive configuration wizard
claude-phone start           # Launch Docker services + API server
claude-phone stop            # Stop all services
claude-phone status          # Show service status
claude-phone doctor          # Run health checks on all dependencies

# API server (standalone, for the Mac/PC hosting Claude Code)
claude-phone api-server      # Start on default port 3333
claude-phone api-server -p 4000  # Start on custom port

# Device management (for multi-extension setup)
claude-phone device add      # Add a new SIP extension/device
claude-phone device list     # List configured devices
claude-phone device remove   # Remove a device

# Config management
claude-phone config show     # Display current config
claude-phone config path     # Show config file path
claude-phone config reset    # Reset config to defaults

# Maintenance
claude-phone logs            # Tail Docker service logs
claude-phone backup          # Create backup of config/devices
claude-phone restore         # Restore from backup
claude-phone update          # Self-update CLI
claude-phone uninstall       # Clean removal
```

## Development

### Node.js Module System Convention

**Critical**: Different parts of the codebase use different module systems:

| Directory | Module System | Reason |
|-----------|--------------|--------|
| `cli/` | ES Modules (`import`/`export`) | Modern Node.js tooling |
| `voice-app/` | CommonJS (`require`/`module.exports`) | drachtio ecosystem compatibility |
| `claude-api-server/` | CommonJS (`require`/`module.exports`) | Simplicity, runs standalone |

Do **not** mix module systems within a directory. The `eslint.config.js` enforces this.

### Running Tests

```bash
npm test              # All tests (CLI + voice-app)
npm run test:cli      # CLI tests only (Node built-in test runner)
npm run test:voice-app # Voice-app tests (freeswitch-retry)
```

### Linting

```bash
npm run lint          # Check all files for issues
npm run lint:fix      # Auto-fix issues
npm run lint:voice-app   # Lint voice-app only
npm run lint:api-server  # Lint claude-api-server only
```

The pre-commit hook (`husky`) automatically runs `npm run lint` before each commit.

### Quick Start (Development / No CLI)

```bash
# Auto-detects LAN IP and starts Docker services
./start.sh

# For Mac Docker Desktop (bridge networking mode)
docker compose -f docker-compose.yml -f docker-compose.bridge.yml up -d
```

## API Endpoints

### Voice App (port 3000)

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/api/outbound-call` | Initiate outbound call to a device |
| GET | `/api/call/:callId` | Get status of an active call |
| GET | `/api/calls` | List all active calls |
| POST | `/api/query` | Query a device programmatically (no actual call) |
| GET | `/api/devices` | List configured devices |

### Claude API Server (port 3333)

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/ask` | Send voice prompt to Claude (returns VOICE_RESPONSE + COMPLETED) |
| POST | `/ask-structured` | Send prompt, return validated JSON (for n8n automations) |
| POST | `/end-session` | Clean up Claude session when call ends |
| GET | `/health` | Health check |
| GET | `/` | Service info and endpoint listing |

#### `/ask` Request/Response

```json
// Request
{ "prompt": "What Docker containers are running?", "callId": "uuid", "devicePrompt": "optional" }

// Response
{ "success": true, "response": "...", "sessionId": "...", "duration_ms": 1234 }
```

The server prepends `VOICE_CONTEXT` to all prompts, instructing Claude to format responses with:
- `VOICE_RESPONSE:` — spoken aloud via TTS (≤40 words)
- `COMPLETED:` — status log entry (≤12 words)

#### `/ask-structured` Request/Response

```json
// Request
{
  "prompt": "Check Ceph health",
  "callId": "uuid",
  "schema": {
    "queryType": "ceph_health",
    "requiredFields": ["cluster_status", "recommendation"],
    "allowExtraFields": true
  },
  "maxRetries": 1
}

// Response (success)
{ "success": true, "data": {...}, "raw_response": "...", "duration_ms": 1234, "attempts": 1 }
```

## Key Design Decisions

1. **CommonJS for voice-app** — drachtio-srf/drachtio-fsmrf require CommonJS
2. **ES Modules for CLI** — modern Node.js tooling (inquirer v9+, chalk v5+, ora v8+)
3. **Host networking mode** — required for FreeSWITCH RTP; Docker bridge breaks SDP IP negotiation
4. **`docker-compose.bridge.yml` override** — enables Mac Docker Desktop development at the cost of RTP reliability
5. **Separate claude-api-server** — runs on the machine with Claude Code CLI installed (not in Docker)
6. **Session-per-call** — each call gets a Claude session (`--session-id` / `--resume`) for multi-turn context
7. **RTP ports 30000-30100** — avoids conflict with 3CX SBC default range (20000-20099)
8. **Config in `~/.claude-phone`** — user config separate from codebase (not in `.env` for CLI-managed installs)
9. **`ANTHROPIC_API_KEY` must NOT be set** — Claude CLI uses subscription auth; if the key is set (even as placeholder), it switches to API auth and may fail
10. **Prompt layering** — device identity prompt → voice context → user query; allows per-device personalities
11. **`devices.json` is gitignored** — device configs contain SIP credentials; create from template per-deployment

## Environment Variables

Full reference (see `.env.example` for template):

| Variable | Default | Purpose |
|----------|---------|---------|
| `EXTERNAL_IP` | `10.0.0.100` | Server LAN IP for RTP audio routing (critical!) |
| `DRACHTIO_HOST` | `127.0.0.1` | Drachtio server host |
| `DRACHTIO_PORT` | `9022` | Drachtio admin port |
| `DRACHTIO_SECRET` | `cymru` | Drachtio auth secret |
| `DRACHTIO_SIP_PORT` | `5060` | SIP port in Contact header (5070 for 3CX SBC mode) |
| `FREESWITCH_HOST` | `127.0.0.1` | FreeSWITCH ESL host |
| `FREESWITCH_PORT` | `8021` | FreeSWITCH ESL port |
| `FREESWITCH_SECRET` | `JambonzR0ck$` | FreeSWITCH ESL secret |
| `SIP_DOMAIN` | — | 3CX server FQDN |
| `SIP_REGISTRAR` | — | SIP registrar LAN IP |
| `SIP_REGISTRAR_PORT` | `5060` | SIP registrar port |
| `SIP_EXTENSION` | `9000` | Default SIP extension |
| `SIP_AUTH_ID` | — | SIP authentication ID |
| `SIP_PASSWORD` | — | SIP authentication password |
| `DEFAULT_CALLER_ID` | — | Caller ID for outbound PSTN calls |
| `CLAUDE_API_URL` | — | URL to claude-api-server (e.g. `http://10.0.0.200:3333`) |
| `CLAUDE_MODEL` | `claude-sonnet-4-20250514` | Claude model for API server |
| `ELEVENLABS_API_KEY` | — | ElevenLabs TTS API key |
| `ELEVENLABS_VOICE_ID` | — | Default ElevenLabs voice ID |
| `OPENAI_API_KEY` | — | OpenAI Whisper STT API key |
| `HTTP_PORT` | `3000` | Voice app HTTP API port |
| `WS_PORT` | `3001` | WebSocket port for audio streaming |
| `AUDIO_DIR` | `/app/audio` | TTS audio file storage |
| `MAX_CONVERSATION_TURNS` | `10` | Max turns for outbound call conversations |
| `OUTBOUND_RING_TIMEOUT` | `30` | Ring timeout in seconds |

## Session Management (claude-api-server)

The API server maintains a `sessions` Map from `callId` → Claude `session_id`:

1. First `/ask` with a `callId` → spawns Claude with `--session-id <callId>`
2. Subsequent `/ask` with the same `callId` → uses `--resume <sessionId>`
3. `/end-session` → deletes the session entry

The Claude CLI is invoked with `--dangerously-skip-permissions` for unattended operation.

## Voice Conversation Flow (Inbound)

```
SIP INVITE
  → drachtio (sip-handler.js) answers call
  → FreeSWITCH media session created
  → AudioForkServer captures audio via WebSocket
  → audio-fork.js collects audio frames
  → whisper-client.js sends WAV to OpenAI Whisper
  → transcript sent to claude-bridge.js → POST /ask
  → claude-api-server runs Claude CLI
  → VOICE_RESPONSE extracted from Claude output
  → tts-service.js calls ElevenLabs API → MP3
  → MP3 served via HTTP, played to caller
  → repeat for each turn
```

## Documentation

- [README.md](README.md) — User quickstart and installation
- [cli/README.md](cli/README.md) — Full CLI reference
- [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) — Common issues and fixes
- [docs/CLAUDE-CODE-SKILL.md](docs/CLAUDE-CODE-SKILL.md) — Claude Code skill example (outbound calling)
- [voice-app/DEPLOYMENT.md](voice-app/DEPLOYMENT.md) — Production deployment guide
- [voice-app/README-OUTBOUND.md](voice-app/README-OUTBOUND.md) — Outbound calling API reference
- [voice-app/API-QUERY-CONTRACT.md](voice-app/API-QUERY-CONTRACT.md) — Query API specification
