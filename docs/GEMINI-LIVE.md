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
| SIP PBX or SIP provider | 3CX, FreePBX/Asterisk, or any SIP PBX that has an extension for the bot |

You do **not** need ElevenLabs or OpenAI keys in this mode.

## Install

```bash
curl -sSL https://raw.githubusercontent.com/theNetworkChuck/claude-phone/main/install.sh | bash
claude-phone setup     # choose "Gemini Live", then an AI Studio key or Vertex AI
claude-phone start
```

During setup:
- **Voice engine:** choose `Gemini Live`.
- **Google credentials type:** `AI Studio API key`, or `Vertex AI` with your project ID, region and the path to the JSON file. The file is mounted read-only into the container.
- **Model:** default is `gemini-3.8-live`. **Voice:** default is `Kore`.

To edit the configuration by hand, see the `Voice Engine` section in `.env.example`.

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
