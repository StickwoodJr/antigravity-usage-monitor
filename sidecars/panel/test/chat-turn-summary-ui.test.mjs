import test from 'node:test';
import assert from 'node:assert/strict';
import { createMockDom } from './mock-dom.mjs';
import {
  ChatTurnSummaryBar,
  resolveDefaultTurnSummaryExpanded,
  shouldRenderTurnSummary,
} from '../src/components/widgets/ChatTurnSummaryBar.js';
import {
  matchDomTurnsToSummaries,
  mountWindowOverlay,
} from '../src/components/layout/WindowOverlayShell.js';
import { WINDOW_OVERLAY_KEY } from '../shared/window-bridge-protocol.mjs';
import { telemetryStore } from '../src/store/telemetryStore.js';
import { uiStore } from '../src/store/uiStore.js';

function buildTurnDom(makeElement, { promptText, withChangedFiles = true, withActions = true }) {
  const outer = makeElement('div');
  outer.className = 'flex items-start';
  const turnContent = makeElement('div');
  turnContent.setAttribute('data-turn-content', '');
  turnContent.className = 'flex flex-col gap-0.5 w-full';

  const userMsg = makeElement('div');
  userMsg.setAttribute('data-testid', 'user-message');
  const srOnly = makeElement('h5');
  srOnly.className = 'sr-only';
  srOnly.setAttribute('data-find-ignore', 'true');
  srOnly.textContent = 'You said';
  const userContent = makeElement('div');
  userContent.setAttribute('data-testid', 'user-message-content');
  userContent.textContent = promptText;
  userMsg.appendChild(srOnly);
  userMsg.appendChild(userContent);

  const agentResp = makeElement('div');
  agentResp.setAttribute('data-testid', 'agent-response');
  agentResp.setAttribute('data-quotable', 'true');
  const stepList = makeElement('div');
  stepList.setAttribute('data-step-list', 'true');
  stepList.textContent = 'Response body';
  agentResp.appendChild(stepList);

  if (withChangedFiles) {
    const cardsContainer = makeElement('div');
    cardsContainer.setAttribute('data-testid', 'turn-cards-container');
    const changedCard = makeElement('div');
    changedCard.setAttribute('data-testid', 'changed-files-card');
    changedCard.textContent = '2 files changed +10 -3';
    cardsContainer.appendChild(changedCard);
    agentResp.appendChild(cardsContainer);
  }

  turnContent.appendChild(userMsg);
  turnContent.appendChild(agentResp);

  let actionsFieldset = null;
  if (withActions) {
    actionsFieldset = makeElement('fieldset');
    actionsFieldset.setAttribute('aria-label', 'Response actions');
    turnContent.appendChild(actionsFieldset);
  }

  outer.appendChild(turnContent);
  return { outer, turnContent, userMsg, agentResp, actionsFieldset };
}

function makeOrchSummary(overrides = {}) {
  return {
    rootTurnIndex: 0,
    turnPromptClean: 'Refactor the auth module',
    isLatestTurn: false,
    isRunning: false,
    mode: 'orchestrator',
    totalCompletedSteps: 20,
    totalSteps: 20,
    totals: {
      ctx: 42000,
      think: 18000,
      reply: 6200,
      outputTokens: 24200,
      durationSec: 18.4,
      tokPerSec: 62.5,
    },
    orchestratorBreakdown: {
      orchestrator: {
        completedSteps: 7,
        totalSteps: 7,
        pct: 35,
        ctx: 42000,
        think: 12000,
        reply: 2200,
        outputTokens: 14200,
        durationSec: 8.4,
        tokPerSec: 55.0,
        modelLabel: 'Orchestrator (Pro)',
      },
      implementor: {
        completedSteps: 13,
        totalSteps: 13,
        pct: 65,
        ctx: 38000,
        think: 6000,
        reply: 4000,
        outputTokens: 10000,
        durationSec: 10.0,
        tokPerSec: 71.2,
        modelLabel: 'Worker (Hydrogen)',
      },
    },
    agentBreakdown: [],
    ...overrides,
  };
}

function makeSwarmSummary(overrides = {}) {
  return {
    rootTurnIndex: 1,
    turnPromptClean: 'Audit DOM and telemetry',
    isLatestTurn: true,
    isRunning: false,
    mode: 'swarm',
    totalCompletedSteps: 28,
    totalSteps: 28,
    totals: {
      ctx: 96000,
      think: 24000,
      reply: 9500,
      outputTokens: 33500,
      durationSec: 42.0,
      tokPerSec: 58.3,
    },
    orchestratorBreakdown: null,
    agentBreakdown: [
      {
        agentId: 'main',
        label: 'Coordinator',
        isMain: true,
        isAuxiliary: false,
        modelLabel: 'Claude Opus',
        completedSteps: 10,
        totalSteps: 10,
        pct: 36,
        ctx: 96000,
        think: 10000,
        reply: 4000,
        outputTokens: 14000,
        durationSec: 14.0,
        tokPerSec: 52.1,
      },
      {
        agentId: 'worker-1',
        label: '@ui-dom-researcher',
        isMain: false,
        isAuxiliary: false,
        modelLabel: 'Gemini Pro',
        completedSteps: 15,
        totalSteps: 15,
        pct: 54,
        ctx: 64000,
        think: 14000,
        reply: 5500,
        outputTokens: 19500,
        durationSec: 22.0,
        tokPerSec: 64.0,
      },
      {
        agentId: 'monitor',
        label: '@monitor',
        isMain: false,
        isAuxiliary: true,
        modelLabel: 'Gemini Flash',
        completedSteps: 3,
        totalSteps: 3,
        pct: 10,
        ctx: 12000,
        think: 0,
        reply: 0,
        outputTokens: 450,
        durationSec: 6.0,
        tokPerSec: 40.0,
      },
    ],
    ...overrides,
  };
}

function makeSingleSummary(overrides = {}) {
  return {
    rootTurnIndex: 0,
    turnPromptClean: 'Say hello',
    isLatestTurn: false,
    isRunning: false,
    mode: 'single',
    totalCompletedSteps: 2,
    totalSteps: 2,
    totals: {
      ctx: 18000,
      think: 200,
      reply: 120,
      outputTokens: 320,
      durationSec: 3.2,
      tokPerSec: 80.0,
    },
    orchestratorBreakdown: null,
    agentBreakdown: [
      {
        agentId: 'main',
        label: 'Main',
        isMain: true,
        isAuxiliary: false,
        modelLabel: 'Gemini 4 Neon (High)',
        completedSteps: 2,
        totalSteps: 2,
        pct: 100,
        ctx: 18000,
        think: 200,
        reply: 120,
        outputTokens: 320,
        durationSec: 3.2,
        tokPerSec: 80.0,
      },
    ],
    ...overrides,
  };
}

test('shouldRenderTurnSummary filters empty single-agent turns and accepts non-empty single/orchestrator/swarm/subagent', () => {
  assert.equal(shouldRenderTurnSummary(null), false);
  assert.equal(
    shouldRenderTurnSummary({
      mode: 'single',
      totalCompletedSteps: 0,
      totalSteps: 0,
      totals: { ctx: 0, outputTokens: 0, think: 0, reply: 0 },
      orchestratorBreakdown: null,
      agentBreakdown: [{ agentId: 'main', isMain: true, completedSteps: 0, totalSteps: 0 }],
    }),
    false
  );
  assert.equal(shouldRenderTurnSummary(makeSingleSummary()), true);
  assert.equal(shouldRenderTurnSummary(makeOrchSummary()), true);
  assert.equal(shouldRenderTurnSummary(makeSwarmSummary()), true);
  assert.equal(
    shouldRenderTurnSummary({ mode: 'subagent', orchestratorBreakdown: null, agentBreakdown: [] }),
    true
  );

  assert.equal(resolveDefaultTurnSummaryExpanded(makeSingleSummary()), true);
  assert.equal(resolveDefaultTurnSummaryExpanded(makeOrchSummary()), false);
  assert.equal(resolveDefaultTurnSummaryExpanded(makeSwarmSummary()), false);
  assert.equal(
    resolveDefaultTurnSummaryExpanded({ mode: 'subagent', orchestratorBreakdown: null, agentBreakdown: [] }),
    false
  );
});

test('ChatTurnSummaryBar renders orchestrator & swarm cards and toggles expand/collapse', () => {
  const prevDoc = globalThis.document;
  const { document: mockDoc } = createMockDom();
  globalThis.document = mockDoc;

  try {
    let toggledVal = null;
    const orchComp = ChatTurnSummaryBar({
      summary: makeOrchSummary(),
      expanded: false,
      onToggleExpand: (v) => {
        toggledVal = v;
      },
    });
    const textCollapsed = orchComp.el.textContent;
    assert.ok(textCollapsed.includes('Orchestrator'));
    assert.ok(textCollapsed.includes('35%'));
    assert.ok(textCollapsed.includes('65%'));
    assert.equal(orchComp.el.querySelector('.wm-ts-body').hasAttribute('hidden'), true);

    const headerBtn = orchComp.el.querySelector('.wm-ts-header');
    headerBtn.dispatchEvent({ type: 'click', stopPropagation() {} });
    assert.equal(toggledVal, true);
    assert.equal(orchComp.refs.isExpanded(), true);
    assert.equal(orchComp.el.querySelector('.wm-ts-body').hasAttribute('hidden'), false);
    const expandedText = orchComp.el.querySelector('.wm-ts-body').textContent;
    assert.ok(expandedText.includes('Orchestrator (Pro)'));
    assert.ok(expandedText.includes('Worker (Hydrogen)'));

    const swarmComp = ChatTurnSummaryBar({
      summary: makeSwarmSummary(),
      expanded: true,
    });
    assert.ok(swarmComp.el.querySelector('.wm-ts-mode').classList.contains('is-swarm'));
    const swarmBody = swarmComp.el.querySelector('.wm-ts-body').textContent;
    assert.ok(swarmBody.includes('@ui-dom-researcher'));
    assert.ok(swarmBody.includes('@monitor'));
    assert.ok(swarmBody.includes('Aux'));
    assert.ok(swarmBody.includes('450 out'), 'Falls back to outputTokens when think=0 and reply=0');
    assert.equal(swarmComp.el.querySelectorAll('.wm-ts-agent-row').length, 3, 'Each swarm agent renders a proportional row');
    assert.equal(swarmComp.el.querySelectorAll('.wm-ts-rail-seg').length, 3, 'Proportional rail matches agent segments');

    // Idle zero-step role column is softly dimmed and shows clean placeholders
    const plannerOnlyComp = ChatTurnSummaryBar({
      summary: makeOrchSummary({
        orchestratorBreakdown: {
          orchestrator: {
            completedSteps: 4,
            totalSteps: 4,
            pct: 100,
            ctx: 42000,
            think: 1200,
            reply: 400,
            outputTokens: 1600,
            durationSec: 5.2,
            tokPerSec: 64.0,
            modelLabel: 'Gemini 4 Neon (High)',
          },
          implementor: {
            completedSteps: 0,
            totalSteps: 0,
            pct: 0,
            ctx: 0,
            think: 0,
            reply: 0,
            outputTokens: 0,
            durationSec: 0,
            tokPerSec: null,
            modelLabel: '',
          },
        },
      }),
      expanded: true,
    });
    assert.ok(plannerOnlyComp.el.querySelector('.wm-ts-mode').classList.contains('is-orch'));
    assert.ok(plannerOnlyComp.el.querySelectorAll('.wm-ts-stat-val').length >= 3);
    const orchCols = plannerOnlyComp.el.querySelectorAll('.wm-ts-orch-col');
    assert.equal(orchCols.length, 2);
    assert.equal(orchCols[0].classList.contains('is-idle'), false);
    assert.equal(orchCols[1].classList.contains('is-idle'), true);
    assert.ok(orchCols[0].querySelector('.wm-ts-val-speed').textContent.includes('64'));

    // Single-model summary defaults to expanded, displays model label and 5-metric strip, and toggles collapsed
    const singleComp = ChatTurnSummaryBar({
      summary: makeSingleSummary({ totalCompletedSteps: 17, totalSteps: 17 }),
    });
    assert.ok(singleComp.el.classList.contains('is-single'));
    assert.ok(singleComp.el.querySelector('.wm-ts-mode').classList.contains('is-single'));
    assert.equal(singleComp.refs.isExpanded(), true, 'Single-model card defaults to expanded');
    assert.equal(singleComp.el.querySelector('.wm-ts-body').hasAttribute('hidden'), false);
    assert.ok(singleComp.el.textContent.includes('Gemini 4 Neon (High)'));
    assert.ok(singleComp.el.textContent.includes('17 steps'));
    assert.ok(singleComp.el.querySelector('.wm-ts-metrics-grid.is-single'));

    singleComp.el.querySelector('.wm-ts-header').dispatchEvent({ type: 'click', stopPropagation() {} });
    assert.equal(singleComp.refs.isExpanded(), false);
    assert.equal(singleComp.el.querySelector('.wm-ts-body').hasAttribute('hidden'), true);
  } finally {
    globalThis.document = prevDoc;
  }
});

test('matchDomTurnsToSummaries handles truncated history (load-older-messages-button) and failed empty turns', () => {
  const domTurns = [
    { promptText: 'Failed turn with no usage', domIndex: 0 },
    { promptText: 'Audit DOM and telemetry with extra details', domIndex: 1 },
  ];
  const summaries = [
    makeOrchSummary({ rootTurnIndex: 0, turnPromptClean: 'Old truncated turn' }),
    makeSwarmSummary({ rootTurnIndex: 1, turnPromptClean: 'Audit DOM and telemetry', isLatestTurn: true }),
  ];

  const matched = matchDomTurnsToSummaries(domTurns, summaries);
  assert.equal(matched.length, 1);
  assert.equal(matched[0].domIndex, 1);
  assert.equal(matched[0].summary.rootTurnIndex, 1);

  // An unmatched new DOM turn with a non-empty prompt must NOT borrow an older isLatestTurn summary
  const mismatchDom = [
    { promptText: 'Brand new prompt still waiting for telemetry', domIndex: 0 },
  ];
  const mismatchSum = [
    makeOrchSummary({ rootTurnIndex: 0, turnPromptClean: 'Different previous prompt', isLatestTurn: true }),
  ];
  assert.equal(matchDomTurnsToSummaries(mismatchDom, mismatchSum).length, 0);
});

test('WindowOverlayShell injects Shadow DOM turn cards after agent-response, preserves expand state, respects setting & dispose', async () => {
  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  const prevNav = globalThis.navigator;
  const prevTel = { ...telemetryStore.getState() };
  const prevUi = { ...uiStore.getState() };

  const { body, document: mockDoc, makeElement } = createMockDom();
  const cascadeId = 'aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb';

  const titlebar = makeElement('div');
  titlebar.className = 'flex items-center @container/titlebar';
  titlebar.setRect({ left: 0, right: 1280, top: 0, bottom: 36, width: 1280, height: 36 });
  body.appendChild(titlebar);

  const convView = makeElement('div');
  convView.setAttribute('data-testid', 'conversation-view');
  convView.setAttribute('data-cascade-id', cascadeId);
  convView.setRect({ left: 260, right: 1280, top: 36, bottom: 800, width: 1020, height: 764 });

  const loadOlderBtn = makeElement('button');
  loadOlderBtn.setAttribute('data-testid', 'load-older-messages-button');
  convView.appendChild(loadOlderBtn);

  const singleTurn = buildTurnDom(makeElement, {
    promptText: 'Say hello',
    withChangedFiles: false,
    withActions: true,
  });
  const orchTurn = buildTurnDom(makeElement, {
    promptText: 'Refactor the auth module',
    withChangedFiles: true,
    withActions: true,
  });
  const swarmTurn = buildTurnDom(makeElement, {
    promptText: 'Audit DOM and telemetry',
    withChangedFiles: false,
    withActions: true,
  });

  convView.appendChild(singleTurn.outer);
  convView.appendChild(orchTurn.outer);
  convView.appendChild(swarmTurn.outer);
  body.appendChild(convView);

  globalThis.document = mockDoc;
  globalThis.window = {
    innerWidth: 1280,
    innerHeight: 820,
    location: { pathname: `/c/${cascadeId}` },
    addEventListener() {},
    removeEventListener() {},
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
  };
  Object.defineProperty(globalThis, 'navigator', {
    value: { language: 'en-US' },
    configurable: true,
  });

  const makeTelemetry = (overrides = {}) => ({
    settings: {
      language: 'en-US',
      modernUi: true,
      enableWindowOverlay: true,
      windowMountMode: 'dual',
      enableChatTurnSummary: true,
      ...(overrides.settings || {}),
    },
    activeConversation: {
      cascadeId,
      turnSummaries: overrides.turnSummaries || [
        {
          rootTurnIndex: 0,
          turnPromptClean: 'Old truncated turn',
          isLatestTurn: false,
          isRunning: false,
          mode: 'single',
          orchestratorBreakdown: null,
          agentBreakdown: [],
        },
        makeSingleSummary({
          rootTurnIndex: 1,
          turnPromptClean: 'Say hello',
          isLatestTurn: false,
          isRunning: false,
        }),
        makeOrchSummary({ rootTurnIndex: 2, turnPromptClean: 'Refactor the auth module', isLatestTurn: false }),
        makeSwarmSummary({ rootTurnIndex: 3, turnPromptClean: 'Audit DOM and telemetry', isLatestTurn: true, isRunning: true }),
      ],
    },
    runningConversations: [],
    conversations: [],
    quotas: { pools: [] },
  });

  telemetryStore.setState({
    telemetry: makeTelemetry(),
    hostRouteConversationId: cascadeId,
    selectedConversationId: cascadeId,
  });

  const ov = mountWindowOverlay();
  try {
    const hosts = mockDoc.querySelectorAll('.wm-turn-summary-host');
    assert.equal(hosts.length, 3, 'Single, orchestrator, and swarm turns render inline summary cards');

    // Anchored immediately after [data-testid="agent-response"] and before Response actions fieldset
    assert.equal(singleTurn.agentResp.nextElementSibling, hosts[0]);
    assert.equal(hosts[0].nextElementSibling, singleTurn.actionsFieldset);
    assert.equal(orchTurn.agentResp.nextElementSibling, hosts[1]);
    assert.equal(hosts[1].nextElementSibling, orchTurn.actionsFieldset);
    assert.equal(swarmTurn.agentResp.nextElementSibling, hosts[2]);
    assert.equal(hosts[2].nextElementSibling, swarmTurn.actionsFieldset);

    // Inherits modern-ui appearance attribute on Shadow DOM host
    assert.equal(hosts[0].getAttribute('data-modern-ui'), 'true');

    // Default expand states: single expanded, orchestrator & swarm collapsed
    assert.equal(hosts[0].shadowRoot.querySelector('.wm-ts-body').hasAttribute('hidden'), false, 'Single turn expanded by default');
    assert.equal(hosts[1].shadowRoot.querySelector('.wm-ts-body').hasAttribute('hidden'), true, 'Orchestrator turn collapsed by default');
    assert.equal(hosts[2].shadowRoot.querySelector('.wm-ts-body').hasAttribute('hidden'), true, 'Swarm turn collapsed by default');

    // Collapse singleTurn manually and expand orchTurn, then verify live telemetry update preserves both states
    hosts[0].shadowRoot.querySelector('.wm-ts-header').dispatchEvent({ type: 'click', stopPropagation() {} });
    assert.equal(hosts[0].shadowRoot.querySelector('.wm-ts-body').hasAttribute('hidden'), true);
    const orchHeader = hosts[1].shadowRoot.querySelector('.wm-ts-header');
    orchHeader.dispatchEvent({ type: 'click', stopPropagation() {} });
    assert.equal(hosts[1].shadowRoot.querySelector('.wm-ts-body').hasAttribute('hidden'), false);

    telemetryStore.setState({
      telemetry: makeTelemetry({
        turnSummaries: [
          {
            rootTurnIndex: 0,
            turnPromptClean: 'Old truncated turn',
            isLatestTurn: false,
            isRunning: false,
            mode: 'single',
            orchestratorBreakdown: null,
            agentBreakdown: [],
          },
          makeSingleSummary({
            rootTurnIndex: 1,
            turnPromptClean: 'Say hello',
            isLatestTurn: false,
            isRunning: false,
          }),
          makeOrchSummary({ rootTurnIndex: 2, turnPromptClean: 'Refactor the auth module', isLatestTurn: false }),
          makeSwarmSummary({ rootTurnIndex: 3, turnPromptClean: 'Audit DOM and telemetry', isLatestTurn: true, isRunning: false }),
        ],
      }),
    }, { sync: true });

    const hostsAfter = mockDoc.querySelectorAll('.wm-turn-summary-host');
    assert.equal(hostsAfter.length, 3);
    assert.equal(hostsAfter[1], hosts[1], 'Reuses existing Shadow host node in-place');
    assert.equal(hostsAfter[0].shadowRoot.querySelector('.wm-ts-body').hasAttribute('hidden'), true, 'Preserves collapsed state on single turn');
    assert.equal(hostsAfter[1].shadowRoot.querySelector('.wm-ts-body').hasAttribute('hidden'), false, 'Preserves expanded state on orch turn');
    assert.equal(hostsAfter[2].shadowRoot.querySelector('.wm-ts-pulse').hasAttribute('hidden'), true);

    // Setting enableChatTurnSummary: false removes all turn summary hosts
    telemetryStore.setState({
      telemetry: makeTelemetry({ settings: { enableChatTurnSummary: false } }),
    }, { sync: true });
    assert.equal(mockDoc.querySelectorAll('.wm-turn-summary-host').length, 0);

    // Re-enabling restores them
    telemetryStore.setState({
      telemetry: makeTelemetry({ settings: { enableChatTurnSummary: true } }),
    }, { sync: true });
    assert.equal(mockDoc.querySelectorAll('.wm-turn-summary-host').length, 3);

    // dispose() cleans up all hosts
    ov.dispose();
    assert.equal(mockDoc.querySelectorAll('.wm-turn-summary-host').length, 0);
  } finally {
    ov?.dispose?.();
    telemetryStore.setState(prevTel);
    uiStore.setState(prevUi);
    globalThis.document = prevDoc;
    globalThis.window = prevWin;
    Object.defineProperty(globalThis, 'navigator', {
      value: prevNav,
      configurable: true,
    });
    if (globalThis.window && globalThis.window[WINDOW_OVERLAY_KEY]) {
      delete globalThis.window[WINDOW_OVERLAY_KEY];
    }
  }
});

test('WindowOverlayShell.ensureAlive preserves mounted turn summary hosts and expanded state across capsule redocks', () => {
  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  const prevNav = globalThis.navigator;
  const prevTel = { ...telemetryStore.getState() };
  const prevUi = { ...uiStore.getState() };

  const { body, document: mockDoc, makeElement } = createMockDom();
  const cascadeId = 'cccccccc-1111-2222-3333-dddddddddddd';

  const titlebar = makeElement('div');
  titlebar.className = 'flex items-center @container/titlebar';
  titlebar.setRect({ left: 0, right: 1280, top: 0, bottom: 36, width: 1280, height: 36 });
  body.appendChild(titlebar);

  const convView = makeElement('div');
  convView.setAttribute('data-testid', 'conversation-view');
  convView.setAttribute('data-cascade-id', cascadeId);
  convView.setRect({ left: 260, right: 1280, top: 36, bottom: 800, width: 1020, height: 764 });
  const orchTurn = buildTurnDom(makeElement, {
    promptText: 'Refactor the auth module',
    withChangedFiles: true,
    withActions: true,
  });
  convView.appendChild(orchTurn.outer);
  body.appendChild(convView);

  globalThis.document = mockDoc;
  globalThis.window = {
    innerWidth: 1280,
    innerHeight: 820,
    location: { pathname: `/c/${cascadeId}` },
    addEventListener() {},
    removeEventListener() {},
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
  };
  Object.defineProperty(globalThis, 'navigator', {
    value: { language: 'en-US' },
    configurable: true,
  });

  telemetryStore.setState({
    telemetry: {
      settings: {
        language: 'en-US',
        enableWindowOverlay: true,
        windowMountMode: 'dual',
        enableChatTurnSummary: true,
      },
      activeConversation: {
        cascadeId,
        turnSummaries: [
          makeOrchSummary({ rootTurnIndex: 0, turnPromptClean: 'Refactor the auth module', isLatestTurn: true }),
        ],
      },
      runningConversations: [],
      conversations: [],
      quotas: { pools: [] },
    },
    hostRouteConversationId: cascadeId,
    selectedConversationId: cascadeId,
  });

  const ov = mountWindowOverlay();
  try {
    const hosts = mockDoc.querySelectorAll('.wm-turn-summary-host');
    assert.equal(hosts.length, 1);
    const header = hosts[0].shadowRoot.querySelector('.wm-ts-header');
    header.dispatchEvent({ type: 'click', stopPropagation() {} });
    assert.equal(hosts[0].shadowRoot.querySelector('.wm-ts-body').hasAttribute('hidden'), false);

    // Calling ensureAlive() triggers ensureCapsuleDocked() — must NOT tear down turn summary hosts or clear expand state
    ov.ensureAlive();
    const hostsAfter = mockDoc.querySelectorAll('.wm-turn-summary-host');
    assert.equal(hostsAfter.length, 1);
    assert.equal(hostsAfter[0], hosts[0]);
    assert.equal(hostsAfter[0].shadowRoot.querySelector('.wm-ts-body').hasAttribute('hidden'), false);
  } finally {
    ov?.dispose?.();
    telemetryStore.setState(prevTel);
    uiStore.setState(prevUi);
    globalThis.document = prevDoc;
    globalThis.window = prevWin;
    Object.defineProperty(globalThis, 'navigator', {
      value: prevNav,
      configurable: true,
    });
    if (globalThis.window && globalThis.window[WINDOW_OVERLAY_KEY]) {
      delete globalThis.window[WINDOW_OVERLAY_KEY];
    }
  }
});

test('WindowOverlayShell pins chat scroll to bottom when injecting latest turn summary near bottom, and respects scrolled-up state', () => {
  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  const prevNav = globalThis.navigator;
  const prevTel = { ...telemetryStore.getState() };
  const prevUi = { ...uiStore.getState() };

  const { body, document: mockDoc, makeElement } = createMockDom();
  const cascadeId = 'eeeeeeee-1111-2222-3333-ffffffffffff';

  const titlebar = makeElement('div');
  titlebar.className = 'flex items-center @container/titlebar';
  titlebar.setRect({ left: 0, right: 1280, top: 0, bottom: 36, width: 1280, height: 36 });
  body.appendChild(titlebar);

  const scroller = makeElement('div');
  scroller.style.overflowY = 'auto';
  scroller.clientHeight = 600;
  scroller.scrollHeight = 1200;
  scroller.scrollTop = 580; // 20px from bottom (within 120px threshold)

  const convView = makeElement('div');
  convView.setAttribute('data-testid', 'conversation-view');
  convView.setAttribute('data-cascade-id', cascadeId);
  const swarmTurn = buildTurnDom(makeElement, {
    promptText: 'Audit DOM and telemetry',
    withChangedFiles: false,
    withActions: true,
  });
  convView.appendChild(swarmTurn.outer);
  scroller.appendChild(convView);
  body.appendChild(scroller);

  globalThis.document = mockDoc;
  globalThis.window = {
    innerWidth: 1280,
    innerHeight: 820,
    location: { pathname: `/c/${cascadeId}` },
    addEventListener() {},
    removeEventListener() {},
    getComputedStyle: (el) => ({
      getPropertyValue: () => '',
      overflowY: el === scroller ? 'auto' : '',
    }),
  };
  Object.defineProperty(globalThis, 'navigator', {
    value: { language: 'en-US' },
    configurable: true,
  });

  // Start without summary, then push latest turn summary while near bottom (simulating scrollHeight growing)
  telemetryStore.setState({
    telemetry: {
      settings: { enableWindowOverlay: true, windowMountMode: 'dual', enableChatTurnSummary: true },
      activeConversation: { cascadeId, turnSummaries: [] },
      runningConversations: [],
      conversations: [],
      quotas: { pools: [] },
    },
    hostRouteConversationId: cascadeId,
    selectedConversationId: cascadeId,
  });

  const ov = mountWindowOverlay();
  try {
    scroller.scrollHeight = 1244; // grew after card mount
    telemetryStore.setState({
      telemetry: {
        settings: { enableWindowOverlay: true, windowMountMode: 'dual', enableChatTurnSummary: true },
        activeConversation: {
          cascadeId,
          turnSummaries: [makeSwarmSummary({ rootTurnIndex: 0, isLatestTurn: true })],
        },
        runningConversations: [],
        conversations: [],
        quotas: { pools: [] },
      },
    }, { sync: true });
    assert.equal(scroller.scrollTop, 1244, 'Pins scroll to bottom when near bottom on latest summary mount');

    // Reset and test scrolled-up user: distFromBottom > 120 must NOT snap scrollTop
    telemetryStore.setState({
      telemetry: {
        settings: { enableWindowOverlay: true, windowMountMode: 'dual', enableChatTurnSummary: true },
        activeConversation: { cascadeId, turnSummaries: [] },
        runningConversations: [],
        conversations: [],
        quotas: { pools: [] },
      },
    }, { sync: true });

    scroller.scrollHeight = 1200;
    scroller.scrollTop = 200; // 400px from bottom
    telemetryStore.setState({
      telemetry: {
        settings: { enableWindowOverlay: true, windowMountMode: 'dual', enableChatTurnSummary: true },
        activeConversation: {
          cascadeId,
          turnSummaries: [makeSwarmSummary({ rootTurnIndex: 0, isLatestTurn: true })],
        },
        runningConversations: [],
        conversations: [],
        quotas: { pools: [] },
      },
    }, { sync: true });
    assert.equal(scroller.scrollTop, 200, 'Leaves scrollTop untouched when user is scrolled up');
  } finally {
    ov?.dispose?.();
    telemetryStore.setState(prevTel);
    uiStore.setState(prevUi);
    globalThis.document = prevDoc;
    globalThis.window = prevWin;
    Object.defineProperty(globalThis, 'navigator', {
      value: prevNav,
      configurable: true,
    });
    if (globalThis.window && globalThis.window[WINDOW_OVERLAY_KEY]) {
      delete globalThis.window[WINDOW_OVERLAY_KEY];
    }
  }
});

test('matchDomTurnsToSummaries handles ellipsis-truncated summaries, @[Quote] mentions, and prepended DOM badges', () => {
  const longPrompt =
    'Ok the swarm button shows up and works now however I noticed a bug, if I have the sidebar already open and you press either the top pill or the button you just added it fullscreens the sidebar instead of opening Swarm';
  const truncatedSummary = `${longPrompt.slice(0, 179)}…`;

  const domTurns = [
    { promptText: 'Quote what?', domIndex: 0 },
    { promptText: 'what?', domIndex: 1 },
    { promptText: `1 attachment ${longPrompt}`, domIndex: 2 },
  ];
  const summaries = [
    makeOrchSummary({ rootTurnIndex: 0, turnPromptClean: '@[Quote] what?' }),
    makeOrchSummary({ rootTurnIndex: 1, turnPromptClean: '@[Quote] what?' }),
    makeOrchSummary({ rootTurnIndex: 2, turnPromptClean: truncatedSummary, isLatestTurn: true }),
  ];

  const matched = matchDomTurnsToSummaries(domTurns, summaries);
  assert.equal(matched.length, 3);
  assert.deepEqual(
    matched.map((m) => [m.domIndex, m.summary.rootTurnIndex]),
    [
      [0, 0],
      [1, 1],
      [2, 2],
    ]
  );
});

test('WindowOverlayShell pairs earlier flat-container turns and renders Implementor breakdown on earlier turns', () => {
  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  const prevNav = globalThis.navigator;
  const prevTel = { ...telemetryStore.getState() };
  const prevUi = { ...uiStore.getState() };

  const { body, document: mockDoc, makeElement } = createMockDom();
  const cascadeId = '11111111-2222-3333-4444-555555555555';

  const titlebar = makeElement('div');
  titlebar.className = 'flex items-center @container/titlebar';
  titlebar.setRect({ left: 0, right: 1280, top: 0, bottom: 36, width: 1280, height: 36 });
  body.appendChild(titlebar);

  // Flat container WITHOUT [data-turn-content] wrappers, where agent-response lives inside nested wrappers
  const convView = makeElement('div');
  convView.setAttribute('data-testid', 'conversation-view');
  convView.setAttribute('data-cascade-id', cascadeId);

  const addFlatTurn = (text) => {
    const uMsg = makeElement('div');
    uMsg.setAttribute('data-testid', 'user-message');
    const uSpan = makeElement('span');
    uSpan.textContent = text;
    uMsg.appendChild(uSpan);
    const respWrap = makeElement('div');
    const aResp = makeElement('div');
    aResp.setAttribute('data-testid', 'agent-response');
    aResp.textContent = `Reply to ${text}`;
    respWrap.appendChild(aResp);
    convView.appendChild(uMsg);
    convView.appendChild(respWrap);
    return aResp;
  };

  const t1Prompt = 'Ok the swarm button shows up and works now however I noticed a bug when the sidebar is already open and fullscreens instead of opening the menu';
  const t2Prompt = 'Latest planner-only follow up turn';
  const r1 = addFlatTurn(t1Prompt);
  const r2 = addFlatTurn(t2Prompt);
  body.appendChild(convView);

  globalThis.document = mockDoc;
  globalThis.window = {
    innerWidth: 1280,
    innerHeight: 820,
    location: { pathname: `/c/${cascadeId}` },
    addEventListener() {},
    removeEventListener() {},
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
  };
  Object.defineProperty(globalThis, 'navigator', {
    value: { language: 'en-US' },
    configurable: true,
  });

  const t1Summary = makeOrchSummary({
    rootTurnIndex: 0,
    turnPromptClean: `${t1Prompt.slice(0, 120)}…`,
    isLatestTurn: false,
    orchestratorBreakdown: {
      orchestrator: {
        completedSteps: 1,
        totalSteps: 1,
        pct: 25,
        ctx: 42000,
        think: 500,
        reply: 200,
        outputTokens: 700,
        durationSec: 4.0,
        tokPerSec: 60.0,
        modelLabel: 'Gemini 4 Neon (High)',
      },
      implementor: {
        completedSteps: 3,
        totalSteps: 3,
        pct: 75,
        ctx: 38000,
        think: 1500,
        reply: 800,
        outputTokens: 2300,
        durationSec: 6.0,
        tokPerSec: 120.0,
        modelLabel: 'Gemini 4 Hydrogen (High)',
      },
    },
  });
  const t2Summary = makeOrchSummary({
    rootTurnIndex: 1,
    turnPromptClean: t2Prompt,
    isLatestTurn: true,
  });

  telemetryStore.setState({
    telemetry: {
      settings: { enableWindowOverlay: true, windowMountMode: 'dual', enableChatTurnSummary: true },
      activeConversation: { cascadeId, turnSummaries: [t1Summary, t2Summary] },
      runningConversations: [],
      conversations: [],
      quotas: { pools: [] },
    },
    hostRouteConversationId: cascadeId,
    selectedConversationId: cascadeId,
  });

  const ov = mountWindowOverlay();
  try {
    const hosts = mockDoc.querySelectorAll('.wm-turn-summary-host');
    assert.equal(hosts.length, 2, 'Both earlier and latest turns render summary cards');
    assert.equal(r1.nextElementSibling, hosts[0]);
    assert.equal(r2.nextElementSibling, hosts[1]);

    const t1HeaderText = hosts[0].shadowRoot.querySelector('.wm-ts-header').textContent;
    assert.ok(t1HeaderText.includes('25%'), 'Shows Orchestrator share on earlier turn');
    assert.ok(t1HeaderText.includes('75%'), 'Shows Implementor share on earlier turn');

    hosts[0].shadowRoot.querySelector('.wm-ts-header').dispatchEvent({ type: 'click', stopPropagation() {} });
    const t1BodyText = hosts[0].shadowRoot.querySelector('.wm-ts-body').textContent;
    assert.ok(t1BodyText.includes('Gemini 4 Hydrogen (High)'), 'Displays Implementor model breakdown');
  } finally {
    ov?.dispose?.();
    telemetryStore.setState(prevTel);
    uiStore.setState(prevUi);
    globalThis.document = prevDoc;
    globalThis.window = prevWin;
    Object.defineProperty(globalThis, 'navigator', {
      value: prevNav,
      configurable: true,
    });
    if (globalThis.window && globalThis.window[WINDOW_OVERLAY_KEY]) {
      delete globalThis.window[WINDOW_OVERLAY_KEY];
    }
  }
});

test('WindowOverlayShell re-anchors single summary card from Planner to Implementor response within the same turn', () => {
  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  const prevNav = globalThis.navigator;
  const prevTel = { ...telemetryStore.getState() };
  const prevUi = { ...uiStore.getState() };

  const { body, document: mockDoc, makeElement } = createMockDom();
  const cascadeId = '22222222-3333-4444-5555-666666666666';

  const titlebar = makeElement('div');
  titlebar.className = 'flex items-center @container/titlebar';
  titlebar.setRect({ left: 0, right: 1280, top: 0, bottom: 36, width: 1280, height: 36 });
  body.appendChild(titlebar);

  const convView = makeElement('div');
  convView.setAttribute('data-testid', 'conversation-view');
  convView.setAttribute('data-cascade-id', cascadeId);

  const turn = buildTurnDom(makeElement, {
    promptText: 'Implement multi-response orchestrator handoff',
    withChangedFiles: false,
    withActions: false,
  });
  convView.appendChild(turn.outer);
  body.appendChild(convView);

  globalThis.document = mockDoc;
  globalThis.window = {
    innerWidth: 1280,
    innerHeight: 820,
    location: { pathname: `/c/${cascadeId}` },
    addEventListener() {},
    removeEventListener() {},
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
  };
  Object.defineProperty(globalThis, 'navigator', {
    value: { language: 'en-US' },
    configurable: true,
  });

  // Phase 1: Planner-only active turn
  telemetryStore.setState({
    telemetry: {
      settings: { enableWindowOverlay: true, windowMountMode: 'dual', enableChatTurnSummary: true },
      activeConversation: {
        cascadeId,
        turnSummaries: [
          makeOrchSummary({
            rootTurnIndex: 0,
            turnPromptClean: 'Implement multi-response orchestrator handoff',
            isLatestTurn: true,
            isRunning: true,
            orchestratorBreakdown: {
              orchestrator: {
                completedSteps: 2,
                totalSteps: 2,
                pct: 100,
                ctx: 30000,
                think: 400,
                reply: 100,
                outputTokens: 500,
                durationSec: 3.0,
                tokPerSec: 60.0,
                modelLabel: 'Gemini 4 Neon (High)',
              },
              implementor: {
                completedSteps: 0,
                totalSteps: 0,
                pct: 0,
                ctx: 0,
                think: 0,
                reply: 0,
                outputTokens: 0,
                durationSec: 0,
                tokPerSec: null,
                modelLabel: '',
              },
            },
          }),
        ],
      },
      runningConversations: [],
      conversations: [],
      quotas: { pools: [] },
    },
    hostRouteConversationId: cascadeId,
    selectedConversationId: cascadeId,
  });

  const ov = mountWindowOverlay();
  try {
    let hosts = mockDoc.querySelectorAll('.wm-turn-summary-host');
    assert.equal(hosts.length, 1);
    assert.equal(turn.agentResp.nextElementSibling, hosts[0], 'Initially mounted after Planner response');
    const initialHost = hosts[0];

    // User expands card during Planner phase
    initialHost.shadowRoot.querySelector('.wm-ts-header').dispatchEvent({ type: 'click', stopPropagation() {} });
    assert.equal(initialHost.shadowRoot.querySelector('.wm-ts-body').hasAttribute('hidden'), false);

    // Phase 2: Antigravity appends a second [data-testid="agent-response"] for the Implementor phase (same user turn)
    const implResp = makeElement('div');
    implResp.setAttribute('data-testid', 'agent-response');
    implResp.textContent = 'Implementor output';
    turn.turnContent.appendChild(implResp);

    telemetryStore.setState({
      telemetry: {
        settings: { enableWindowOverlay: true, windowMountMode: 'dual', enableChatTurnSummary: true },
        activeConversation: {
          cascadeId,
          turnSummaries: [
            makeOrchSummary({
              rootTurnIndex: 0,
              turnPromptClean: 'Implement multi-response orchestrator handoff',
              isLatestTurn: true,
              isRunning: false,
              orchestratorBreakdown: {
                orchestrator: {
                  completedSteps: 3,
                  totalSteps: 3,
                  pct: 43,
                  ctx: 34000,
                  think: 600,
                  reply: 200,
                  outputTokens: 800,
                  durationSec: 5.0,
                  tokPerSec: 62.0,
                  modelLabel: 'Gemini 4 Neon (High)',
                },
                implementor: {
                  completedSteps: 4,
                  totalSteps: 4,
                  pct: 57,
                  ctx: 40000,
                  think: 1200,
                  reply: 600,
                  outputTokens: 1800,
                  durationSec: 8.0,
                  tokPerSec: 110.0,
                  modelLabel: 'Gemini 4 Hydrogen (High)',
                },
              },
            }),
          ],
        },
        runningConversations: [],
        conversations: [],
        quotas: { pools: [] },
      },
    }, { sync: true });

    hosts = mockDoc.querySelectorAll('.wm-turn-summary-host');
    assert.equal(hosts.length, 1, 'Still renders exactly one summary card for the turn');
    assert.equal(implResp.nextElementSibling, hosts[0], 'Re-anchors card after the final Implementor response');
    assert.equal(hosts[0].shadowRoot.querySelector('.wm-ts-body').hasAttribute('hidden'), false, 'Preserves expanded state across handoff');
    const bodyText = hosts[0].shadowRoot.querySelector('.wm-ts-body').textContent;
    assert.ok(bodyText.includes('Gemini 4 Neon (High)'));
    assert.ok(bodyText.includes('Gemini 4 Hydrogen (High)'));
  } finally {
    ov?.dispose?.();
    telemetryStore.setState(prevTel);
    uiStore.setState(prevUi);
    globalThis.document = prevDoc;
    globalThis.window = prevWin;
    Object.defineProperty(globalThis, 'navigator', {
      value: prevNav,
      configurable: true,
    });
    if (globalThis.window && globalThis.window[WINDOW_OVERLAY_KEY]) {
      delete globalThis.window[WINDOW_OVERLAY_KEY];
    }
  }
});
