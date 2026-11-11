/**
 * Gemini Live conversation loop
 *
 * Phone call  <->  FreeSWITCH (audio fork, 16kHz)  <->  Gemini Live (speech-to-speech)
 *                                                         |
 *                                                         +-- tool: ask_claude -> claude-api-server -> Claude Code
 *
 * Gemini handles listening, turn-taking, barge-in and speaking (Hebrew by default).
 * Anything that needs real work on the server is delegated to Claude Code.
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { GeminiLiveClient } = require('./gemini-live-client');
const logger = require('./logger');

const OUTPUT_SAMPLE_RATE = 24000; // Gemini Live output
const BYTES_PER_SEC = OUTPUT_SAMPLE_RATE * 2;
const FIRST_SEGMENT_BYTES = Math.floor(BYTES_PER_SEC * 0.4); // start talking fast
const NEXT_SEGMENT_BYTES = Math.floor(BYTES_PER_SEC * 2.0); // fewer gaps afterwards

const DEFAULT_SYSTEM_PROMPT_HE = [
  'אתה עוזר קולי בשיחת טלפון. דבר תמיד בעברית טבעית, קצרה וברורה, אלא אם המתקשר מבקש שפה אחרת.',
  'אל תקריא קוד, טבלאות, נתיבי קבצים ארוכים או סימנים מיוחדים - סכם במשפט או שניים.',
  'יש לך גישה ל-Claude Code שרץ על השרת של המשתמש דרך הכלי ask_claude.',
  'השתמש בו לכל בקשה שדורשת פעולה אמיתית: להריץ פקודות, לבדוק סטטוס של שרתים או שירותים, לקרוא או לערוך קבצים, לחפש מידע, או כל שאלה שאינך בטוח בתשובה עליה.',
  'לפני שאתה קורא לכלי, אמור למתקשר משפט קצר כמו "רגע, אני בודק". כתוב את הבקשה ל-Claude באנגלית או בעברית, מפורטת וברורה.',
  'אחרי שהכלי מחזיר תשובה, סכם אותה בעברית בקצרה.',
  'כשהמתקשר נפרד (ביי, להתראות, זהו, תודה זה הכל) - אמור שלום קצר ואז קרא לכלי end_call.'
].join('\n');

const TOOLS = [
  {
    name: 'ask_claude',
    description: 'Send a task or question to Claude Code running on the user\'s server. ' +
      'Claude can run shell commands, read/edit files, check services and search. ' +
      'Returns Claude\'s answer as text. Can take up to a couple of minutes.',
    parameters: {
      type: 'OBJECT',
      properties: {
        request: {
          type: 'STRING',
          description: 'Full, self-contained description of what Claude should do or answer.'
        }
      },
      required: ['request']
    }
  },
  {
    name: 'end_call',
    description: 'Hang up the phone call after saying goodbye.',
    parameters: { type: 'OBJECT', properties: {} }
  }
];

/**
 * Build a 44-byte WAV header + PCM16 mono data
 */
function pcmToWav(pcm, sampleRate = OUTPUT_SAMPLE_RATE) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/**
 * Turns streamed PCM chunks into short WAV segments and plays them in order.
 * Supports instant flush on barge-in.
 */
class SegmentPlayer {
  constructor({ endpoint, audioDir, baseUrl, isActive }) {
    this.endpoint = endpoint;
    this.audioDir = audioDir;
    this.baseUrl = baseUrl;
    this.isActive = isActive;
    this.pending = [];
    this.pendingBytes = 0;
    this.queue = [];
    this.playing = false;
    this.firstInTurn = true;
    this.generation = 0;
    this._idleWaiters = [];
  }

  push(pcm) {
    this.pending.push(pcm);
    this.pendingBytes += pcm.length;
    const threshold = this.firstInTurn ? FIRST_SEGMENT_BYTES : NEXT_SEGMENT_BYTES;
    if (this.pendingBytes >= threshold) this.flush();
  }

  /** Emit whatever is buffered as a segment (end of turn) */
  flush() {
    if (!this.pendingBytes) return;
    const pcm = Buffer.concat(this.pending);
    this.pending = [];
    this.pendingBytes = 0;
    this.firstInTurn = false;
    this.queue.push({ pcm, generation: this.generation });
    this._drain();
  }

  endTurn() {
    this.flush();
    this.firstInTurn = true;
  }

  /** Caller interrupted: drop everything and stop current playback */
  async interrupt() {
    this.generation++;
    this.pending = [];
    this.pendingBytes = 0;
    this.queue = [];
    this.firstInTurn = true;
    if (this.playing && this.isActive()) {
      try {
        await this.endpoint.api('uuid_break', this.endpoint.uuid + ' all');
      } catch (err) {
        logger.warn('uuid_break failed', { error: err.message });
      }
    }
  }

  waitIdle(timeoutMs = 15000) {
    if (!this.playing && !this.queue.length && !this.pendingBytes) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      this._idleWaiters.push(() => { clearTimeout(timer); resolve(); });
    });
  }

  async _drain() {
    if (this.playing) return;
    this.playing = true;
    try {
      while (this.queue.length && this.isActive()) {
        const seg = this.queue.shift();
        if (seg.generation !== this.generation) continue;
        const name = 'gemini_' + Date.now() + '_' + crypto.randomBytes(6).toString('hex') + '.wav';
        await fs.writeFile(path.join(this.audioDir, name), pcmToWav(seg.pcm));
        if (seg.generation !== this.generation || !this.isActive()) continue;
        try {
          await this.endpoint.play(this.baseUrl + '/' + name);
        } catch (err) {
          logger.warn('Segment playback failed', { error: err.message });
        }
        fs.unlink(path.join(this.audioDir, name)).catch(() => {});
      }
    } finally {
      this.playing = false;
      if (!this.queue.length && !this.pendingBytes) {
        const waiters = this._idleWaiters.splice(0);
        waiters.forEach((w) => w());
      }
    }
  }
}

/**
 * Run a full phone conversation through Gemini Live.
 *
 * @param {Object} endpoint - FreeSWITCH endpoint
 * @param {Object} dialog - SIP dialog
 * @param {string} callUuid
 * @param {Object} options
 * @param {Object} options.audioForkServer
 * @param {Object} options.claudeBridge
 * @param {number} options.wsPort
 * @param {Object} [options.deviceConfig] - device personality (prompt, geminiVoice)
 * @param {string} [options.initialContext] - outbound: the message to deliver
 * @param {boolean} [options.skipGreeting]
 */
async function runGeminiConversation(endpoint, dialog, callUuid, options) {
  const {
    audioForkServer,
    claudeBridge,
    wsPort,
    deviceConfig = null,
    initialContext = null,
    announceOnly = false,
    skipGreeting = false
  } = options;

  const env = process.env;
  const audioDir = options.audioDir || env.AUDIO_DIR || '/tmp/voice-audio';
  const httpPort = options.httpPort || parseInt(env.HTTP_PORT, 10) || 3000;
  const maxCallMs = (parseInt(env.GEMINI_MAX_CALL_MINUTES, 10) || 30) * 60 * 1000;
  const claudeTimeoutSec = parseInt(env.CLAUDE_TOOL_TIMEOUT_SEC, 10) || 180;

  let callActive = true;
  let forkRunning = false;
  let gemini = null;
  let finish;
  const finished = new Promise((resolve) => { finish = resolve; });

  const onDestroy = () => {
    callActive = false;
    finish('hangup');
  };
  dialog.on('destroy', onDestroy);

  const systemInstruction = [
    env.GEMINI_SYSTEM_PROMPT || DEFAULT_SYSTEM_PROMPT_HE,
    deviceConfig && deviceConfig.prompt ? '\nאישיות/הנחיות נוספות:\n' + deviceConfig.prompt : ''
  ].join('');

  await fs.mkdir(audioDir, { recursive: true }).catch(() => {});

  const player = new SegmentPlayer({
    endpoint,
    audioDir,
    baseUrl: 'http://127.0.0.1:' + httpPort + '/audio-files',
    isActive: () => callActive
  });

  const maxTimer = setTimeout(() => finish('max_duration'), maxCallMs);

  try {
    const ClientImpl = options.GeminiClientImpl || GeminiLiveClient;
    gemini = new ClientImpl({
      systemInstruction,
      tools: TOOLS,
      voiceName: deviceConfig && deviceConfig.geminiVoice
    });

    gemini.on('audio', (pcm) => { if (callActive) player.push(pcm); });
    gemini.on('turnComplete', () => player.endTurn());
    gemini.on('interrupted', () => {
      logger.info('Caller barge-in', { callUuid });
      player.interrupt();
    });
    gemini.on('inputTranscript', (t) => logger.info('Caller said', { callUuid, text: t }));
    gemini.on('outputTranscript', (t) => logger.info('Gemini said', { callUuid, text: t }));
    gemini.on('close', (info) => {
      logger.info('Gemini session closed', { callUuid, code: info.code, reason: info.reason });
      finish('gemini_closed');
    });
    gemini.on('error', (err) => logger.warn('Gemini error', { callUuid, error: err.message }));
    gemini.on('goAway', () => logger.warn('Gemini goAway received', { callUuid }));

    gemini.on('toolCall', async (calls) => {
      for (const call of calls) {
        if (call.name === 'end_call') {
          gemini.sendToolResponse([{ id: call.id, name: call.name, response: { result: 'ok' } }]);
          // Let the goodbye finish playing
          setTimeout(async () => {
            await player.waitIdle();
            finish('end_call');
          }, 800);
          continue;
        }

        if (call.name === 'ask_claude') {
          const request = (call.args && call.args.request) || '';
          logger.info('Gemini -> Claude', { callUuid, request });
          let result;
          try {
            result = await claudeBridge.query(
              request + '\n\n(This request came from a phone call. Keep the answer concise and speakable.)',
              { callId: callUuid, timeout: claudeTimeoutSec }
            );
          } catch (err) {
            result = 'Error contacting Claude: ' + err.message;
          }
          logger.info('Claude -> Gemini', { callUuid, chars: String(result).length });
          if (callActive) {
            gemini.sendToolResponse([{ id: call.id, name: call.name, response: { result: String(result) } }]);
          }
          continue;
        }

        gemini.sendToolResponse([{ id: call.id, name: call.name, response: { error: 'unknown tool' } }]);
      }
    });

    await gemini.connect();
    logger.info('Gemini Live connected', { callUuid, backend: gemini.backend });

    if (!callActive) return;

    // Stream caller audio to Gemini
    const wsUrl = 'ws://127.0.0.1:' + wsPort + '/' + encodeURIComponent(callUuid);
    const sessionPromise = audioForkServer.expectSession(callUuid, { timeoutMs: 10000 });
    await endpoint.forkAudioStart({ wsUrl, mixType: 'mono', sampling: '16k' });
    forkRunning = true;

    const forkSession = await sessionPromise;
    forkSession.setCaptureEnabled(false); // Gemini does its own VAD
    forkSession.on('audio', (pcm) => { if (callActive) gemini.sendAudio(pcm); });
    forkSession.on('close', () => finish('fork_closed'));

    // Kick off the conversation
    if (initialContext && announceOnly) {
      gemini.sendText(
        'התקשרת עכשיו למשתמש והוא ענה. מסור לו בעברית את ההודעה הבאה, אמור שלום ואז קרא ל-end_call: "' +
        initialContext + '"'
      );
    } else if (initialContext) {
      gemini.sendText(
        'התקשרת עכשיו למשתמש והוא ענה. מסור לו את ההודעה הבאה בעברית ושאל אם הוא רוצה שתעשה משהו: "' +
        initialContext + '"'
      );
    } else if (!skipGreeting) {
      gemini.sendText('המתקשר התחבר עכשיו. ברך אותו במשפט קצר בעברית ושאל במה אפשר לעזור.');
    }

    const reason = await finished;
    logger.info('Gemini conversation finished', { callUuid, reason });
  } catch (err) {
    logger.error('Gemini conversation error', { callUuid, error: err.message });
  } finally {
    clearTimeout(maxTimer);
    dialog.off && dialog.off('destroy', onDestroy);
    callActive = false;
    if (gemini) gemini.close();
    if (forkRunning) {
      try { await endpoint.forkAudioStop(); } catch { /* call may be gone */ }
    }
    audioForkServer.cancelExpectation && audioForkServer.cancelExpectation(callUuid);
    try { await claudeBridge.endSession(callUuid); } catch { /* ignore */ }
  }
}

module.exports = {
  runGeminiConversation,
  SegmentPlayer,
  pcmToWav,
  TOOLS,
  DEFAULT_SYSTEM_PROMPT_HE
};
