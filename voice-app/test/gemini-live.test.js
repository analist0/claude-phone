const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const WebSocket = require('ws');
const { setImmediate } = require('node:timers');

const { GeminiLiveClient, buildSetupMessage, resolveEndpoint } = require('../lib/gemini-live-client');
const { pcmToWav, SegmentPlayer, runGeminiConversation } = require('../lib/gemini-conversation');
const { getVoiceEngine } = require('../lib/voice-engine');

test('voice engine selection', () => {
  assert.strictEqual(getVoiceEngine({}), 'classic');
  assert.strictEqual(getVoiceEngine({ GEMINI_API_KEY: 'x' }), 'gemini-live');
  assert.strictEqual(getVoiceEngine({ GOOGLE_CLOUD_PROJECT: 'p' }), 'gemini-live');
  assert.strictEqual(getVoiceEngine({ GEMINI_API_KEY: 'x', VOICE_ENGINE: 'classic' }), 'classic');
  assert.strictEqual(getVoiceEngine({ VOICE_ENGINE: 'gemini' }), 'gemini-live');
});

test('resolveEndpoint uses AI Studio key', async () => {
  const ep = await resolveEndpoint({ GEMINI_API_KEY: 'k&y' });
  assert.strictEqual(ep.backend, 'gemini-api');
  assert.match(ep.url, /generativelanguage\.googleapis\.com/);
  assert.match(ep.url, /key=k%26y$/);
  assert.strictEqual(ep.model, 'models/gemini-3.8-live');
});

test('resolveEndpoint throws without credentials', async () => {
  await assert.rejects(resolveEndpoint({}), /not configured/);
});

test('buildSetupMessage includes audio, tools and transcription', () => {
  const msg = buildSetupMessage({
    model: 'models/m', systemInstruction: 'hi', tools: [{ name: 't' }], voiceName: 'Puck', languageCode: 'he-IL'
  });
  assert.deepStrictEqual(msg.setup.generationConfig.responseModalities, ['AUDIO']);
  assert.strictEqual(msg.setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Puck');
  assert.strictEqual(msg.setup.generationConfig.speechConfig.languageCode, 'he-IL');
  assert.strictEqual(msg.setup.tools[0].functionDeclarations[0].name, 't');
  assert.strictEqual(msg.setup.systemInstruction.parts[0].text, 'hi');
  assert.ok(msg.setup.inputAudioTranscription);
});

test('pcmToWav writes a valid header', () => {
  const wav = pcmToWav(Buffer.alloc(480), 24000);
  assert.strictEqual(wav.length, 524);
  assert.strictEqual(wav.toString('ascii', 0, 4), 'RIFF');
  assert.strictEqual(wav.readUInt32LE(24), 24000);
  assert.strictEqual(wav.readUInt32LE(40), 480);
});

function fakeEndpoint() {
  const ep = new EventEmitter();
  ep.uuid = 'uuid-1';
  ep.played = [];
  ep.apis = [];
  ep.play = async (url) => { ep.played.push(url); await new Promise((r) => setTimeout(r, 5)); };
  ep.api = async (cmd, args) => { ep.apis.push([cmd, args]); };
  return ep;
}

test('SegmentPlayer plays buffered audio and flushes on interrupt', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gl-'));
  const ep = fakeEndpoint();
  const player = new SegmentPlayer({ endpoint: ep, audioDir: dir, baseUrl: 'http://x', isActive: () => true });

  player.push(Buffer.alloc(100));
  assert.strictEqual(ep.played.length, 0); // below first-segment threshold
  player.endTurn();
  await player.waitIdle(1000);
  assert.strictEqual(ep.played.length, 1);

  player.push(Buffer.alloc(24000 * 2)); // big segment -> starts playing
  await player.interrupt();
  player.push(Buffer.alloc(10));
  assert.strictEqual(player.pendingBytes, 10);
  await player.interrupt();
  assert.strictEqual(player.pendingBytes, 0);
  assert.strictEqual(player.queue.length, 0);
});

/** Local stand-in for the Gemini Live WebSocket service */
async function startFakeGemini(onClientMessage) {
  const wss = new WebSocket.Server({ port: 0 });
  await new Promise((r) => wss.on('listening', r));
  const port = wss.address().port;
  wss.on('connection', (ws) => {
    ws.on('message', (raw) => onClientMessage(JSON.parse(raw.toString()), ws));
  });
  class RedirectedWS extends WebSocket {
    constructor() { super('ws://127.0.0.1:' + port); }
  }
  return { wss, RedirectedWS };
}

test('GeminiLiveClient: setup, audio out, audio in, tool calls', async () => {
  const received = [];
  const { wss, RedirectedWS } = await startFakeGemini((msg, ws) => {
    received.push(msg);
    if (msg.setup) {
      ws.send(JSON.stringify({ setupComplete: {} }));
      ws.send(JSON.stringify({
        serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: Buffer.from([1, 2]).toString('base64') } }] } }
      }));
      ws.send(JSON.stringify({ toolCall: { functionCalls: [{ id: 'c1', name: 'ask_claude', args: { request: 'uptime' } }] } }));
    }
  });

  const client = new GeminiLiveClient({ env: { GEMINI_API_KEY: 'k' }, WebSocketImpl: RedirectedWS, systemInstruction: 's' });
  const audio = new Promise((r) => client.once('audio', r));
  const tool = new Promise((r) => client.once('toolCall', r));
  await client.connect();
  assert.deepStrictEqual([...(await audio)], [1, 2]);
  const calls = await tool;
  assert.strictEqual(calls[0].args.request, 'uptime');

  client.sendAudio(Buffer.from([5, 6]));
  client.sendToolResponse([{ id: 'c1', name: 'ask_claude', response: { result: 'ok' } }]);
  await new Promise((r) => setTimeout(r, 50));

  assert.strictEqual(received[0].setup.model, 'models/gemini-3.8-live');
  const audioIn = received.find((m) => m.realtimeInput);
  assert.strictEqual(audioIn.realtimeInput.audio.mimeType, 'audio/pcm;rate=16000');
  assert.ok(received.find((m) => m.toolResponse));

  client.close();
  wss.close();
});

test('runGeminiConversation: greets, streams audio, calls Claude, hangs up', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gl-'));
  const instances = [];

  class FakeGemini extends EventEmitter {
    constructor(opts) { super(); this.opts = opts; this.sent = []; this.audioIn = []; this.toolResponses = []; instances.push(this); }
    async connect() { this.backend = 'fake'; }
    sendAudio(pcm) { this.audioIn.push(pcm); }
    sendText(t) {
      this.sent.push(t);
      // Model answers: speaks, asks Claude, then ends the call
      setImmediate(() => {
        this.emit('audio', Buffer.alloc(24000));
        this.emit('turnComplete');
        this.emit('toolCall', [{ id: '1', name: 'ask_claude', args: { request: 'disk usage' } }]);
      });
    }
    sendToolResponse(r) {
      this.toolResponses.push(r[0]);
      if (r[0].name === 'ask_claude') setImmediate(() => this.emit('toolCall', [{ id: '2', name: 'end_call', args: {} }]));
    }
    close() {}
  }

  const forkSession = new EventEmitter();
  forkSession.setCaptureEnabled = () => {};
  const audioForkServer = {
    expectSession: () => Promise.resolve(forkSession),
    cancelExpectation: () => {}
  };
  const ep = fakeEndpoint();
  ep.forkAudioStart = async () => { setImmediate(() => forkSession.emit('audio', Buffer.alloc(640))); };
  ep.forkAudioStop = async () => { ep.forkStopped = true; };
  const dialog = new EventEmitter();
  const claudeCalls = [];
  const claudeBridge = {
    query: async (prompt, opts) => { claudeCalls.push({ prompt, opts }); return '42% used'; },
    endSession: async () => { claudeBridge.ended = true; }
  };

  await runGeminiConversation(ep, dialog, 'call-1', {
    audioForkServer, claudeBridge, wsPort: 3001, audioDir: dir, GeminiClientImpl: FakeGemini
  });

  const g = instances[0];
  assert.match(g.opts.systemInstruction, /עברית/);
  assert.match(g.sent[0], /ברך/);
  assert.strictEqual(g.audioIn.length, 1);
  assert.match(claudeCalls[0].prompt, /disk usage/);
  assert.strictEqual(claudeCalls[0].opts.callId, 'call-1');
  assert.strictEqual(g.toolResponses[0].response.result, '42% used');
  assert.ok(ep.played.length >= 1);
  assert.ok(ep.forkStopped);
  assert.ok(claudeBridge.ended);
});
