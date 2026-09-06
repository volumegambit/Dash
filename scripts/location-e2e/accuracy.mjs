/**
 * Accuracy probe: how well can the agent answer "Where am I?" under each
 * tier of location data we can actually supply?
 *
 * This is a measurement, not a pass/fail gate. It prints the model's answer
 * for each condition so the accuracy gap is visible rather than assumed.
 */
import { randomUUID } from 'node:crypto';
import {
  bootGateway,
  pickModel,
  preflight,
  registerAgent,
  replyText,
  setMemoryConfig,
} from '../memory-e2e/harness.mjs';

const QUESTION = 'Where am I? Be as specific as you can. One short sentence.';

// Ground truth for the precise cases: Marina Bay Sands, Singapore.
const LAT = 1.2834;
const LON = 103.8607;

const CONDITIONS = [
  {
    name: 'A. coarse only, city-state zone (Asia/Singapore)',
    location: { timezone: 'Asia/Singapore', utcOffsetMinutes: 480, locale: 'en-SG', region: 'SG' },
  },
  {
    name: 'B. coarse only, WIDE zone (America/New_York)',
    location: {
      timezone: 'America/New_York',
      utcOffsetMinutes: -240,
      locale: 'en-US',
      region: 'US',
    },
  },
  {
    name: 'C. precise coords, NO place name',
    location: {
      timezone: 'Asia/Singapore',
      utcOffsetMinutes: 480,
      locale: 'en-SG',
      region: 'SG',
      precise: {
        latitude: LAT,
        longitude: LON,
        accuracyMeters: 15,
        capturedAt: new Date().toISOString(),
      },
    },
  },
  {
    name: 'D. precise coords WITH a reverse-geocoded place name',
    location: {
      timezone: 'Asia/Singapore',
      utcOffsetMinutes: 480,
      locale: 'en-SG',
      region: 'SG',
      precise: {
        latitude: LAT,
        longitude: LON,
        accuracyMeters: 15,
        capturedAt: new Date().toISOString(),
        place: 'Marina Bay Sands, Marina Bay, Singapore',
      },
    },
  },
];

function driveTurn(gw, agentId, conversationId, text, location) {
  return new Promise((resolve) => {
    const ws = new WebSocket(gw.chatUrl);
    const events = [];
    const id = randomUUID();
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {}
      resolve({ text: replyText(events), timedOut: true });
    }, 180000);
    const settle = (extra) => {
      clearTimeout(timer);
      try {
        ws.close();
      } catch {}
      resolve({ text: replyText(events), ...extra });
    };
    ws.onopen = () =>
      ws.send(
        JSON.stringify({
          type: 'message',
          id,
          agentId,
          channelId: 'direct',
          conversationId,
          text,
          ...(location ? { location } : {}),
        }),
      );
    ws.onmessage = (e) => {
      let m;
      try {
        m = JSON.parse(e.data.toString());
      } catch {
        return;
      }
      if (m.id && m.id !== id) return;
      if (m.type === 'event') events.push(m.event);
      else if (m.type === 'done') settle({});
      else if (m.type === 'error') settle({ error: m.error });
    };
    ws.onerror = () => settle({ error: 'ws connect error' });
  });
}

async function main() {
  await preflight();
  if (process.env.LOCATION_E2E_MODEL && !process.env.MEMORY_E2E_MODEL) {
    process.env.MEMORY_E2E_MODEL = process.env.LOCATION_E2E_MODEL;
  }
  const model = await pickModel();
  console.log(`model: ${model}`);
  console.log(`ground truth for C/D: ${LAT}, ${LON} = Marina Bay Sands, Singapore\n`);

  const gw = await bootGateway({
    root: `${process.env.TMPDIR || '/tmp'}/dash-location-accuracy`,
    mgmtPort: Number(process.env.LOCATION_E2E_MPORT || 19316),
    chatPort: Number(process.env.LOCATION_E2E_CPORT || 19216),
  });
  try {
    const agent = await registerAgent(gw, {
      name: 'accuracy-probe',
      model,
      systemPrompt: 'You are a concise assistant.',
    });
    const agentId = agent.id ?? agent.agentId;
    await setMemoryConfig(gw, agentId, { sweep: 'off' });

    for (const condition of CONDITIONS) {
      const reply = await driveTurn(gw, agentId, randomUUID(), QUESTION, condition.location);
      console.log(
        `${condition.name}\n   -> ${JSON.stringify(reply.text)}${reply.error ? ` [error: ${reply.error}]` : ''}\n`,
      );
    }
  } finally {
    await gw.stop();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
