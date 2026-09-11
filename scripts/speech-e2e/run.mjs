#!/usr/bin/env node
// Speech E2E smoke — boots a REAL gateway under a throwaway DASH_HOME
// (reusing scripts/memory-e2e/harness.mjs, which copies secret.key +
// credentials.enc so the configured OpenRouter key is present) and drives
// the speech routes AND the hands-free voice WebSocket protocol against the
// REAL provider:
//
//   1. GET  /speech/config            → openrouter provider available; realtime slot unavailable with reason
//   2. GET  /speech/models?kind=…     → at least one transcription and one speech model
//   3. POST /speech/transcriptions    → fixtures/hello.wav ("Hello from Dash, what is two plus two?") transcribes
//   4. POST /speech/speech            → audio/mpeg bytes for a short sentence
//   5. validation envelope on the mobile mount
//   6. a full hands-free voice turn over /ws/chat: voice_start → stream
//      fixtures/hello.wav's PCM as ~100ms voice_audio frames (600ms of
//      calibration silence first, 1.5s of trailing silence after) → asserts
//      voice_state listening, a final voice_transcript, the hub's accepted
//      AFTER the transcript, >=1 voice_speech, done, voice_state listening
//      again, then voice_stop → voice_stopped { reason: 'client' }.
//
// Also exercises the /mobile/v1 mount (health advertises 'speech-v1').
// Real (small, ~cents) provider calls, so NOT part of `npm test`/CI.
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootGateway, pickModel, preflight, registerAgent, sleep } from '../memory-e2e/harness.mjs';

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

/**
 * Find the `data` sub-chunk of a canonical RIFF/WAVE file and return its raw
 * PCM bytes. `afconvert` inserts a `FLLR` filler chunk between `fmt ` and
 * `data` for alignment, so the PCM does NOT reliably start at byte 44 — it is
 * found by walking the chunk list, not assumed.
 */
function wavPcm(buf) {
  let offset = 12; // past 'RIFF' size 'WAVE'
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === 'data') return buf.subarray(offset + 8, offset + 8 + size);
    offset += 8 + size + (size % 2);
  }
  throw new Error('no data chunk found in WAV file');
}

/** One-line description of a voice/hub frame, for the transcript log. */
function describeFrame(m) {
  if (m.type === 'voice_state') return `state=${m.state}${m.turnId ? ` turnId=${m.turnId}` : ''}`;
  if (m.type === 'voice_transcript') {
    return `final=${m.final} turnId=${m.turnId ?? '-'} text="${m.text}"`;
  }
  if (m.type === 'voice_speech') {
    const bytes = typeof m.audio === 'string' ? Buffer.from(m.audio, 'base64').length : 0;
    return `seq=${m.seq} format=${m.format} bytes=${bytes} text="${m.text}"`;
  }
  if (m.type === 'voice_error') return `code=${m.code} error=${m.error}`;
  if (m.type === 'voice_stopped') return `reason=${m.reason}`;
  if (m.type === 'accepted') return `id=${m.id}`;
  if (m.type === 'done') return `id=${m.id} outcome=${m.outcome ?? '-'}`;
  if (m.type === 'error') return `id=${m.id} error=${m.error} code=${m.code ?? '-'}`;
  return '';
}

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

    // 6. Hands-free voice turn over /ws/chat (real STT + LLM + TTS)
    console.log('\n6. WebSocket voice turn (/ws/chat)');
    const model = process.env.SPEECH_E2E_MODEL || (await pickModel());
    const agent = await registerAgent(gw, {
      name: 'speech-e2e',
      model,
      systemPrompt: 'You are a terse assistant. Answer the spoken question in one short sentence.',
    });
    console.log(`     agent ${agent.id} (model ${model})`);
    const convRes = await fetch(`${gw.mgmtUrl}/conversations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: agent.id, requestId: `speech-e2e-${Date.now()}` }),
    });
    const conv = await json(convRes);
    require_(
      convRes.ok && typeof conv.id === 'string',
      'created a conversation for the voice turn',
      '201 { id }',
      `${convRes.status} ${JSON.stringify(conv)}`,
    );
    console.log(`     conversation ${conv.id}`);

    const voiceId = crypto.randomUUID();
    const wsT0 = Date.now();
    const wsFrames = []; // { t: msSinceWsT0, m: parsedFrame }
    const ws = new WebSocket(gw.chatUrl);
    await new Promise((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = (e) => reject(new Error(`ws connect error: ${e?.message || e}`));
    });
    ws.onmessage = (e) => {
      let m;
      try {
        m = JSON.parse(e.data.toString());
      } catch {
        return;
      }
      const t = Date.now() - wsT0;
      wsFrames.push({ t, m });
      console.log(`     [${(t / 1000).toFixed(2)}s] ← ${m.type}  ${describeFrame(m)}`);
    };
    const send = (frame) => ws.send(JSON.stringify(frame));

    /** Resolve the first frame (at index > afterIndex) matching `pred`, or undefined on timeout. */
    const waitFor = (pred, timeoutMs, afterIndex = -1) =>
      new Promise((resolve) => {
        const tryFind = () => wsFrames.findIndex((f, i) => i > afterIndex && pred(f.m));
        const already = tryFind();
        if (already !== -1) return resolve({ index: already, ...wsFrames[already] });
        const interval = setInterval(() => {
          const idx = tryFind();
          if (idx !== -1) {
            clearInterval(interval);
            clearTimeout(timer);
            resolve({ index: idx, ...wsFrames[idx] });
          }
        }, 50);
        const timer = setTimeout(() => {
          clearInterval(interval);
          resolve(undefined);
        }, timeoutMs);
      });

    // Whole step 6 shares a 120s budget across the streaming + every wait below.
    const deadline = Date.now() + 120_000;
    const remaining = () => Math.max(1000, deadline - Date.now());

    try {
      console.log(`     voice_start id=${voiceId} agent=${agent.id} conversation=${conv.id}`);
      send({ type: 'voice_start', id: voiceId, agentId: agent.id, conversationId: conv.id });
      const listening1 = await waitFor(
        (m) => m.type === 'voice_state' && m.id === voiceId && m.state === 'listening',
        remaining(),
      );
      require_(
        listening1 !== undefined,
        'voice_state listening (session ready — the gateway drops voice_audio before this)',
        'voice_state { state: listening }',
        wsFrames.map((f) => f.m.type).join(', ') || 'no frames received',
      );

      // The gateway's VAD is deaf for its first 500ms calibration window, and
      // needs >=300ms of speech to start / 700ms of silence to end an
      // utterance — so send 600ms of silence, the WAV's real PCM (paced
      // ~100ms apart so the VAD sees a realtime stream), then >=1.5s of
      // trailing silence.
      const FRAME_BYTES = 3200; // 100ms of 16 kHz mono PCM16
      const FRAME_MS = 100;
      const silenceFrame = Buffer.alloc(FRAME_BYTES);
      const wavBuf = await readFile(join(HERE, 'fixtures/hello.wav'));
      const pcm = wavPcm(wavBuf);
      console.log(
        `     streaming: ${pcm.length} bytes of speech PCM (${((pcm.length / FRAME_BYTES) * FRAME_MS).toFixed(0)}ms)`,
      );

      let seq = 0;
      const sendPacedFrame = async (buf) => {
        send({ type: 'voice_audio', id: voiceId, seq: seq++, pcm: buf.toString('base64') });
        await sleep(FRAME_MS);
      };
      for (let i = 0; i < 600 / FRAME_MS; i++) await sendPacedFrame(silenceFrame);
      for (let offset = 0; offset < pcm.length; offset += FRAME_BYTES) {
        await sendPacedFrame(pcm.subarray(offset, offset + FRAME_BYTES));
      }
      for (let i = 0; i < 1500 / FRAME_MS; i++) await sendPacedFrame(silenceFrame);

      const transcript = await waitFor(
        (m) => m.type === 'voice_transcript' && m.id === voiceId && m.final === true,
        remaining(),
        listening1.index,
      );
      require_(
        transcript !== undefined,
        'voice_transcript { final: true } arrives',
        'voice_transcript { final: true }',
        wsFrames
          .slice(listening1.index)
          .map((f) => f.m.type)
          .join(', '),
      );
      const turnId = transcript.m.turnId;
      require_(
        typeof turnId === 'string' && turnId.length > 0,
        'the final voice_transcript carries turnId',
        'string turnId',
        JSON.stringify(transcript.m),
      );
      const lowerTranscript = transcript.m.text.toLowerCase();
      const VOICE_EXPECTED_TOKENS = [
        ['two', '2'],
        ['plus', '+'],
      ];
      const missingVoice = VOICE_EXPECTED_TOKENS.filter(
        (alts) => !alts.some((w) => lowerTranscript.includes(w)),
      );
      check(
        missingVoice.length === 0,
        'transcript contains "two"/"2" and "plus"/"+"',
        'both tokens present',
        `missing ${JSON.stringify(missingVoice)} in "${transcript.m.text}"`,
      );

      const accepted = await waitFor(
        (m) => m.type === 'accepted' && m.id === turnId,
        remaining(),
        transcript.index,
      );
      check(
        accepted !== undefined,
        `the hub's accepted for turnId=${turnId} arrives`,
        'accepted { id: turnId }',
        'no accepted frame seen',
      );
      check(
        accepted !== undefined && accepted.index > transcript.index,
        'accepted arrives AFTER the voice_transcript frame',
        `accepted.index > ${transcript.index}`,
        accepted ? `accepted.index=${accepted.index}` : 'n/a',
      );

      const speechFrame = await waitFor(
        (m) =>
          m.type === 'voice_speech' &&
          m.id === voiceId &&
          typeof m.audio === 'string' &&
          m.audio.length > 0 &&
          typeof m.text === 'string' &&
          m.text.length > 0,
        remaining(),
      );
      require_(
        speechFrame !== undefined,
        '>=1 voice_speech with non-empty audio and text',
        'voice_speech { audio: non-empty, text: non-empty }',
        'no voice_speech frame seen',
      );
      check(
        speechFrame.m.format === 'mp3',
        "voice_speech.format === 'mp3' (default TTS minimax/speech-2.8-turbo)",
        'mp3',
        speechFrame.m.format,
      );

      const doneFrame = await waitFor((m) => m.type === 'done' && m.id === turnId, remaining());
      require_(
        doneFrame !== undefined,
        'done for the turn',
        'done { id: turnId }',
        'no done frame seen',
      );

      const listening2 = await waitFor(
        (m) => m.type === 'voice_state' && m.id === voiceId && m.state === 'listening',
        remaining(),
        doneFrame.index,
      );
      check(
        listening2 !== undefined,
        'voice_state listening again after the turn',
        'voice_state { state: listening }',
        'not seen after done',
      );

      if (listening2 !== undefined) {
        const between = wsFrames
          .slice(listening1.index + 1, listening2.index)
          .filter((f) => f.m.type === 'voice_state' && f.m.id === voiceId)
          .map((f) => f.m.state);
        const expectedOrder = ['transcribing', 'thinking', 'speaking'];
        let cursor = 0;
        for (const state of between) {
          if (state === expectedOrder[cursor]) cursor++;
        }
        check(
          cursor === expectedOrder.length,
          'voice_state visited transcribing, thinking, speaking in that order',
          expectedOrder.join(' → '),
          between.join(' → ') || 'none',
        );
      }

      send({ type: 'voice_stop', id: voiceId });
      const stopped = await waitFor(
        (m) => m.type === 'voice_stopped' && m.id === voiceId && m.reason === 'client',
        10_000,
      );
      check(
        stopped !== undefined,
        "voice_stop → voice_stopped { reason: 'client' }",
        "voice_stopped { reason: 'client' }",
        stopped ? JSON.stringify(stopped.m) : 'no voice_stopped frame seen',
      );
    } finally {
      try {
        ws.close();
      } catch {}
    }
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
