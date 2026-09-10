#!/usr/bin/env node
// Speech E2E smoke — boots a REAL gateway under a throwaway DASH_HOME
// (reusing scripts/memory-e2e/harness.mjs, which copies secret.key +
// credentials.enc so the configured OpenRouter key is present) and drives
// the Phase A speech routes against the REAL provider:
//
//   1. GET  /speech/config            → openrouter provider available; realtime slot unavailable with reason
//   2. GET  /speech/models?kind=…     → at least one transcription and one speech model
//   3. POST /speech/transcriptions    → fixtures/hello.wav ("Hello from Dash, what is two plus two?") transcribes
//   4. POST /speech/speech            → audio/mpeg bytes for a short sentence
//
// Also exercises the /mobile/v1 mount (health advertises 'speech-v1').
// Real (small, ~cents) provider calls, so NOT part of `npm test`/CI.
// Phase B (voice frames over /ws/chat) is appended to this script by Task B10.
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootGateway, preflight } from '../memory-e2e/harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
// Whisper may write "2+2" or "two plus two": accept either spelling of each token.
const EXPECTED_TOKENS = [['dash'], ['two', '2'], ['plus', '+']];

let failures = 0;
const check = (ok, what, expected, got) => {
  console.log(`  ${ok ? '✅' : '❌'} ${what}`);
  if (!ok) {
    failures++;
    console.log(`       expected: ${expected}`);
    console.log(`       got:      ${got}`);
  }
  return ok;
};
class Fatal extends Error {}
const require_ = (ok, what, expected, got) => {
  if (!check(ok, what, expected, got)) throw new Fatal(what);
};

const json = async (res) => {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { _raw: text };
  }
};

async function main() {
  await preflight();
  const gw = await bootGateway({
    root: join(process.env.TMPDIR || '/tmp', 'dash-speech-e2e'),
    mgmtPort: Number(process.env.SPEECH_E2E_MPORT || 19314),
    chatPort: Number(process.env.SPEECH_E2E_CPORT || 19214),
  });
  console.log(`speech:e2e — gateway up at ${gw.mgmtUrl} (data ${gw.dataDir})`);
  try {
    // 0. Capability
    const health = await json(await fetch(`${gw.mgmtUrl}/health`));
    check(
      Array.isArray(health.capabilities) && health.capabilities.includes('speech-v1'),
      "GET /health advertises 'speech-v1'",
      "capabilities includes 'speech-v1'",
      JSON.stringify(health.capabilities),
    );

    // 1. Config + providers
    console.log('\n1. GET /speech/config');
    const cfg = await json(await fetch(`${gw.mgmtUrl}/speech/config`));
    const openrouter = cfg.providers?.find((p) => p.id === 'openrouter');
    require_(
      openrouter?.available === true,
      'openrouter provider is available (key present)',
      '{ id: openrouter, available: true }',
      JSON.stringify(openrouter ?? cfg),
    );
    const realtime = cfg.providers?.find((p) => p.id === 'realtime');
    check(
      realtime?.available === false && realtime?.reason === 'no_provider_offers_realtime',
      'realtime slot is unavailable with reason',
      "{ available: false, reason: 'no_provider_offers_realtime' }",
      JSON.stringify(realtime),
    );
    check(
      typeof cfg.config?.stt?.model === 'string' && typeof cfg.config?.tts?.model === 'string',
      'default config names an STT and a TTS model',
      'config.stt.model + config.tts.model strings',
      JSON.stringify(cfg.config),
    );
    console.log(
      `     stt=${cfg.config?.stt?.model} tts=${cfg.config?.tts?.model}/${cfg.config?.tts?.voice}`,
    );

    // 2. Models (real provider list)
    console.log('\n2. GET /speech/models');
    for (const kind of ['transcription', 'speech']) {
      const res = await fetch(`${gw.mgmtUrl}/speech/models?kind=${kind}`);
      const body = await json(res);
      check(
        res.ok && Array.isArray(body.models) && body.models.length > 0,
        `kind=${kind} returns at least one model`,
        '200 { models: [>=1] }',
        `${res.status} ${JSON.stringify(body).slice(0, 200)}`,
      );
      if (Array.isArray(body.models)) {
        console.log(
          `     ${kind}: ${body.models
            .map((m) => m.id)
            .slice(0, 6)
            .join(', ')}${body.models.length > 6 ? ', …' : ''}`,
        );
      }
    }

    // 3. Transcription (real STT)
    console.log('\n3. POST /speech/transcriptions');
    const wav = await readFile(join(HERE, 'fixtures/hello.wav'));
    const t0 = Date.now();
    const tRes = await fetch(`${gw.mgmtUrl}/mobile/v1/speech/transcriptions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ audio: wav.toString('base64'), format: 'wav', language: 'en' }),
    });
    const tBody = await json(tRes);
    require_(
      tRes.ok && typeof tBody.text === 'string',
      `transcription returns text (${Date.now() - t0} ms)`,
      '200 { text }',
      `${tRes.status} ${JSON.stringify(tBody).slice(0, 300)}`,
    );
    console.log(`     text: "${tBody.text}"`);
    const lower = tBody.text.toLowerCase();
    const missing = EXPECTED_TOKENS.filter((alts) => !alts.some((w) => lower.includes(w)));
    check(
      missing.length === 0,
      `transcript contains ${EXPECTED_TOKENS.map((alts) => alts.map((w) => `"${w}"`).join('/')).join(', ')}`,
      'all expected words present',
      `missing ${JSON.stringify(missing)} in "${tBody.text}"`,
    );

    // 4. Synthesis (real TTS)
    console.log('\n4. POST /speech/speech');
    const s0 = Date.now();
    const sRes = await fetch(`${gw.mgmtUrl}/mobile/v1/speech/speech`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Two plus two is four.' }),
    });
    const ctype = sRes.headers.get('content-type') ?? '';
    const audio = Buffer.from(await sRes.arrayBuffer());
    check(
      sRes.ok && ctype.startsWith('audio/mpeg'),
      `synthesis responds audio/mpeg (${Date.now() - s0} ms)`,
      '200 audio/mpeg',
      `${sRes.status} ${ctype} ${audio.length === 0 ? '' : audio.subarray(0, 120).toString('utf8')}`,
    );
    // MP3 starts with an ID3 tag or a frame sync (0xFF 0xFB/0xF3/0xF2).
    const isMp3 =
      audio.length > 1000 &&
      (audio.subarray(0, 3).toString('latin1') === 'ID3' ||
        (audio[0] === 0xff && (audio[1] & 0xe0) === 0xe0));
    check(
      isMp3,
      `synthesis body looks like MP3 (${audio.length} bytes)`,
      'ID3 tag or MPEG frame sync, > 1 KB',
      `${audio.length} bytes, head ${audio.subarray(0, 4).toString('hex')}`,
    );

    // 5. Validation envelope on the mobile mount
    console.log('\n5. validation envelope');
    const vRes = await fetch(`${gw.mgmtUrl}/mobile/v1/speech/speech`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    const vBody = await json(vRes);
    check(
      vRes.status === 400 && vBody.code === 'validation_failed',
      'empty synthesis body → 400 validation_failed',
      "400 { code: 'validation_failed' }",
      `${vRes.status} ${JSON.stringify(vBody)}`,
    );
  } catch (err) {
    if (!(err instanceof Fatal)) {
      failures++;
      console.log(`  ❌ unexpected error: ${err?.stack || err}`);
    }
    console.log(`\n--- gateway log tail ---\n${gw.tail(40)}`);
  } finally {
    await gw.stop();
  }
  console.log(`\nspeech:e2e — ${failures === 0 ? 'PASS' : `FAIL (${failures})`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
