import { describe, expect, test } from 'vitest';
import { buildIndustrialDiagnosisPromptPlan } from '../container/agent-runner/src/prompt-plan.js';

describe('agent-runner system prompt composition order', () => {
  test('Agent identity leads platform workspace/context material', () => {
    const plan = buildIndustrialDiagnosisPromptPlan({
      platformIdentity: 'IndustrialDiagnosis',
      platformBootstrap: 'first wake',
      agentIdentity: 'identity',
      interaction: 'interaction',
      security: 'security',
      output: 'output',
    });
    expect(plan.blocks.map((block) => block.id)).toEqual([
      'identity.industrial-diagnosis',
      'bootstrap.industrial-diagnosis',
      'agent-profile',
      'interaction',
      'security-rules',
      'output',
    ]);
  });
});
