/**
 * Gemini Live API client (bidirectional WebSocket)
 *
 * Streams caller audio (16kHz PCM16) to Gemini and receives spoken audio
 * (24kHz PCM16), transcriptions and tool calls back.
 *
 * Auth (first match wins):
 *   1. GEMINI_API_KEY            -> Gemini Developer API (Google AI Studio key)
 *   2. GOOGLE_CLOUD_PROJECT      -> Vertex AI (service account via
 *                                   GOOGLE_APPLICATION_CREDENTIALS)
 */

const { EventEmitter } = require('node:events');
const WebSocket = require('ws');

const DEFAULT_MODEL = 'gemini-3.8-live';
const DEFAULT_VOICE = 'Kore';
const INPUT_MIME = 'audio/pcm;rate=16000';

function isGeminiConfigured(env = process.env) {
  return Boolean(env.GEMINI_API_KEY || env.GOOGLE_CLOUD_PROJECT);
}

async function getVertexAccessToken() {
  let GoogleAuth;
  try {
    ({ GoogleAuth } = require('google-auth-library'));
  } catch {
    throw new Error('google-auth-library is not installed (needed for Vertex AI)');
  }
  const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  const client = await auth.getClient();
  const { token } = await client.getAccessToken();
  if (!token) throw new Error('Could not obtain Google Cloud access token');
  return token;
}

/**
 * Resolve WebSocket URL, headers and fully-qualified model name.
 */
async function resolveEndpoint(env = process.env) {
  const model = env.GEMINI_LIVE_MODEL || DEFAULT_MODEL;

  if (env.GEMINI_API_KEY) {
    return {
      backend: 'gemini-api',
      url: 'wss://generativelanguage.googleapis.com/ws/' +
        'google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent' +
        '?key=' + encodeURIComponent(env.GEMINI_API_KEY),
      headers: {},
      model: model.startsWith('models/') ? model : 'models/' + model
    };
  }

  if (env.GOOGLE_CLOUD_PROJECT) {
    const location = env.GOOGLE_CLOUD_LOCATION || 'us-central1';
    const token = await getVertexAccessToken();
    const host = location === 'global' ? 'aiplatform.googleapis.com' : location + '-aiplatform.googleapis.com';
    return {
      backend: 'vertex',
      url: 'wss://' + host + '/ws/google.cloud.aiplatform.v1.LlmBidiService/BidiGenerateContent',
      headers: { Authorization: 'Bearer ' + token },
      model: model.startsWith('projects/')
        ? model
        : 'projects/' + env.GOOGLE_CLOUD_PROJECT + '/locations/' + location + '/publishers/google/models/' + model
    };
  }

  throw new Error('Gemini not configured: set GEMINI_API_KEY or GOOGLE_CLOUD_PROJECT');
}

/**
 * Build the BidiGenerateContent setup message.
 */
function buildSetupMessage({ model, systemInstruction, tools, voiceName, languageCode }) {
  const speechConfig = {
    voiceConfig: { prebuiltVoiceConfig: { voiceName: voiceName || DEFAULT_VOICE } }
  };
  if (languageCode) speechConfig.languageCode = languageCode;

  const setup = {
    model,
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig
    },
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    // Lets calls run longer than the default audio session limit
    contextWindowCompression: { slidingWindow: {} }
  };
  if (systemInstruction) setup.systemInstruction = { parts: [{ text: systemInstruction }] };
  if (tools && tools.length) setup.tools = [{ functionDeclarations: tools }];
  return { setup };
}

class GeminiLiveClient extends EventEmitter {
  /**
   * @param {Object} opts
   * @param {string} opts.systemInstruction
   * @param {Array}  opts.tools - function declarations
   * @param {string} [opts.voiceName]
   * @param {string} [opts.languageCode]
   * @param {Object} [opts.env] - environment (for tests)
   * @param {Function} [opts.WebSocketImpl] - WebSocket constructor (for tests)
   */
  constructor(opts = {}) {
    super();
    this.opts = opts;
    this.env = opts.env || process.env;
    this.WebSocketImpl = opts.WebSocketImpl || WebSocket;
    this.ws = null;
    this.ready = false;
    this.closed = false;
  }

  async connect({ timeoutMs = 15000 } = {}) {
    const ep = await resolveEndpoint(this.env);
    this.backend = ep.backend;

    return new Promise((resolve, reject) => {
      const ws = new this.WebSocketImpl(ep.url, { headers: ep.headers });
      this.ws = ws;
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error('Gemini Live setup timed out'));
        try { ws.close(); } catch { /* ignore */ }
      }, timeoutMs);

      ws.on('open', () => {
        ws.send(JSON.stringify(buildSetupMessage({
          model: ep.model,
          systemInstruction: this.opts.systemInstruction,
          tools: this.opts.tools,
          voiceName: this.opts.voiceName || this.env.GEMINI_VOICE,
          languageCode: this.opts.languageCode || this.env.GEMINI_LANGUAGE_CODE
        })));
      });

      ws.on('message', (data) => {
        let msg;
        try {
          msg = JSON.parse(data.toString());
        } catch {
          return;
        }
        if (msg.setupComplete && !settled) {
          settled = true;
          clearTimeout(timer);
          this.ready = true;
          resolve();
        }
        this._handleMessage(msg);
      });

      ws.on('close', (code, reason) => {
        this.ready = false;
        this.closed = true;
        clearTimeout(timer);
        const why = reason ? reason.toString() : '';
        if (!settled) {
          settled = true;
          reject(new Error('Gemini Live closed during setup (' + code + ') ' + why));
        }
        this.emit('close', { code, reason: why });
      });

      ws.on('error', (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(err);
        }
        this.emit('error', err);
      });
    });
  }

  _handleMessage(msg) {
    const sc = msg.serverContent;
    if (sc) {
      if (sc.interrupted) this.emit('interrupted');
      const parts = (sc.modelTurn && sc.modelTurn.parts) || [];
      for (const part of parts) {
        if (part.inlineData && part.inlineData.data &&
            String(part.inlineData.mimeType || '').startsWith('audio/')) {
          this.emit('audio', Buffer.from(part.inlineData.data, 'base64'));
        }
      }
      if (sc.inputTranscription && sc.inputTranscription.text) {
        this.emit('inputTranscript', sc.inputTranscription.text);
      }
      if (sc.outputTranscription && sc.outputTranscription.text) {
        this.emit('outputTranscript', sc.outputTranscription.text);
      }
      if (sc.turnComplete) this.emit('turnComplete');
    }
    if (msg.toolCall && Array.isArray(msg.toolCall.functionCalls)) {
      this.emit('toolCall', msg.toolCall.functionCalls);
    }
    if (msg.toolCallCancellation) this.emit('toolCallCancellation', msg.toolCallCancellation.ids || []);
    if (msg.goAway) this.emit('goAway', msg.goAway);
  }

  _send(obj) {
    if (!this.ws || this.closed || this.ws.readyState !== 1) return false;
    this.ws.send(JSON.stringify(obj));
    return true;
  }

  /** Send caller audio (PCM16 LE, 16kHz mono) */
  sendAudio(pcm) {
    if (!this.ready || !pcm || !pcm.length) return false;
    return this._send({ realtimeInput: { audio: { data: pcm.toString('base64'), mimeType: INPUT_MIME } } });
  }

  /** Send a text turn (e.g. "greet the caller") */
  sendText(text, turnComplete = true) {
    return this._send({
      clientContent: { turns: [{ role: 'user', parts: [{ text }] }], turnComplete }
    });
  }

  sendToolResponse(functionResponses) {
    return this._send({ toolResponse: { functionResponses } });
  }

  close() {
    this.ready = false;
    if (this.ws && !this.closed) {
      try { this.ws.close(); } catch { /* ignore */ }
    }
  }
}

module.exports = {
  GeminiLiveClient,
  buildSetupMessage,
  resolveEndpoint,
  isGeminiConfigured,
  DEFAULT_MODEL
};
