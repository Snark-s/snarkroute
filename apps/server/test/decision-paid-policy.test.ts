import { describe, expect, it, vi } from 'vitest';
import { createDecisionRuntimeFromEnv } from '../src/services/decision-runtime';

describe('optional decision providers obey local paid policy', () => {
  it('does not probe or shadow an enabled external backend without permission', async () => {
    const fetchImpl = vi.fn();
    const runtime = createDecisionRuntimeFromEnv({ env: {
      APP_MODE: 'local', JEV_ENABLED: 'true', JEV_API_KEY: 'fixture',
      NEEDLE_ENABLED: 'true', NEEDLE_BASE_URL: 'https://external.example',
      DECISION_PRODUCTION_BACKENDS: 'semantic-rules', DECISION_SHADOW_ENABLED: 'true',
      DECISION_SHADOW_BACKENDS: 'jev-main', DECISION_SHADOW_SAMPLE_RATE: '1',
    }, fetch: fetchImpl });
    try {
      await runtime.statuses();
      expect(await runtime.execute({ operation:'classify', input:'code', candidates:[{id:'code',value:'code'}] })).toMatchObject({status:'ok',backend:'semantic-rules'});
      await runtime.executor.drain();
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally { await runtime.close(); }
  });
});
