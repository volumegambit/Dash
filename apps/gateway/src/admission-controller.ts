/**
 * A synchronous, generation-based ingress fence shared by every gateway surface.
 *
 * Captured tokens deliberately remain useful after their lease is released: lower
 * layers use them to detect an agent/process/conversation lifecycle transition
 * that happened while an async factory or storage catch-up was in flight.
 */
export interface AdmissionToken {
  readonly agentId?: string;
  readonly conversationId?: string;
  readonly processGeneration: number;
  readonly agentGeneration: number;
  readonly conversationGeneration: number;
}

/** Stable cross-package reason carried by every lifecycle-aborted operation lease. */
export interface AdmissionAbortReason {
  readonly code: 'gateway_admission_aborted';
  readonly scope: 'agent' | 'process';
  readonly agentId?: string;
  readonly message: string;
}

interface LeaseRecord {
  readonly token: AdmissionToken;
  readonly lifecycleIngress: boolean;
  readonly controller: AbortController;
  readonly settled: Promise<void>;
  settle(): void;
  released: boolean;
}

export interface AdmissionLease {
  readonly token: AdmissionToken;
  readonly signal: AbortSignal;
  release(): void;
}

export interface LifecycleCleanupToken {
  readonly kind: 'agent' | 'process' | 'recovery';
  readonly agentId?: string;
  readonly conversationId?: string;
}

export interface AdmissionLifecycle {
  readonly cleanupToken: LifecycleCleanupToken;
  drainPrior(): Promise<void>;
  finish(): void;
}

interface InternalCleanupToken extends LifecycleCleanupToken {
  readonly owner: GatewayAdmissionController;
}

interface ActiveLifecycleRecord {
  readonly settled: Promise<void>;
  settle(): void;
}

function conversationKey(agentId: string, conversationId: string): string {
  return `${agentId}\u0000${conversationId}`;
}

export class GatewayAdmissionController {
  private processGeneration = 0;
  private processClosed = false;
  private readonly agentGenerations = new Map<string, number>();
  private readonly conversationGenerations = new Map<string, number>();
  private readonly closedAgents = new Set<string>();
  private readonly recoveryRequired = new Set<string>();
  private readonly leases = new Set<LeaseRecord>();
  private readonly agentLifecycles = new Map<string, ActiveLifecycleRecord>();
  private processLifecycle?: ActiveLifecycleRecord;

  capture(agentId?: string, conversationId?: string): AdmissionToken {
    this.assertOpen(agentId, conversationId);
    return this.token(agentId, conversationId);
  }

  acquire(agentId?: string, conversationId?: string): AdmissionLease {
    this.assertOpen(agentId, conversationId);
    return this.createLease(this.token(agentId, conversationId), false);
  }

  /**
   * Agent-scoped maintenance may enter a settled disabled fence so operators
   * can repair or remove persisted state. It remains an ordinary tracked lease:
   * a later disable/delete lifecycle snapshots and drains it, while an already
   * active lifecycle rejects new maintenance synchronously.
   */
  acquireAgentMaintenance(agentId: string): AdmissionLease {
    if (this.processClosed) throw new Error('Gateway is shutting down');
    if (this.agentLifecycles.has(agentId)) {
      throw new Error(`Agent '${agentId}' lifecycle is already in progress`);
    }
    return this.createLease(this.token(agentId), false);
  }

  /** Lifecycle routes are process-admitted but may enter an already-disabled agent fence. */
  acquireLifecycleIngress(agentId?: string): AdmissionLease {
    if (this.processClosed) throw new Error('Gateway is shutting down');
    return this.createLease(this.token(agentId), true);
  }

  isCurrent(token: AdmissionToken): boolean {
    if (this.processClosed || token.processGeneration !== this.processGeneration) return false;
    if (!token.agentId) return true;
    if (this.closedAgents.has(token.agentId)) return false;
    if (token.agentGeneration !== (this.agentGenerations.get(token.agentId) ?? 0)) return false;
    if (!token.conversationId) return true;
    const key = conversationKey(token.agentId, token.conversationId);
    return (
      !this.recoveryRequired.has(key) &&
      token.conversationGeneration === (this.conversationGenerations.get(key) ?? 0)
    );
  }

  /** Generation recheck for a maintenance lease that may validly live inside a disabled fence. */
  isMaintenanceCurrent(token: AdmissionToken): boolean {
    if (this.processClosed || token.processGeneration !== this.processGeneration) return false;
    if (!token.agentId) return true;
    if (token.agentGeneration !== (this.agentGenerations.get(token.agentId) ?? 0)) return false;
    if (!token.conversationId) return true;
    const key = conversationKey(token.agentId, token.conversationId);
    return token.conversationGeneration === (this.conversationGenerations.get(key) ?? 0);
  }

  isOpen(agentId?: string, conversationId?: string): boolean {
    if (this.processClosed) return false;
    if (!agentId) return true;
    if (this.closedAgents.has(agentId)) return false;
    return !conversationId || !this.recoveryRequired.has(conversationKey(agentId, conversationId));
  }

  closeAgent(agentId: string): void {
    this.closedAgents.add(agentId);
    this.agentGenerations.set(agentId, (this.agentGenerations.get(agentId) ?? 0) + 1);
  }

  allowAgent(agentId: string): void {
    this.agentGenerations.set(agentId, (this.agentGenerations.get(agentId) ?? 0) + 1);
    this.closedAgents.delete(agentId);
  }

  closeAll(): void {
    if (this.processClosed) return;
    this.processClosed = true;
    this.processGeneration++;
  }

  beginAgentLifecycle(agentId: string, ownerLease?: AdmissionLease): AdmissionLifecycle {
    if (this.processClosed) throw new Error('Gateway is shutting down');
    if (this.agentLifecycles.has(agentId)) {
      throw new Error(`Agent '${agentId}' lifecycle is already in progress`);
    }
    const owner = this.transferOwner(ownerLease);
    this.closeAgent(agentId);
    const prior = [...this.leases].filter(
      (record) => !record.lifecycleIngress && record.token.agentId === agentId,
    );
    this.abortOrdinaryLeases(prior, {
      code: 'gateway_admission_aborted',
      scope: 'agent',
      agentId,
      message: `Agent '${agentId}' lifecycle started`,
    });
    const active = this.createActiveLifecycle();
    this.agentLifecycles.set(agentId, active);
    return this.lifecycle(
      { kind: 'agent', agentId, owner: this },
      prior.map((record) => record.settled),
      owner,
      () => {
        if (this.agentLifecycles.get(agentId) === active) {
          this.agentLifecycles.delete(agentId);
        }
        active.settle();
      },
    );
  }

  beginProcessShutdown(ownerLease?: AdmissionLease): AdmissionLifecycle {
    if (this.processLifecycle) throw new Error('Gateway shutdown is already in progress');
    if (this.processClosed) throw new Error('Gateway is shutting down');
    const owner = this.transferOwner(ownerLease);
    this.closeAll();
    const active = this.createActiveLifecycle();
    this.processLifecycle = active;
    const priorLeases = [...this.leases];
    const prior = [
      ...priorLeases.map((record) => record.settled),
      ...[...this.agentLifecycles.values()].map((record) => record.settled),
    ];
    this.abortOrdinaryLeases(priorLeases, {
      code: 'gateway_admission_aborted',
      scope: 'process',
      message: 'Gateway shutdown started',
    });
    return this.lifecycle({ kind: 'process', owner: this }, prior, owner, () => active.settle());
  }

  markRecoveryRequired(agentId: string, conversationId: string): void {
    const key = conversationKey(agentId, conversationId);
    if (this.recoveryRequired.has(key)) return;
    this.recoveryRequired.add(key);
    this.conversationGenerations.set(key, (this.conversationGenerations.get(key) ?? 0) + 1);
  }

  beginRecoveryCleanup(agentId: string, conversationId: string): LifecycleCleanupToken {
    return { kind: 'recovery', agentId, conversationId, owner: this } as InternalCleanupToken;
  }

  clearRecoveryRequired(
    agentId: string,
    conversationId: string,
    cleanupToken: LifecycleCleanupToken,
  ): void {
    const internal = cleanupToken as InternalCleanupToken;
    if (
      internal.owner !== this ||
      internal.kind !== 'recovery' ||
      internal.agentId !== agentId ||
      internal.conversationId !== conversationId
    ) {
      throw new Error('Recovery-required admission may only be cleared by recovery cleanup');
    }
    const key = conversationKey(agentId, conversationId);
    if (!this.recoveryRequired.delete(key)) return;
    this.conversationGenerations.set(key, (this.conversationGenerations.get(key) ?? 0) + 1);
  }

  assertCleanupToken(
    token: LifecycleCleanupToken,
    kind: LifecycleCleanupToken['kind'],
    agentId?: string,
  ): void {
    const internal = token as InternalCleanupToken;
    if (internal.owner !== this || internal.kind !== kind) {
      throw new Error(`Invalid ${kind} lifecycle cleanup token`);
    }
    if (agentId !== undefined && internal.agentId !== agentId) {
      throw new Error(`Invalid ${kind} lifecycle cleanup token`);
    }
  }

  private assertOpen(agentId?: string, conversationId?: string): void {
    if (this.processClosed) throw new Error('Gateway is shutting down');
    if (!agentId) return;
    if (this.closedAgents.has(agentId)) throw new Error(`Agent '${agentId}' is disabled`);
    if (conversationId && this.recoveryRequired.has(conversationKey(agentId, conversationId))) {
      throw new Error(`Conversation '${conversationId}' requires recovery`);
    }
  }

  private token(agentId?: string, conversationId?: string): AdmissionToken {
    const key = agentId && conversationId ? conversationKey(agentId, conversationId) : undefined;
    return {
      agentId,
      conversationId,
      processGeneration: this.processGeneration,
      agentGeneration: agentId ? (this.agentGenerations.get(agentId) ?? 0) : 0,
      conversationGeneration: key ? (this.conversationGenerations.get(key) ?? 0) : 0,
    };
  }

  private createLease(token: AdmissionToken, lifecycleIngress: boolean): AdmissionLease {
    const controller = new AbortController();
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const record: LeaseRecord = {
      token,
      lifecycleIngress,
      controller,
      settled,
      settle,
      released: false,
    };
    this.leases.add(record);
    return {
      token,
      signal: controller.signal,
      release: () => this.releaseRecord(record),
    };
  }

  private abortOrdinaryLeases(records: readonly LeaseRecord[], reason: AdmissionAbortReason): void {
    for (const record of records) {
      if (!record.lifecycleIngress && !record.released) record.controller.abort(reason);
    }
  }

  private transferOwner(ownerLease?: AdmissionLease): AdmissionLease | undefined {
    if (!ownerLease) return undefined;
    const record = [...this.leases].find(
      (candidate) => candidate.token === ownerLease.token && candidate.lifecycleIngress,
    );
    if (!record || record.released) throw new Error('Lifecycle ingress lease is not active');
    this.leases.delete(record);
    return ownerLease;
  }

  private lifecycle(
    cleanupToken: InternalCleanupToken,
    prior: Promise<void>[],
    owner?: AdmissionLease,
    onFinish?: () => void,
  ): AdmissionLifecycle {
    let finished = false;
    return {
      cleanupToken,
      drainPrior: async () => {
        await Promise.all(prior);
      },
      finish: () => {
        if (finished) return;
        finished = true;
        onFinish?.();
        owner?.release();
      },
    };
  }

  private createActiveLifecycle(): ActiveLifecycleRecord {
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    return { settled, settle };
  }

  private releaseRecord(record: LeaseRecord): void {
    if (record.released) return;
    record.released = true;
    this.leases.delete(record);
    record.settle();
  }
}
