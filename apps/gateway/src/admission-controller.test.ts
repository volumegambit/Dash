import { describe, expect, it } from 'vitest';
import { GatewayAdmissionController } from './admission-controller.js';

describe('GatewayAdmissionController', () => {
  it('closes process admission synchronously and drains only the pre-close leases', async () => {
    const admission = new GatewayAdmissionController();
    const first = admission.acquire('agent-a', 'conversation-a');
    const token = first.token;

    const lifecycle = admission.beginProcessShutdown();

    expect(admission.isOpen('agent-a', 'conversation-a')).toBe(false);
    expect(first.signal.aborted).toBe(true);
    expect(admission.isCurrent(token)).toBe(false);
    expect(() => admission.acquire('agent-b', 'conversation-b')).toThrow('shutting down');

    let drained = false;
    const draining = lifecycle.drainPrior().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    first.release();
    await draining;
    lifecycle.finish();
  });

  it('closes one agent without closing an unaffected sibling and re-enable gets a new generation', () => {
    const admission = new GatewayAdmissionController();
    const old = admission.capture('agent-a', 'conversation-a');

    const lifecycle = admission.beginAgentLifecycle('agent-a');

    expect(admission.isOpen('agent-a', 'conversation-a')).toBe(false);
    expect(admission.isOpen('agent-b', 'conversation-b')).toBe(true);
    expect(admission.isCurrent(old)).toBe(false);
    expect(() => admission.acquire('agent-a', 'conversation-a')).toThrow('disabled');
    expect(() => admission.acquire('agent-b', 'conversation-b')).not.toThrow();

    lifecycle.finish();
    admission.allowAgent('agent-a');
    expect(admission.isOpen('agent-a', 'conversation-a')).toBe(true);
    expect(admission.isCurrent(old)).toBe(false);
  });

  it('aborts only matching ordinary leases when an agent lifecycle starts', () => {
    const admission = new GatewayAdmissionController();
    const matching = admission.acquire('agent-a', 'conversation-a');
    const maintenance = admission.acquireAgentMaintenance('agent-a');
    const sibling = admission.acquire('agent-b', 'conversation-b');
    const lifecycleIngress = admission.acquireLifecycleIngress('agent-a');

    const lifecycle = admission.beginAgentLifecycle('agent-a');

    expect(matching.signal.aborted).toBe(true);
    expect(matching.signal.reason).toEqual({
      code: 'gateway_admission_aborted',
      scope: 'agent',
      agentId: 'agent-a',
      message: "Agent 'agent-a' lifecycle started",
    });
    expect(maintenance.signal.aborted).toBe(true);
    expect(sibling.signal.aborted).toBe(false);
    expect(lifecycleIngress.signal.aborted).toBe(false);

    matching.release();
    maintenance.release();
    sibling.release();
    lifecycleIngress.release();
    lifecycle.finish();
  });

  it('publishes a stable process-scoped reason when shutdown aborts ordinary leases', () => {
    const admission = new GatewayAdmissionController();
    const lease = admission.acquire('agent-a', 'conversation-a');

    const lifecycle = admission.beginProcessShutdown();

    expect(lease.signal.reason).toEqual({
      code: 'gateway_admission_aborted',
      scope: 'process',
      message: 'Gateway shutdown started',
    });
    lease.release();
    lifecycle.finish();
  });

  it('transfers a lifecycle ingress lease instead of draining itself', async () => {
    const admission = new GatewayAdmissionController();
    const earlier = admission.acquire('agent-a', 'conversation-a');
    const ingress = admission.acquireLifecycleIngress();

    const lifecycle = admission.beginAgentLifecycle('agent-a', ingress);
    const draining = lifecycle.drainPrior();

    let drained = false;
    void draining.then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    earlier.release();
    await draining;
    lifecycle.finish();
  });

  it('lets lifecycle ingress enter a disabled fence but not a closed process', () => {
    const admission = new GatewayAdmissionController();
    admission.closeAgent('agent-a');

    expect(() => admission.acquireLifecycleIngress()).not.toThrow();
    admission.beginProcessShutdown().finish();
    expect(() => admission.acquireLifecycleIngress()).toThrow('shutting down');
  });

  it('admits disabled-agent maintenance only between lifecycles and drains it on deletion', async () => {
    const admission = new GatewayAdmissionController();
    const disable = admission.beginAgentLifecycle('agent-a');

    expect(() => admission.acquireAgentMaintenance('agent-a')).toThrow('lifecycle');
    disable.finish();
    const maintenance = admission.acquireAgentMaintenance('agent-a');
    expect(admission.isMaintenanceCurrent(maintenance.token)).toBe(true);
    const deletion = admission.beginAgentLifecycle('agent-a');
    expect(admission.isMaintenanceCurrent(maintenance.token)).toBe(false);
    let drained = false;
    const draining = deletion.drainPrior().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    expect(() => admission.acquireAgentMaintenance('agent-a')).toThrow('lifecycle');

    maintenance.release();
    await draining;
    deletion.finish();
  });

  it('rejects agent maintenance after the process fence', () => {
    const admission = new GatewayAdmissionController();
    admission.closeAgent('agent-a');
    admission.beginProcessShutdown().finish();

    expect(() => admission.acquireAgentMaintenance('agent-a')).toThrow('shutting down');
  });

  it('quarantines only the failed conversation and only recovery cleanup can clear it', () => {
    const admission = new GatewayAdmissionController();
    const stale = admission.capture('agent-a', 'conversation-bad');

    admission.markRecoveryRequired('agent-a', 'conversation-bad');

    expect(admission.isOpen('agent-a', 'conversation-bad')).toBe(false);
    expect(admission.isOpen('agent-a', 'conversation-ok')).toBe(true);
    expect(admission.isCurrent(stale)).toBe(false);
    const lifecycle = admission.beginAgentLifecycle('agent-a');
    expect(() =>
      admission.clearRecoveryRequired('agent-a', 'conversation-bad', lifecycle.cleanupToken),
    ).toThrow('recovery cleanup');
    lifecycle.finish();

    admission.allowAgent('agent-a');
    const recovery = admission.beginRecoveryCleanup('agent-a', 'conversation-bad');
    admission.clearRecoveryRequired('agent-a', 'conversation-bad', recovery);
    expect(admission.isOpen('agent-a', 'conversation-bad')).toBe(true);
  });

  it('rejects duplicate and nested lifecycle ownership instead of snapshotting lifecycle ingress', async () => {
    const admission = new GatewayAdmissionController();
    const firstIngress = admission.acquireLifecycleIngress('agent-a');
    const duplicateIngress = admission.acquireLifecycleIngress('agent-a');
    const nestedIngress = admission.acquireLifecycleIngress('agent-b');
    const first = admission.beginAgentLifecycle('agent-a', firstIngress);

    expect(() => admission.beginAgentLifecycle('agent-a', duplicateIngress)).toThrow(
      'already in progress',
    );

    const shutdownIngress = admission.acquireLifecycleIngress();
    const shutdown = admission.beginProcessShutdown(shutdownIngress);
    expect(() => admission.beginAgentLifecycle('agent-b', nestedIngress)).toThrow('shutting down');

    let drained = false;
    const draining = shutdown.drainPrior().then(() => {
      drained = true;
    });
    duplicateIngress.release();
    nestedIngress.release();
    await Promise.resolve();
    expect(drained).toBe(false);

    first.finish();
    await draining;
    shutdown.finish();
  });

  it('rejects a duplicate process lifecycle and excludes only the owning ingress lease', async () => {
    const admission = new GatewayAdmissionController();
    const earlierIngress = admission.acquireLifecycleIngress();
    const ownerIngress = admission.acquireLifecycleIngress();
    const duplicateIngress = admission.acquireLifecycleIngress();

    const shutdown = admission.beginProcessShutdown(ownerIngress);
    expect(() => admission.beginProcessShutdown(duplicateIngress)).toThrow('already in progress');

    let drained = false;
    const draining = shutdown.drainPrior().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    earlierIngress.release();
    duplicateIngress.release();
    await draining;
    shutdown.finish();
  });
});
