/**
 * Shutdown hardening helpers. The signal handler in index.ts runs a sequence
 * of stop/close steps; any one of them throwing used to become an unhandled
 * rejection that hard-crashed the process mid-shutdown (skipping the DB
 * closes and the WAL checkpoint). These helpers make each step best-effort:
 * failures are logged (with credentials redacted) and the sequence continues.
 */

/**
 * Redact Telegram bot tokens from a string. grammY network errors embed the
 * full request URL — `https://api.telegram.org/bot<id>:<secret>/getUpdates` —
 * so logging them verbatim leaks the bot token. Keep the numeric bot id
 * (handy for telling bots apart) and strip the secret.
 */
export function redactBotTokens(text: string): string {
  return text.replace(/\bbot(\d+):[A-Za-z0-9_-]+/g, 'bot$1:<redacted>');
}

/** Render an unknown thrown value for logging, with credentials redacted. */
export function describeError(err: unknown): string {
  const raw = err instanceof Error ? (err.stack ?? err.message) : String(err);
  return redactBotTokens(raw);
}

/**
 * Run one shutdown step, logging (never propagating) any failure so the
 * remaining steps — and the final process.exit — always run.
 */
export async function safeStep(label: string, fn: () => unknown): Promise<void> {
  try {
    await fn();
  } catch (err) {
    console.error(`[gateway] shutdown step "${label}" failed (continuing):`, describeError(err));
  }
}

/**
 * Reject with a labeled error if `promise` doesn't settle within `ms`.
 * The timer is cleared on settle so a completed race never keeps the
 * event loop alive.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}

/**
 * How long shutdown waits for a background queue (auto-title, memory sweep) to
 * drain before giving up on it. Each pending job sits in a provider completion
 * with no AbortSignal, so a hung socket would otherwise park shutdown forever
 * and the process would never reach its database closes.
 */
export const FLUSH_TIMEOUT_MS = 5_000;

/**
 * Best-effort, DEADLINE-BOUNDED flush of a background queue: like
 * {@link safeStep}, but a flush that never settles is abandoned (and logged)
 * instead of blocking the rest of the shutdown sequence.
 */
export async function safeFlush(
  label: string,
  flush: () => Promise<void>,
  ms: number = FLUSH_TIMEOUT_MS,
): Promise<void> {
  await safeStep(label, () => withTimeout(Promise.resolve(flush()), ms, label));
}

interface CloseableHttpServer {
  close(callback: (error?: Error) => void): unknown;
  closeAllConnections?(): void;
}

interface SocketLifecycle {
  beginClosing(code: number, reason: string): void;
  flushAndCloseAll(code: number, reason: string, timeoutMs: number): Promise<void>;
}

interface SettledShutdownStep {
  readonly ok: boolean;
  readonly error?: unknown;
}

function settleShutdownStep(promise: Promise<void>): Promise<SettledShutdownStep> {
  return promise.then(
    () => ({ ok: true }),
    (error: unknown) => ({ ok: false, error }),
  );
}

/**
 * Begin Node listener shutdown synchronously, then destroy surviving keep-alive
 * and SSE connections after a short response-flush grace period. The second
 * bound covers embedders whose closeAllConnections implementation cannot
 * trigger the close callback.
 */
export function closeHttpServer(server: CloseableHttpServer, timeoutMs: number): Promise<void> {
  let resolveClose!: () => void;
  let rejectClose!: (error: Error) => void;
  const closed = new Promise<void>((resolve, reject) => {
    resolveClose = resolve;
    rejectClose = reject;
  });

  try {
    server.close((error?: Error) => {
      if (error) rejectClose(error);
      else resolveClose();
    });
  } catch (error) {
    rejectClose(error instanceof Error ? error : new Error(String(error)));
  }

  const fallback = setTimeout(
    () => {
      try {
        server.closeAllConnections?.();
      } catch (error) {
        rejectClose(error instanceof Error ? error : new Error(String(error)));
      }
    },
    Math.max(0, timeoutMs),
  );

  return withTimeout(closed, Math.max(1, timeoutMs * 2), 'HTTP server close').finally(() => {
    clearTimeout(fallback);
  });
}

export interface GatewayShutdownCoordinatorOptions {
  admission: {
    beginProcessShutdown(ownerLease?: import('./admission-controller.js').AdmissionLease): {
      cleanupToken: import('./admission-controller.js').LifecycleCleanupToken;
      drainPrior(): Promise<void>;
      finish(): void;
    };
  };
  relayClient?: { stop(): unknown };
  dialTokenManager?: { stop(): unknown };
  resumableChatHub: { suspend(cleanupToken: unknown): Promise<void> };
  getChatLifecycles(): readonly SocketLifecycle[];
  getProjectsLifecycle(): SocketLifecycle | undefined;
  mcpManager: { stop(): unknown };
  swarmCoordinator: { stop(): unknown };
  agents: { interruptAll(): unknown; stop(): unknown };
  gateway: { stop(): unknown };
  backgroundFlushes?: readonly { label: string; flush(): Promise<void> }[];
  getManagementServer(): CloseableHttpServer | undefined;
  getChannelServer?: () => CloseableHttpServer | undefined;
  getLanServer(): CloseableHttpServer | undefined;
  conversationService: { close(): unknown };
  projectsDb: { close(): unknown };
  timeoutMs?: number;
}

export interface GatewayShutdownCoordinator {
  shutdown(ownerLease?: import('./admission-controller.js').AdmissionLease): GatewayShutdownAttempt;
}

/** Synchronous ownership result plus the one process-wide teardown settlement. */
export interface GatewayShutdownAttempt {
  readonly completion: Promise<void>;
  readonly ownerLeaseTransferred: boolean;
}

/** Owns the single process fence and the complete, idempotent teardown order. */
export function createGatewayShutdownCoordinator(
  options: GatewayShutdownCoordinatorOptions,
): GatewayShutdownCoordinator {
  const timeoutMs = options.timeoutMs ?? FLUSH_TIMEOUT_MS;
  let activeShutdown: Promise<void> | undefined;

  return {
    shutdown(ownerLease) {
      if (activeShutdown) {
        return { completion: activeShutdown, ownerLeaseTransferred: false };
      }

      const lifecycle = options.admission.beginProcessShutdown(ownerLease);
      const chatLifecycles = [...options.getChatLifecycles()];
      const projectsLifecycle = options.getProjectsLifecycle();
      // Upgrades accepted immediately before Server.close may reach onOpen
      // later. Flip every mounted socket lifecycle at the same synchronous
      // process-fence boundary so none can install itself during async teardown.
      for (const chatLifecycle of chatLifecycles) {
        void safeStep('chatWs.beginClosing', () =>
          chatLifecycle.beginClosing(1012, 'gateway_shutdown'),
        );
      }
      if (projectsLifecycle) {
        void safeStep('projectsWs.beginClosing', () =>
          projectsLifecycle.beginClosing(1012, 'gateway_shutdown'),
        );
      }
      // Listener close is deliberately initiated before the first await. This
      // shuts the accept queue at the same synchronous boundary as admission.
      const managementClose = options.getManagementServer();
      const channelClose = options.getChannelServer?.();
      const lanClose = options.getLanServer();
      const listenerBarriers = [
        managementClose
          ? {
              label: 'managementServer.close',
              promise: settleShutdownStep(closeHttpServer(managementClose, timeoutMs)),
            }
          : undefined,
        channelClose
          ? {
              label: 'channelServer.close',
              promise: settleShutdownStep(closeHttpServer(channelClose, timeoutMs)),
            }
          : undefined,
        lanClose
          ? {
              label: 'lanServer.close',
              promise: settleShutdownStep(closeHttpServer(lanClose, timeoutMs)),
            }
          : undefined,
      ].filter(
        (entry): entry is { label: string; promise: Promise<SettledShutdownStep> } =>
          entry !== undefined,
      );

      const completion = (async () => {
        try {
          await safeStep('relayClient.stop', () => options.relayClient?.stop());
          await safeStep('dialTokenManager.stop', () => options.dialTokenManager?.stop());

          // Abort active/preparing backends before hub suspension waits for
          // their definitive Steer seals. Full pool disposal remains after the
          // fixed management drain so admitted maintenance work stays coherent.
          await safeStep('agents.interruptAll', () => options.agents.interruptAll());
          await safeStep('resumableChatHub.suspend', () =>
            options.resumableChatHub.suspend(lifecycle.cleanupToken),
          );

          for (const chatLifecycle of chatLifecycles) {
            await safeStep('chatWs.flushAndCloseAll', () =>
              chatLifecycle.flushAndCloseAll(1012, 'gateway_shutdown', timeoutMs),
            );
          }
          if (projectsLifecycle) {
            await safeStep('projectsWs.flushAndCloseAll', () =>
              projectsLifecycle.flushAndCloseAll(1012, 'gateway_shutdown', timeoutMs),
            );
          }

          await safeStep('admission.drainPrior', () => lifecycle.drainPrior());

          await safeStep('mcpManager.stop', () => options.mcpManager.stop());
          await safeStep('swarmCoordinator.stop', () => options.swarmCoordinator.stop());
          await safeStep('agents.stop', () => options.agents.stop());
          for (const background of options.backgroundFlushes ?? []) {
            await safeFlush(background.label, background.flush, timeoutMs);
          }
          await safeStep('gateway.stop', () => options.gateway.stop());

          for (const barrier of listenerBarriers) {
            await safeStep(barrier.label, async () => {
              const result = await barrier.promise;
              if (!result.ok) throw result.error;
            });
          }

          // Conversation storage is last because hub/swarm/pool teardown may
          // still append terminal records until every earlier barrier settles.
          await safeStep('projectsDb.close', () => options.projectsDb.close());
          await safeStep('conversationService.close', () => options.conversationService.close());
        } finally {
          lifecycle.finish();
        }
      })();
      activeShutdown = completion;
      return { completion, ownerLeaseTransferred: ownerLease !== undefined };
    },
  };
}
