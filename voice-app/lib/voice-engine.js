/**
 * Voice engine selection
 *
 * VOICE_ENGINE=gemini-live -> Gemini Live speech-to-speech, Claude Code as a tool
 * VOICE_ENGINE=classic     -> Whisper STT + Claude + ElevenLabs TTS
 * unset                    -> gemini-live if Gemini credentials exist, else classic
 */
const { isGeminiConfigured } = require('./gemini-live-client');

function getVoiceEngine(env = process.env) {
  const v = (env.VOICE_ENGINE || '').toLowerCase().trim();
  if (v === 'gemini' || v === 'gemini-live') return 'gemini-live';
  if (v === 'classic') return 'classic';
  return isGeminiConfigured(env) ? 'gemini-live' : 'classic';
}

function useGeminiEngine(env = process.env) {
  return getVoiceEngine(env) === 'gemini-live';
}

module.exports = { getVoiceEngine, useGeminiEngine };
