import { describe, it, expect } from 'vitest';
import { planLocalRuntimeAdmission, type LocalRuntimeSnapshot } from '../src/services/local-runtime-supervisor';

const snapshot = (gpu?: LocalRuntimeSnapshot['gpu']): LocalRuntimeSnapshot => ({
  capturedAt: new Date().toISOString(), gpu,
  memory: { totalMiB: 32768, usedMiB: 8192, freeMiB: 24576 },
  pressure: { level: 'idle', summary: '' },
  runtimes: [{ id: 'audit-heavy', label: 'heavy', state: 'stopped', online: false,
    busy: false, resourceClaim: 'none', demand: 'heavy', claimsOnStart: true,
    control: { canStart: true, canStop: false } }],
});

describe('GPU admission never guesses that resources are available', () => {
  it('blocks a heavy start without GPU telemetry', () => {
    expect(planLocalRuntimeAdmission('audit-heavy', snapshot(), 'start').allowed).toBe(false);
  });
  it('requires confirmation when another model holds VRAM', () => {
    const state = snapshot({ name: 'test', totalMiB: 16384, usedMiB: 8192, freeMiB: 8192, utilizationPercent: 0 });
    state.runtimes.push({ ...state.runtimes[0]!, id: 'other', state: 'ready', resourceClaim: 'resident' });
    const decision = planLocalRuntimeAdmission('audit-heavy', state, 'start');
    expect(decision.requiresConfirmation).toBe(true);
    expect(decision.conflictingRuntimeIds).toContain('other');
  });
});
