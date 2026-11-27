import test from 'node:test';
import assert from 'node:assert/strict';
import { extractModelSteps } from '../trajectory-metrics.mjs';
import { normalizeFullSettings } from '../backend/settings-schema.mjs';
import { normalizeEnableChatTurnSummary } from '../shared/settings-normalization.mjs';
import { backendHarness } from './backend-harness.mjs';

function makeUserStep(text, isoTime) {
  return {
    type: 'CORTEX_STEP_TYPE_USER_INPUT',
    status: 'CORTEX_STEP_STATUS_DONE',
    userInput: { userResponse: text },
    metadata: { createdAt: isoTime },
  };
}

function makePlannerStep({
  stepIndex,
  createdAt,
  durationSec = 4,
  model = 'MODEL_PLACEHOLDER_M429',
  responseModel = '',
  modelDisplayName = '',
  inputTokens = 1000,
  cacheReadTokens = 2000,
  thinkingTokens = 100,
  responseTokens = 300,
  outputTokens = thinkingTokens + responseTokens,
  status = 'CORTEX_STEP_STATUS_DONE',
  responseText = 'Answer text',
  planModel = '',
  executionModel = '',
  isCompaction = false,
}) {
  const startMs = Date.parse(createdAt);
  const endIso = new Date(startMs + durationSec * 1000).toISOString();
  const gm = [];
  if (responseModel || modelDisplayName || planModel || executionModel) {
    gm.push({
      stepIndices: [stepIndex],
      ...(planModel || executionModel
        ? {
            plannerConfig: {
              ...(planModel ? { planModel } : {}),
              ...(executionModel ? { planExecuteConfig: { executionModel } } : {}),
            },
          }
        : {}),
      ...(responseModel || modelDisplayName
        ? {
            chatModel: {
              ...(responseModel ? { responseModel } : {}),
              ...(modelDisplayName ? { modelDisplayName } : {}),
              chatStartMetadata: {
                contextWindowMetadata: {
                  estimatedTokensUsed: inputTokens + cacheReadTokens,
                  maxContextTokens: 256000,
                },
              },
            },
          }
        : {}),
    });
  }
  return {
    type: isCompaction ? 'CORTEX_STEP_TYPE_CHECKPOINT' : 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
    status,
    plannerResponse: {
      response: responseText,
      thinkingTokens,
      responseTokens,
    },
    metadata: {
      createdAt,
      finishedGeneratingAt: endIso,
      sourceTrajectoryStepInfo: { stepIndex },
      modelUsage: {
        model,
        apiProvider: 'API_PROVIDER_GOOGLE_GEMINI',
        inputTokens: String(inputTokens),
        cacheReadTokens: String(cacheReadTokens),
        outputTokens: String(outputTokens),
        thinkingOutputTokens: String(thinkingTokens),
        responseOutputTokens: String(responseTokens),
      },
      ...(gm.length > 0 ? { generatorMetadata: gm } : {}),
    },
  };
}

test('extractModelSteps tags orchestratorRole for orchestrator planner and Hydrogen/Neon/Claude implementors', () => {
  const steps = [
    makeUserStep('Build feature X', '2026-11-20T10:00:00Z'),
    makePlannerStep({
      stepIndex: 1,
      createdAt: '2026-11-20T10:00:01Z',
      model: 'MODEL_PLACEHOLDER_M667',
      responseModel: 'gemini-pro-orchestrator',
      modelDisplayName: 'Orchestrator (Carbon)',
      planModel: 'MODEL_PLACEHOLDER_M667',
      executionModel: 'MODEL_PLACEHOLDER_M999',
    }),
    makePlannerStep({
      stepIndex: 2,
      createdAt: '2026-11-20T10:00:06Z',
      model: 'MODEL_PLACEHOLDER_M669',
      responseModel: 'gemini-flash-worker-agy',
      modelDisplayName: 'Orchestrator (Carbon)',
    }),
    makePlannerStep({
      stepIndex: 3,
      createdAt: '2026-11-20T10:00:11Z',
      model: 'MODEL_PLACEHOLDER_M535',
      responseModel: 'gemini-4-neon-worker-agy',
      modelDisplayName: 'Orchestrator (Neon)',
    }),
    makePlannerStep({
      stepIndex: 4,
      createdAt: '2026-11-20T10:00:16Z',
      model: 'MODEL_PLACEHOLDER_M999',
      responseModel: 'claude-sonnet-4-6',
      modelDisplayName: 'Orchestrator (Carbon)',
    }),
    makeUserStep('Simple question', '2026-11-20T10:01:00Z'),
    makePlannerStep({
      stepIndex: 6,
      createdAt: '2026-11-20T10:01:01Z',
      model: 'MODEL_PLACEHOLDER_M429',
      responseModel: 'gemini-4-carbon',
      modelDisplayName: 'Gemini 4 Carbon',
    }),
  ];

  const extracted = extractModelSteps(steps, []);
  assert.equal(extracted.length, 5);
  assert.equal(extracted[0].orchestratorRole, 'orchestrator');
  assert.equal(extracted[1].orchestratorRole, 'implementor');
  assert.equal(extracted[2].orchestratorRole, 'implementor');
  assert.equal(extracted[3].orchestratorRole, 'implementor');
  assert.equal(extracted[4].orchestratorRole, null);
  assert.equal(extracted[0].hasVisibleText, true);
});

test('Backend turnSummaries: Orchestrator vs Implementor split, ctx/think/reply breakdown, and /api/telemetry projection', async () => {
  const rootCid = '11111111-1111-4111-8111-111111111111';
  const baseMs = Date.parse('2026-11-20T12:00:00Z');
  const iso = (sec) => new Date(baseMs + sec * 1000).toISOString();

  const trajectories = {
    [rootCid]: {
      trajectory: {
        steps: [
          makeUserStep('Implement orchestrator summary', iso(0)),
          makePlannerStep({
            stepIndex: 1,
            createdAt: iso(1),
            durationSec: 5,
            model: 'MODEL_PLACEHOLDER_M667',
            responseModel: 'gemini-pro-orchestrator',
            modelDisplayName: 'Orchestrator (Carbon)',
            planModel: 'MODEL_PLACEHOLDER_M667',
            executionModel: 'MODEL_PLACEHOLDER_M669',
            inputTokens: 2000,
            cacheReadTokens: 8000,
            thinkingTokens: 400,
            responseTokens: 100,
          }),
          makePlannerStep({
            stepIndex: 2,
            createdAt: iso(7),
            durationSec: 4,
            model: 'MODEL_PLACEHOLDER_M669',
            responseModel: 'gemini-flash-worker-agy',
            modelDisplayName: 'Orchestrator Worker (Hydrogen)',
            inputTokens: 1000,
            cacheReadTokens: 11000,
            thinkingTokens: 50,
            responseTokens: 350,
          }),
          makePlannerStep({
            stepIndex: 3,
            createdAt: iso(12),
            durationSec: 6,
            model: 'MODEL_PLACEHOLDER_M669',
            responseModel: 'gemini-flash-worker-agy',
            modelDisplayName: 'Orchestrator Worker (Hydrogen)',
            inputTokens: 1500,
            cacheReadTokens: 13500,
            thinkingTokens: 100,
            responseTokens: 500,
          }),
          // Compaction step should not count toward completedSteps/totalSteps percentages
          makePlannerStep({
            stepIndex: 4,
            createdAt: iso(19),
            durationSec: 2,
            model: 'MODEL_PLACEHOLDER_M667',
            responseModel: 'gemini-pro-orchestrator',
            isCompaction: true,
            inputTokens: 500,
            cacheReadTokens: 1000,
            thinkingTokens: 0,
            responseTokens: 200,
          }),
        ],
      },
    },
  };

  const summaries = {
    [rootCid]: {
      title: 'Orchestrator Test',
      stepCount: 5,
      status: 'IDLE',
      lastModifiedTime: iso(21),
    },
  };

  const harness = backendHarness({ trajectories, summaries, activeConvId: rootCid });
  const res = await harness.executeTelemetryAction({ conversationId: rootCid });
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  const ac = body.activeConversation;

  assert.equal(body.settings.enableChatTurnSummary, true);
  assert.equal(ac.turnSummaries.length, 1);

  const turn = ac.turnSummaries[0];
  assert.equal(turn.turnIndex, 1);
  assert.equal(turn.turnPromptClean, 'Implement orchestrator summary');
  assert.equal(turn.isLatestTurn, true);
  assert.equal(turn.isRunning, false);
  assert.equal(turn.mode, 'orchestrator');
  assert.equal(turn.totalCompletedSteps, 3);
  assert.equal(turn.totalSteps, 3);

  assert.equal(turn.totals.ctx, 15600);
  assert.equal(turn.totals.think, 550);
  assert.equal(turn.totals.reply, 1150);
  assert.equal(turn.totals.outputTokens, 1700);
  assert.equal(turn.totals.durationSec, 15);
  assert.equal(turn.totals.tokPerSec, 100); // (500+400+600) / (5+4+6) = 1500 / 15

  assert.ok(turn.orchestratorBreakdown);
  assert.equal(turn.orchestratorBreakdown.orchestrator.completedSteps, 1);
  assert.equal(turn.orchestratorBreakdown.orchestrator.pct, 33);
  assert.equal(turn.orchestratorBreakdown.orchestrator.think, 400);
  assert.equal(turn.orchestratorBreakdown.implementor.completedSteps, 2);
  assert.equal(turn.orchestratorBreakdown.implementor.pct, 67);
  assert.equal(turn.orchestratorBreakdown.implementor.reply, 850);
  assert.equal(
    turn.orchestratorBreakdown.orchestrator.pct + turn.orchestratorBreakdown.implementor.pct,
    100
  );

  // Verify projected step fields in recentSteps
  assert.equal(ac.recentSteps[1].orchestratorRole, 'implementor');
  assert.equal(ac.recentSteps[1].hasVisibleText, true);
});

test('Backend turnSummaries: Swarm mode multi-agent breakdown with coordinator, workers, auxiliary monitor, and multi-turn isolation', async () => {
  const rootCid = '22222222-2222-4222-8222-222222222222';
  const worker1Cid = '33333333-3333-4333-8333-333333333333';
  const worker2Cid = '44444444-4444-4444-8444-444444444444';
  const monitorCid = '55555555-5555-4555-8555-555555555555';
  const baseMs = Date.parse('2026-11-20T14:00:00Z');
  const iso = (sec) => new Date(baseMs + sec * 1000).toISOString();

  const trajectories = {
    [rootCid]: {
      trajectory: {
        steps: [
          makeUserStep('Turn 1 single question', iso(0)),
          makePlannerStep({
            stepIndex: 1,
            createdAt: iso(2),
            durationSec: 2,
            model: 'MODEL_PLACEHOLDER_M429',
            inputTokens: 500,
            cacheReadTokens: 0,
            thinkingTokens: 40,
            responseTokens: 160,
          }),
          makeUserStep('Turn 2 swarm audit', iso(20)),
          makePlannerStep({
            stepIndex: 3,
            createdAt: iso(22),
            durationSec: 4,
            model: 'MODEL_PLACEHOLDER_M429',
            inputTokens: 1000,
            cacheReadTokens: 2000,
            thinkingTokens: 100,
            responseTokens: 300,
          }),
        ],
      },
    },
    [worker1Cid]: {
      trajectory: {
        steps: [
          makePlannerStep({
            stepIndex: 1,
            createdAt: iso(25),
            durationSec: 5,
            model: 'MODEL_PLACEHOLDER_M429',
            inputTokens: 800,
            cacheReadTokens: 1200,
            thinkingTokens: 80,
            responseTokens: 420,
          }),
          makePlannerStep({
            stepIndex: 2,
            createdAt: iso(31),
            durationSec: 5,
            model: 'MODEL_PLACEHOLDER_M429',
            inputTokens: 900,
            cacheReadTokens: 1500,
            thinkingTokens: 60,
            responseTokens: 440,
          }),
        ],
      },
    },
    [worker2Cid]: {
      trajectory: {
        steps: [
          makePlannerStep({
            stepIndex: 1,
            createdAt: iso(26),
            durationSec: 4,
            model: 'MODEL_PLACEHOLDER_M429',
            inputTokens: 700,
            cacheReadTokens: 1000,
            thinkingTokens: 50,
            responseTokens: 250,
          }),
        ],
      },
    },
    [monitorCid]: {
      trajectory: {
        steps: [
          makePlannerStep({
            stepIndex: 1,
            createdAt: iso(28),
            durationSec: 2,
            model: 'MODEL_PLACEHOLDER_M429',
            inputTokens: 400,
            cacheReadTokens: 400,
            thinkingTokens: 10,
            responseTokens: 90,
          }),
        ],
      },
    },
  };

  const summaries = {
    [rootCid]: {
      title: 'Swarm Audit',
      stepCount: 4,
      status: 'IDLE',
      lastModifiedTime: iso(36),
    },
    [worker1Cid]: {
      title: 'Worker Alpha',
      stepCount: 2,
      status: 'IDLE',
      lastModifiedTime: iso(36),
      trajectoryMetadata: {
        parentConversationId: rootCid,
        subagentSpec: { typeName: 'worker', role: 'Swarm Worker (alpha)' },
      },
    },
    [worker2Cid]: {
      title: 'Worker Beta',
      stepCount: 1,
      status: 'IDLE',
      lastModifiedTime: iso(30),
      trajectoryMetadata: {
        parentConversationId: rootCid,
        subagentSpec: { typeName: 'worker', role: 'Swarm Worker (beta)' },
      },
    },
    [monitorCid]: {
      title: 'Monitor',
      stepCount: 1,
      status: 'IDLE',
      lastModifiedTime: iso(30),
      trajectoryMetadata: {
        parentConversationId: rootCid,
        subagentSpec: { typeName: 'worker', role: 'Swarm Worker (monitor)' },
      },
    },
  };

  const harness = backendHarness({ trajectories, summaries, activeConvId: rootCid });
  const res = await harness.executeTelemetryAction({ conversationId: rootCid });
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  const turns = body.activeConversation.turnSummaries;

  assert.equal(turns.length, 2);

  // Turn 1 isolated single-agent turn
  assert.equal(turns[0].turnIndex, 1);
  assert.equal(turns[0].turnPromptClean, 'Turn 1 single question');
  assert.equal(turns[0].mode, 'single');
  assert.equal(turns[0].isLatestTurn, false);
  assert.equal(turns[0].orchestratorBreakdown, null);
  assert.equal(turns[0].agentBreakdown.length, 1);
  assert.equal(turns[0].agentBreakdown[0].pct, 100);

  // Turn 2 swarm turn
  const t2 = turns[1];
  assert.equal(t2.turnIndex, 2);
  assert.equal(t2.turnPromptClean, 'Turn 2 swarm audit');
  assert.equal(t2.mode, 'swarm');
  assert.equal(t2.isLatestTurn, true);
  assert.equal(t2.totalCompletedSteps, 5);
  assert.equal(t2.agentBreakdown.length, 4);
  // Main first, then non-aux sorted by completedSteps desc, then auxiliary monitor last
  assert.equal(t2.agentBreakdown[0].isMain, true);
  assert.equal(t2.agentBreakdown[0].pct, 25);
  assert.equal(t2.agentBreakdown[1].role, '@alpha');
  assert.equal(t2.agentBreakdown[1].completedSteps, 2);
  assert.equal(t2.agentBreakdown[1].pct, 50);
  assert.equal(t2.agentBreakdown[2].role, '@beta');
  assert.equal(t2.agentBreakdown[2].completedSteps, 1);
  assert.equal(t2.agentBreakdown[2].pct, 25);
  assert.equal(t2.agentBreakdown[3].role, '@monitor');
  assert.equal(t2.agentBreakdown[3].isAuxiliary, true);
  assert.equal(t2.agentBreakdown[3].pct, 0);
});

test('Backend turnSummaries: Subagent mode (invoke_subagent) and enableChatTurnSummary setting', async () => {
  assert.equal(normalizeEnableChatTurnSummary(undefined), true);
  assert.equal(normalizeEnableChatTurnSummary('false'), false);
  assert.equal(normalizeEnableChatTurnSummary('off'), false);
  assert.equal(normalizeEnableChatTurnSummary(false), false);
  assert.equal(normalizeEnableChatTurnSummary('true'), true);
  assert.equal(normalizeFullSettings({}).enableChatTurnSummary, true);
  assert.equal(normalizeFullSettings({ enableChatTurnSummary: false }).enableChatTurnSummary, false);

  const rootCid = '66666666-6666-4666-8666-666666666666';
  const subCid = '77777777-7777-4777-8777-777777777777';
  const baseMs = Date.parse('2026-11-20T16:00:00Z');
  const iso = (sec) => new Date(baseMs + sec * 1000).toISOString();

  const trajectories = {
    [rootCid]: {
      trajectory: {
        steps: [
          makeUserStep('Delegate analysis to subagent', iso(0)),
          makePlannerStep({
            stepIndex: 1,
            createdAt: iso(1),
            durationSec: 3,
            model: 'MODEL_PLACEHOLDER_M429',
            inputTokens: 1000,
            cacheReadTokens: 0,
            thinkingTokens: 50,
            responseTokens: 150,
          }),
        ],
      },
    },
    [subCid]: {
      trajectory: {
        steps: [
          makePlannerStep({
            stepIndex: 1,
            createdAt: iso(5),
            durationSec: 4,
            model: 'MODEL_PLACEHOLDER_M429',
            inputTokens: 600,
            cacheReadTokens: 400,
            thinkingTokens: 20,
            responseTokens: 180,
          }),
        ],
      },
    },
  };

  const summaries = {
    [rootCid]: {
      title: 'Subagent Test',
      stepCount: 2,
      status: 'IDLE',
      lastModifiedTime: iso(10),
    },
    [subCid]: {
      title: 'Researcher Subagent',
      stepCount: 1,
      status: 'IDLE',
      lastModifiedTime: iso(9),
      trajectoryMetadata: {
        parentConversationId: rootCid,
        subagentSpec: { typeName: 'researcher', role: 'Code Researcher' },
      },
    },
  };

  const harness = backendHarness({ trajectories, summaries, activeConvId: rootCid });
  const saveRes = await harness.executeSettingsAction({ enableChatTurnSummary: false });
  assert.equal(saveRes.status, 200);

  const telRes = await harness.executeTelemetryAction({ conversationId: rootCid });
  assert.equal(telRes.status, 200);
  const body = JSON.parse(telRes.body);
  assert.equal(body.settings.enableChatTurnSummary, false);
  const turn = body.activeConversation.turnSummaries[0];
  assert.equal(turn.mode, 'subagent');
  assert.equal(turn.agentBreakdown.length, 2);
  assert.equal(turn.agentBreakdown[0].pct, 50);
  assert.equal(turn.agentBreakdown[1].pct, 50);
  assert.equal(turn.agentBreakdown[1].agentKind, 'subagent');
  assert.equal(turn.agentBreakdown[1].role, 'Code Researcher');
});

test('extractModelSteps preserves orchestrator/implementor roles across exit_plan_mode handoffs even when generatorMetadata omits plannerConfig', () => {
  const steps = [
    // Turn 1: Planner-only turn (M532)
    makeUserStep('Explain setup', '2026-11-25T20:00:00Z'),
    makePlannerStep({
      stepIndex: 1,
      createdAt: '2026-11-25T20:00:01Z',
      model: 'MODEL_PLACEHOLDER_M532',
      modelDisplayName: 'Gemini 4 Neon (High)',
    }),
    // Turn 2: Planner (M532) hands off via exit_plan_mode -> SystemMessage -> Implementor (M525)
    makeUserStep('Test handoff', '2026-11-25T20:01:00Z'),
    {
      type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
      status: 'CORTEX_STEP_TYPE_DONE',
      plannerResponse: {
        toolCalls: [{ name: 'exit_plan_mode' }],
        thinkingTokens: 100,
        responseTokens: 50,
      },
      metadata: {
        createdAt: '2026-11-25T20:01:01Z',
        finishedGeneratingAt: '2026-11-25T20:01:03Z',
        sourceTrajectoryStepInfo: { stepIndex: 3 },
        generatorModel: 'MODEL_PLACEHOLDER_M532',
        modelUsage: {
          model: 'MODEL_PLACEHOLDER_M532',
          inputTokens: 1000,
          cacheReadTokens: 5000,
          outputTokens: 150,
        },
      },
    },
    {
      type: 'CORTEX_STEP_TYPE_SYSTEM_MESSAGE',
      status: 'CORTEX_STEP_STATUS_DONE',
      systemMessage: {
        message: 'Plan mode is off: this turn runs on the execution model.',
      },
    },
    makePlannerStep({
      stepIndex: 5,
      createdAt: '2026-11-25T20:01:05Z',
      model: 'MODEL_PLACEHOLDER_M525',
      modelDisplayName: 'Gemini 4 Hydrogen (High)',
    }),
    // Turn 3: Same-model handoff (both Planner and Implementor use M532)
    makeUserStep('Same model handoff', '2026-11-25T20:02:00Z'),
    {
      type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
      status: 'CORTEX_STEP_STATUS_DONE',
      plannerResponse: {
        toolCalls: [{ name: 'exit_plan_mode' }],
        thinkingTokens: 80,
        responseTokens: 40,
      },
      metadata: {
        createdAt: '2026-11-25T20:02:01Z',
        finishedGeneratingAt: '2026-11-25T20:02:03Z',
        sourceTrajectoryStepInfo: { stepIndex: 7 },
        generatorModel: 'MODEL_PLACEHOLDER_M532',
        modelUsage: {
          model: 'MODEL_PLACEHOLDER_M532',
          inputTokens: 1000,
          cacheReadTokens: 5000,
          outputTokens: 120,
        },
      },
    },
    makePlannerStep({
      stepIndex: 8,
      createdAt: '2026-11-25T20:02:05Z',
      model: 'MODEL_PLACEHOLDER_M532',
      modelDisplayName: 'Gemini 4 Neon (High)',
    }),
  ];

  // Empty generatorMetadata simulates Antigravity stripping plannerConfig from earlier entries while Implementor runs
  const extracted = extractModelSteps(steps, []);
  assert.equal(extracted.length, 5);
  assert.equal(extracted[0].orchestratorRole, 'orchestrator', 'Earlier Planner-only turn stays orchestrator');
  assert.equal(extracted[1].orchestratorRole, 'orchestrator', 'exit_plan_mode step tagged orchestrator');
  assert.equal(extracted[2].orchestratorRole, 'implementor', 'Post-handoff Implementor step tagged implementor');
  assert.equal(extracted[3].orchestratorRole, 'orchestrator', 'Same-model exit_plan_mode step tagged orchestrator');
  assert.equal(extracted[4].orchestratorRole, 'implementor', 'Same-model post-handoff step tagged implementor');
});

test('extractModelSteps does not tag normal Neon or Hydrogen turns as orchestrator/implementor when userAgentSpec omits planExecute', () => {
  const makeConfiguredUserStep = (text, isoTime, { planExecute = false, planModel = 'MODEL_PLACEHOLDER_M532', executionModel = '' } = {}) => ({
    type: 'CORTEX_STEP_TYPE_USER_INPUT',
    status: 'CORTEX_STEP_STATUS_DONE',
    userInput: {
      userResponse: text,
      userAgentSpec: {
        builtinAgent: {
          defaultAgent: {
            isInteractive: true,
            surface: 'AGENT_SURFACE_HUB',
            ...(planExecute ? { planExecute: true } : {}),
          },
        },
      },
      userConfig: {
        plannerConfig: {
          planModel,
          ...(executionModel ? { planExecuteConfig: { executionModel } } : {}),
        },
      },
    },
    metadata: { createdAt: isoTime },
  });

  const steps = [
    // Turn 1: Regular Neon (High) turn before Orchestrator was ever enabled
    makeConfiguredUserStep('Normal Neon question', '2026-11-25T21:00:00Z', {
      planExecute: false,
      planModel: 'MODEL_PLACEHOLDER_M532',
    }),
    makePlannerStep({
      stepIndex: 1,
      createdAt: '2026-11-25T21:00:02Z',
      model: 'MODEL_PLACEHOLDER_M532',
      modelDisplayName: 'Gemini 4 Neon (High)',
    }),
    // Turn 2: Orchestrator mode ON (Neon -> Hydrogen handoff)
    makeConfiguredUserStep('Orchestrator handoff turn', '2026-11-25T21:01:00Z', {
      planExecute: true,
      planModel: 'MODEL_PLACEHOLDER_M532',
      executionModel: 'MODEL_PLACEHOLDER_M525',
    }),
    {
      type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
      status: 'CORTEX_STEP_STATUS_DONE',
      plannerResponse: {
        toolCalls: [{ name: 'exit_plan_mode' }],
        thinkingTokens: 100,
        responseTokens: 50,
      },
      metadata: {
        createdAt: '2026-11-25T21:01:02Z',
        finishedGeneratingAt: '2026-11-25T21:01:04Z',
        sourceTrajectoryStepInfo: { stepIndex: 3 },
        generatorModel: 'MODEL_PLACEHOLDER_M532',
        modelUsage: {
          model: 'MODEL_PLACEHOLDER_M532',
          inputTokens: 1000,
          cacheReadTokens: 4000,
          outputTokens: 150,
        },
      },
    },
    makePlannerStep({
      stepIndex: 4,
      createdAt: '2026-11-25T21:01:06Z',
      model: 'MODEL_PLACEHOLDER_M525',
      modelDisplayName: 'Gemini 4 Hydrogen (High)',
    }),
    // Turn 3: Switched back to regular Neon (High) without Orchestrator
    makeConfiguredUserStep('Polish UI on normal Neon', '2026-11-25T21:02:00Z', {
      planExecute: false,
      planModel: 'MODEL_PLACEHOLDER_M532',
    }),
    makePlannerStep({
      stepIndex: 6,
      createdAt: '2026-11-25T21:02:02Z',
      model: 'MODEL_PLACEHOLDER_M532',
      modelDisplayName: 'Gemini 4 Neon (High)',
    }),
    // Turn 4: Switched to regular Hydrogen (High) without Orchestrator
    makeConfiguredUserStep('Quick edit on normal Hydrogen', '2026-11-25T21:03:00Z', {
      planExecute: false,
      planModel: 'MODEL_PLACEHOLDER_M525',
    }),
    makePlannerStep({
      stepIndex: 8,
      createdAt: '2026-11-25T21:03:02Z',
      model: 'MODEL_PLACEHOLDER_M525',
      modelDisplayName: 'Gemini 4 Hydrogen (High)',
    }),
  ];

  const extracted = extractModelSteps(steps, []);
  assert.equal(extracted.length, 5);
  assert.equal(extracted[0].orchestratorRole, null, 'Normal Neon turn before Orchestrator stays single-model');
  assert.equal(extracted[1].orchestratorRole, 'orchestrator', 'Orchestrator turn planner step tagged orchestrator');
  assert.equal(extracted[2].orchestratorRole, 'implementor', 'Orchestrator turn execution step tagged implementor');
  assert.equal(extracted[3].orchestratorRole, null, 'Regular Neon turn after Orchestrator stays single-model');
  assert.equal(extracted[4].orchestratorRole, null, 'Regular Hydrogen turn after Orchestrator stays single-model');
});
