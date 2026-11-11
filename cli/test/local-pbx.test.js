import { test } from 'node:test';
import assert from 'node:assert';
import { generateAsteriskConfig, createLocalPbxConfig, isLocalPbx, generateAsteriskService } from '../lib/local-pbx.js';
import { generateDockerCompose, generateEnvFile } from '../lib/docker.js';

function localConfig() {
  return {
    server: { externalIp: '192.168.1.50', claudeApiPort: 3333, httpPort: 3000 },
    sip: { mode: 'local-asterisk', domain: '127.0.0.1', registrar: '127.0.0.1', localPbx: createLocalPbxConfig() },
    devices: [{ name: 'Claude', extension: '9000', authId: '9000', password: 'botpass123', voiceId: '' }],
    api: { voiceEngine: 'gemini-live', gemini: { auth: 'api-key', apiKey: 'k' } },
    secrets: { drachtio: 'd', freeswitch: 'f' },
    paths: { voiceApp: '/opt/claude-phone/voice-app' }
  };
}

test('createLocalPbxConfig keeps existing passwords and makes strong new ones', () => {
  const first = createLocalPbxConfig();
  assert.deepStrictEqual(first.users.map((u) => u.extension), ['1001', '1002']);
  assert.ok(first.users[0].password.length >= 20);
  assert.notStrictEqual(first.users[0].password, first.users[1].password);
  const again = createLocalPbxConfig(first);
  assert.strictEqual(again.users[0].password, first.users[0].password);
});

test('asterisk config has device + softphones, ACL and no chan_sip', () => {
  const config = localConfig();
  assert.ok(isLocalPbx(config));
  const files = generateAsteriskConfig(config);
  const pjsip = files['pjsip.conf'];
  assert.match(pjsip, /bind=0\.0\.0\.0:5160/);
  assert.match(pjsip, /username=9000\npassword=botpass123/);
  assert.match(pjsip, /\[1001\]\ntype=endpoint/);
  assert.match(pjsip, /deny=0\.0\.0\.0\/0\.0\.0\.0/);
  assert.match(pjsip, /permit=192\.168\.0\.0\/16/);
  assert.match(pjsip, /external_media_address=192\.168\.1\.50/);
  assert.match(files['extensions.conf'], /Dial\(PJSIP\/\$\{EXTEN\},60\)/);
  assert.match(files['modules.conf'], /noload => chan_sip\.so/);
  assert.match(files['manager.conf'], /enabled = no/);
});

test('compose and env include the local PBX', () => {
  const config = localConfig();
  const compose = generateDockerCompose(config);
  assert.match(compose, /\n  asterisk:\n/);
  assert.match(compose, /build: \/opt\/claude-phone\/pbx\/asterisk/);
  assert.match(compose, /pjsip\.conf:\/etc\/asterisk\/pjsip\.conf:ro/);
  assert.match(compose, /- freeswitch\n      - asterisk/);
  const env = generateEnvFile(config);
  assert.match(env, /SIP_REGISTRAR=127\.0\.0\.1/);
  assert.match(env, /SIP_REGISTRAR_PORT=5160/);
  assert.match(env, /SIP_TRUNK_HOST=127\.0\.0\.1:5160/);
  assert.ok(generateAsteriskService(config, '/x').includes('container_name: asterisk'));
});

test('external PBX config has no asterisk service', () => {
  const config = localConfig();
  config.sip = { mode: 'external', domain: 'pbx.example.com', registrar: '10.0.0.1' };
  assert.ok(!generateDockerCompose(config).includes('asterisk:'));
  assert.ok(!generateEnvFile(config).includes('SIP_TRUNK_HOST'));
});
