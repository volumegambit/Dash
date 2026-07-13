import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';
import { startMobileTestHarness } from '../apps/gateway/src/mobile-test-harness.ts';
import * as acceptanceClientModule from '../apps/mission-control/src/main/test-support/mobile-acceptance-client.ts';

const startMissionControlAcceptanceClient =
  acceptanceClientModule.startMissionControlAcceptanceClient ??
  acceptanceClientModule.default?.startMissionControlAcceptanceClient;

const DEFAULT_TIMEOUT_MS = 10_000;
const socketReaders = new WeakMap();

function timeout(label, timeoutMs = DEFAULT_TIMEOUT_MS, onExpire = undefined) {
  let timer;
  const promise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`Timed out waiting for ${label}`);
      onExpire?.(error);
      reject(error);
    }, timeoutMs);
    timer.unref?.();
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

async function withTimeout(operation, label, timeoutMs = DEFAULT_TIMEOUT_MS, onExpire = undefined) {
  const deadline = timeout(label, timeoutMs, onExpire);
  try {
    return await Promise.race([operation, deadline.promise]);
  } finally {
    deadline.cancel();
  }
}

export async function runCleanupActions(actions) {
  const results = await Promise.allSettled(
    actions.map((action) => Promise.resolve().then(() => action.run())),
  );
  const failures = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : [],
  );
  if (failures.length > 0) {
    const labels = actions
      .filter((_action, index) => results[index]?.status === 'rejected')
      .map((action) => action.label)
      .join(', ');
    throw new AggregateError(failures, `Mobile acceptance cleanup failed: ${labels}`);
  }
}

export async function acquireAcceptanceResource(signal, resource, cleanup) {
  const value = await resource;
  if (!signal.aborted) return value;
  try {
    await cleanup(value);
  } catch (cleanupError) {
    throw new AggregateError(
      [signal.reason, cleanupError],
      'Late mobile acceptance resource cleanup failed',
    );
  }
  throw signal.reason;
}

export async function runWithDeadlineAndCleanup(operation, cleanup, label, timeoutMs) {
  const deadlineController = new AbortController();
  let result;
  let operationError;
  try {
    result = await withTimeout(
      Promise.resolve().then(() => operation(deadlineController.signal)),
      label,
      timeoutMs,
      (error) => deadlineController.abort(error),
    );
  } catch (error) {
    operationError = error;
  }

  let cleanupError;
  try {
    await runCleanupActions(cleanup);
  } catch (error) {
    cleanupError = error;
  }

  if (operationError && cleanupError) {
    const cleanupFailures =
      cleanupError instanceof AggregateError ? cleanupError.errors : [cleanupError];
    throw new AggregateError(
      [operationError, ...cleanupFailures],
      `${label} and its cleanup failed`,
    );
  }
  if (cleanupError) throw cleanupError;
  if (operationError) throw operationError;
  return result;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function managementFetch(harness, path, init = {}, authenticated = true) {
  const headers = new Headers(init.headers);
  if (authenticated) headers.set('Authorization', `Bearer ${harness.managementToken}`);
  if (init.body !== undefined) headers.set('Content-Type', 'application/json');
  return fetch(`${harness.managementBaseUrl}${path}`, {
    ...init,
    headers,
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
}

async function requiredJson(response, label) {
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`${label} failed with HTTP ${response.status}${body ? `: ${body}` : ''}`);
  }
  return response.json();
}

function installSocketReader(socket) {
  const state = { queue: [], waiters: [], closed: false };
  socketReaders.set(socket, state);
  socket.on('message', (data) => {
    let frame;
    try {
      frame = JSON.parse(String(data));
    } catch (error) {
      for (const waiter of state.waiters.splice(0)) waiter.reject(error);
      return;
    }
    const waiter = state.waiters.shift();
    if (waiter) waiter.resolve(frame);
    else state.queue.push(frame);
  });
  socket.on('close', (code, reason) => {
    state.closed = true;
    const error = new Error(`Chat socket closed (${code}): ${String(reason)}`);
    for (const waiter of state.waiters.splice(0)) waiter.reject(error);
  });
  socket.on('error', (error) => {
    for (const waiter of state.waiters.splice(0)) waiter.reject(error);
  });
}

export async function openSocket(harness) {
  const url = new URL(harness.chatWebSocketUrl);
  url.searchParams.set('token', harness.chatToken);
  const socket = new WebSocket(url);
  installSocketReader(socket);
  try {
    await withTimeout(
      new Promise((resolve, reject) => {
        socket.once('open', resolve);
        socket.once('error', reject);
      }),
      'chat socket open',
    );
    return socket;
  } catch (error) {
    socket.terminate();
    throw error;
  }
}

export function nextFrame(socket, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const state = socketReaders.get(socket);
  if (!state) return Promise.reject(new Error('Chat socket reader is not installed'));
  if (state.queue.length > 0) return Promise.resolve(state.queue.shift());
  if (state.closed) return Promise.reject(new Error('Chat socket is already closed'));
  return new Promise((resolve, reject) => {
    const waiter = {
      resolve(frame) {
        clearTimeout(timer);
        resolve(frame);
      },
      reject(error) {
        clearTimeout(timer);
        reject(error);
      },
    };
    const timer = setTimeout(() => {
      const index = state.waiters.indexOf(waiter);
      if (index >= 0) state.waiters.splice(index, 1);
      reject(new Error('Timed out waiting for chat frame'));
    }, timeoutMs);
    timer.unref?.();
    state.waiters.push(waiter);
  });
}

async function closeSocket(socket) {
  if (!socket || socket.readyState === WebSocket.CLOSED) return;
  const closed = new Promise((resolve) => socket.once('close', resolve));
  socket.close();
  await withTimeout(closed, 'chat socket close', 2_000).catch(() => socket.terminate());
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPositiveSafeInteger(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

export function assertExpectedCapableFrame(frame, expected) {
  if (!isRecord(frame) || typeof frame.type !== 'string') {
    throw new Error('Gateway returned an invalid capable chat frame');
  }
  if (frame.id !== expected.turnId) {
    throw new Error(
      `Gateway returned an unexpected turn ${String(frame.id)}; expected ${expected.turnId}`,
    );
  }
  if (frame.conversationId !== expected.conversationId) {
    throw new Error(
      `Gateway returned an unexpected conversation ${String(frame.conversationId)}; ` +
        `expected ${expected.conversationId}`,
    );
  }
  if (!isPositiveSafeInteger(frame.seq)) {
    throw new Error(`Gateway frame for turn ${expected.turnId} is missing a durable sequence`);
  }

  switch (frame.type) {
    case 'accepted':
      if (
        typeof frame.userMessageId !== 'string' ||
        typeof frame.assistantMessageId !== 'string' ||
        !isPositiveSafeInteger(frame.revision)
      ) {
        throw new Error('Gateway returned an invalid accepted frame');
      }
      break;
    case 'event':
      if (!isRecord(frame.event) || typeof frame.event.type !== 'string') {
        throw new Error('Gateway returned an invalid event frame');
      }
      break;
    case 'done':
      if (frame.outcome !== 'completed' && frame.outcome !== 'cancelled') {
        throw new Error('Gateway returned an invalid terminal outcome');
      }
      break;
    case 'error':
      if (typeof frame.error !== 'string') {
        throw new Error('Gateway returned an invalid error frame');
      }
      break;
    default:
      throw new Error(`Gateway returned unsupported capable frame type ${frame.type}`);
  }

  return frame;
}

export function assertContiguousSequences(sequences) {
  if (sequences.length === 0) return false;
  return sequences.every((sequence, index) =>
    index === 0 ? sequence === 1 : sequence === sequences[index - 1] + 1,
  );
}

async function waitForDurableTerminal(harness, conversation, turnId, sinceSeq) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < DEFAULT_TIMEOUT_MS) {
    const response = await managementFetch(
      harness,
      `/mobile/v1/agents/${encodeURIComponent(conversation.agentId)}/conversations/` +
        `${encodeURIComponent(conversation.id)}/events?sinceSeq=${sinceSeq}`,
    );
    const replay = await requiredJson(response, 'conversation replay');
    if (
      replay.entries.some(
        (entry) =>
          entry.msgId === turnId &&
          (entry.payload.type === 'done' || entry.payload.type === 'error'),
      )
    ) {
      return;
    }
    await sleep(10);
  }
  throw new Error(`Timed out waiting for durable terminal for turn ${turnId}`);
}

export async function openContractClient(harness) {
  const activeSockets = new Set();
  const summaries = new Map();
  const sequences = [];
  let sequenceWasContiguous = false;

  const record = (frame) => {
    sequences.push(frame.seq);
    sequenceWasContiguous = assertContiguousSequences(sequences);
  };

  const open = async () => {
    const socket = await openSocket(harness);
    activeSockets.add(socket);
    socket.once('close', () => activeSockets.delete(socket));
    return socket;
  };

  const conversation = async (value) => {
    const response = await managementFetch(
      harness,
      `/mobile/v1/conversations/${encodeURIComponent(value.id)}`,
    );
    const current = await requiredJson(response, 'get conversation');
    summaries.set(current.id, current);
    return current;
  };

  return {
    get sequenceWasContiguous() {
      return sequenceWasContiguous;
    },

    async refresh() {
      const response = await managementFetch(harness, '/mobile/v1/conversations?limit=50');
      const page = await requiredJson(response, 'list conversations');
      for (const item of page.items) summaries.set(item.id, item);
      return page.items;
    },

    conversation,

    async messages(value) {
      const response = await managementFetch(
        harness,
        `/mobile/v1/conversations/${encodeURIComponent(value.id)}/messages?limit=100`,
      );
      return (await requiredJson(response, 'get conversation messages')).items;
    },

    async rename(value, revision, title) {
      return managementFetch(harness, `/mobile/v1/conversations/${encodeURIComponent(value.id)}`, {
        method: 'PATCH',
        headers: { 'If-Match': `"${revision}"` },
        body: JSON.stringify({ title }),
      });
    },

    async detachAndResume(value, turnId) {
      const canonical = await conversation(value);
      const first = await open();
      first.send(
        JSON.stringify({
          type: 'resume',
          id: turnId,
          agentId: canonical.agentId,
          conversationId: canonical.id,
          sinceSeq: 0,
        }),
      );
      let lastSeq = 0;
      let detached = false;
      while (!detached) {
        const frame = assertExpectedCapableFrame(await nextFrame(first), {
          turnId,
          conversationId: canonical.id,
        });
        record(frame);
        lastSeq = frame.seq;
        if (frame.type === 'event') detached = true;
        if (frame.type === 'done' || frame.type === 'error') {
          throw new Error('Stream completed before the detach checkpoint');
        }
      }
      await closeSocket(first);

      await waitForDurableTerminal(harness, canonical, turnId, lastSeq);
      const resumed = await open();
      resumed.send(
        JSON.stringify({
          type: 'resume',
          id: turnId,
          agentId: canonical.agentId,
          conversationId: canonical.id,
          sinceSeq: lastSeq,
        }),
      );
      let terminal;
      while (!terminal) {
        const frame = assertExpectedCapableFrame(await nextFrame(resumed), {
          turnId,
          conversationId: canonical.id,
        });
        record(frame);
        lastSeq = frame.seq;
        if (frame.type === 'done' || frame.type === 'error') terminal = frame;
      }
      await closeSocket(resumed);
      if (terminal.type === 'error') throw new Error(terminal.error);
      if (terminal.outcome !== 'completed') {
        throw new Error(`Expected completed stream, received ${String(terminal.outcome)}`);
      }
      return terminal.id;
    },

    async startAndWaitForFirstEvent(value, turnId) {
      const canonical = await conversation(value);
      const socket = await open();
      socket.send(
        JSON.stringify({
          type: 'message',
          id: turnId,
          agentId: canonical.agentId,
          channelId: 'mobile-ios',
          conversationId: canonical.id,
          text: 'Run until cancelled',
          streamingBehavior: 'followUp',
          resumable: true,
        }),
      );
      let sawAccepted = false;
      while (true) {
        const frame = assertExpectedCapableFrame(await nextFrame(socket), {
          turnId,
          conversationId: canonical.id,
        });
        record(frame);
        if (frame.type === 'accepted') sawAccepted = true;
        if (frame.type === 'event') {
          if (!sawAccepted) throw new Error('Slow turn emitted an event before acceptance');
          return turnId;
        }
        if (frame.type === 'done' || frame.type === 'error') {
          throw new Error('Slow turn reached terminal before its first event checkpoint');
        }
      }
    },

    async close() {
      await Promise.all([...activeSockets].map((socket) => closeSocket(socket)));
    },
  };
}

async function assertCapabilities(harness) {
  const response = await managementFetch(harness, '/mobile/v1/health', {}, false);
  const health = await requiredJson(response, 'mobile health');
  if (health.apiVersion !== 1)
    throw new Error(`Unexpected mobile API version ${health.apiVersion}`);
  return health.capabilities;
}

function canonicalDesktopSummary(value) {
  const { origin: _origin, offline: _offline, readOnly: _readOnly, ...canonical } = value;
  return canonical;
}

export async function refreshBothAndCompare(desktop, ios, conversation) {
  const [desktopItems, iosItems] = await Promise.all([desktop.refresh(), ios.refresh()]);
  const desktopSummary = desktopItems.find((item) => item.id === conversation.id);
  const iosSummary = iosItems.find((item) => item.id === conversation.id);
  if (!desktopSummary || !iosSummary) return false;
  const [desktopMessages, iosMessages] = await Promise.all([
    desktop.messages(conversation),
    ios.messages(conversation),
  ]);
  return (
    JSON.stringify(canonicalDesktopSummary(desktopSummary)) === JSON.stringify(iosSummary) &&
    JSON.stringify(desktopMessages) === JSON.stringify(iosMessages)
  );
}

export async function renameThenSendStaleRevision(desktop, ios, conversation) {
  const stale = await ios.conversation(conversation);
  const current = await desktop.conversation(conversation);
  await desktop.rename(conversation, current.revision, 'Renamed from Mission Control');
  const response = await ios.rename(conversation, stale.revision, 'Stale iOS rename');
  return response.status;
}

export async function runMobileV1Acceptance(options = {}) {
  let streamGateway;
  let desktop;
  let ios;
  let slowGateway;
  let slowDesktop;
  let slowIOS;
  return runWithDeadlineAndCleanup(
    async (signal) => {
      streamGateway = await acquireAcceptanceResource(
        signal,
        startMobileTestHarness({ scenario: 'stream' }),
        (gateway) => gateway.stop(),
      );
      desktop = await acquireAcceptanceResource(
        signal,
        startMissionControlAcceptanceClient(streamGateway),
        (client) => client.close(),
      );
      ios = await acquireAcceptanceResource(signal, openContractClient(streamGateway), (client) =>
        client.close(),
      );
      const healthCapabilities = await assertCapabilities(streamGateway);
      const conversation = await desktop.create(randomUUID());
      const acceptedTurnId = await desktop.send(conversation, randomUUID(), 'Hello');
      const replayedTurnId = await ios.detachAndResume(conversation, acceptedTurnId);
      const [desktopTranscript, iosTranscript] = await Promise.all([
        desktop.messages(conversation),
        ios.messages(conversation),
      ]);
      const concurrentRefreshMatched = await refreshBothAndCompare(desktop, ios, conversation);
      const staleRenameStatus = await renameThenSendStaleRevision(desktop, ios, conversation);
      await desktop.deleteAgent(streamGateway.agentId);
      await Promise.all([desktop.refresh(), ios.refresh()]);
      const [desktopAfterAgentDelete, iosAfterAgentDelete] = await Promise.all([
        desktop.conversation(conversation),
        ios.conversation(conversation),
      ]);
      const archivedAfterAgentDelete =
        desktopAfterAgentDelete.status === 'archived' && iosAfterAgentDelete.status === 'archived';

      slowGateway = await acquireAcceptanceResource(
        signal,
        startMobileTestHarness({ scenario: 'slow' }),
        (gateway) => gateway.stop(),
      );
      slowDesktop = await acquireAcceptanceResource(
        signal,
        startMissionControlAcceptanceClient(slowGateway),
        (client) => client.close(),
      );
      slowIOS = await acquireAcceptanceResource(signal, openContractClient(slowGateway), (client) =>
        client.close(),
      );
      const slowConversation = await slowDesktop.create(randomUUID());
      const slowTurn = await slowIOS.startAndWaitForFirstEvent(slowConversation, randomUUID());
      const busyErrorCode = await slowDesktop.expectBusy(slowConversation, randomUUID());
      const cancelOutcome = await slowDesktop.cancel(slowConversation, slowTurn);
      return {
        healthCapabilities,
        acceptedTurnId,
        replayedTurnId,
        desktopTranscript,
        iosTranscript,
        sequenceWasContiguous: ios.sequenceWasContiguous,
        staleRenameStatus,
        busyErrorCode,
        cancelOutcome,
        concurrentRefreshMatched,
        archivedAfterAgentDelete,
      };
    },
    [
      { label: 'slow iOS-shaped client', run: () => slowIOS?.close() },
      { label: 'slow Mission Control client', run: () => slowDesktop?.close() },
      { label: 'slow gateway', run: () => slowGateway?.stop() },
      { label: 'stream iOS-shaped client', run: () => ios?.close() },
      { label: 'stream Mission Control client', run: () => desktop?.close() },
      { label: 'stream gateway', run: () => streamGateway?.stop() },
    ],
    'mobile v1 acceptance',
    options.timeoutMs ?? 20_000,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await runMobileV1Acceptance();
  console.log(JSON.stringify(report, null, 2));
}
