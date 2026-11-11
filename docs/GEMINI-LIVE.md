# Gemini Live voice engine (Hebrew)

Instead of Whisper + ElevenLabs, a call can run through **Gemini Live**, which is real-time
speech-to-speech. Gemini handles the conversation: listening, turn-taking, interruptions
(barge-in) and speaking Hebrew. Anything that needs real work on the server goes to
**Claude Code** through the `ask_claude` tool.

```
Phone ──SIP──▶ PBX ──▶ drachtio + FreeSWITCH ──audio 16kHz──▶ voice-app ──WebSocket──▶ Gemini Live
                                     ▲                                 │                    │
                                     └──── audio 24kHz (WAV segments) ─┘    tool: ask_claude ▼
                                                                         claude-api-server ─▶ Claude Code
```

## What you need

| Item | Notes |
|---|---|
| Linux server with Docker | Ubuntu/Debian recommended |
| Claude Code CLI | Installed and signed in on the server where `claude-api-server` runs |
| Google credentials | **One of:** an AI Studio API key (simplest), or Vertex AI (project + service account JSON with the *Vertex AI User* role) |
| PBX | **Built-in:** Asterisk (open source) runs in Docker on the same server, no outside PBX needed. Or use an existing 3CX or SIP PBX |

You do **not** need ElevenLabs or OpenAI keys in this mode.

## Install

```bash
curl -sSL https://raw.githubusercontent.com/theNetworkChuck/claude-phone/main/install.sh | bash
claude-phone setup     # Gemini Live + Google key, then PBX: Built-in Asterisk
claude-phone start
```

During setup:
- **Voice engine:** choose `Gemini Live`.
- **Google credentials type:** `AI Studio API key`, or `Vertex AI` with your project ID, region and the path to the JSON file. The file is mounted read-only into the container.
- **Model:** default is `gemini-3.8-live`. **Voice:** default is `Kore`.

To edit the configuration by hand, see the `Voice Engine` section in `.env.example`.

## Built-in PBX (Asterisk, local, open source)

If you choose `Built-in Asterisk` in setup:
- An `asterisk` container is added that listens on **UDP 5160** with RTP on 10000-10200.
- The bot extension (default 9000) registers with it automatically, with a generated password.
- Two softphone users are created, **1001** and **1002**, with strong generated passwords. Setup
  prints them at the end, and they are saved in `~/.claude-phone/config.json` under
  `sip.localPbx.users`.
- Config files are generated into `~/.claude-phone/asterisk/` on every `claude-phone start`.

### Connecting from your phone
1. Install a free softphone app: **Linphone** (Android/iOS, open source), Zoiper or MicroSIP (Windows).
2. Add a SIP account:
   - Username: `1001`
   - Password: from setup
   - Domain/server: `SERVER_IP:5160`
   - Transport: UDP
3. Dial **9000** and start talking in Hebrew.

### Security (important!)
The phone controls Claude Code, which can run commands on the server.
- The PBX **only accepts private networks** (LAN, `100.64.0.0/10` for Tailscale) and blocks everything else.
- **Do not open/forward port 5160 to the internet.** To call from outside your home, use
  **Tailscale** or **WireGuard** (both open source / free) and connect the softphone through the VPN.
- To change the allowed networks, edit `sip.localPbx.allowedNets` in `config.json` and run `claude-phone start`.

## Settings (.env)

| Variable | Default | Purpose |
|---|---|---|
| `VOICE_ENGINE` | auto | `gemini-live` or `classic` |
| `GEMINI_API_KEY` | – | AI Studio key |
| `GOOGLE_CLOUD_PROJECT` / `GOOGLE_CLOUD_LOCATION` / `GOOGLE_APPLICATION_CREDENTIALS` | – | Vertex AI |
| `GEMINI_LIVE_MODEL` | `gemini-3.8-live` | Live model |
| `GEMINI_VOICE` | `Kore` | Gemini voice |
| `GEMINI_LANGUAGE_CODE` | empty | Forces a speech language code (e.g. `he-IL`), only if the model supports it |
| `GEMINI_SYSTEM_PROMPT` | built-in Hebrew prompt | Override the system prompt |
| `CLAUDE_TOOL_TIMEOUT_SEC` | 180 | How long to wait for Claude Code |
| `GEMINI_MAX_CALL_MINUTES` | 30 | Maximum call length |

The per-device `prompt` in `devices.json` is appended to the system prompt.

## Cost

Gemini 3.8 Live costs about $3 per 1M audio input tokens (about $0.005/min) and $12 per 1M
audio output tokens (about $0.018/min). Check the current prices on Google's pricing page.
Claude Code is billed separately, either through your Claude subscription or through Vertex
if you configured Claude on Vertex.

## Notes and limits

- Hebrew: the language is set through the system prompt. If the model does not hold Hebrew
  reliably, try `GEMINI_LANGUAGE_CODE=he-IL` or a different model or voice.
- Gemini's audio is played back to the call in short WAV segments, so there may be a slight
  gap between segments. When the caller interrupts, playback stops right away (`uuid_break`).
- On Vertex AI, some Live models need allowlisting for your project.
- Outbound calls (`/api/outbound-call`) also use Gemini: it reads the message in Hebrew, then
  either keeps talking (`conversation`) or hangs up (`announce`).
- The `/api/query` endpoint stays on the classic engine.
