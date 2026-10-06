(() => {
  'use strict';

  const ACTIVE = '__L2CHART_PAGE_MODEL__';
  const old = globalThis[ACTIVE];
  if (old && typeof old.stop === 'function') old.stop();

  const MAX_CLIMB = 64;
  const MAX_ROOT_DEPTH = 128;
  const PICKER = '[data-testid="composer-intelligence-picker-content"], [data-model-picker-view]';
  const TURN_SECTION = [
    'section[data-testid^="conversation-turn"]',
    '[data-turn-key]',
    '[data-content-search-turn-key]'
  ].join(',');
  const REASONING = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'pro']);
  const currentPaths = new WeakMap();

  function str(value) {
    return typeof value === 'string' && value.length > 0 ? value.slice(0, 512) : null;
  }

  function committedPath(fiber) {
    const path = [];
    const seen = new Set();
    let at = fiber;
    let base = null;
    let paired = false;
    const view = (node, parent) => ({
      memoizedProps: node.memoizedProps,
      memoizedState: node.memoizedState,
      updateQueue: node.updateQueue,
      return: parent
    });
    const remember = (node, value) => {
      currentPaths.set(node, value);
      if (node.alternate) currentPaths.set(node.alternate, value);
    };
    while (at && path.length < MAX_ROOT_DEPTH) {
      if (seen.has(at)) return null;
      seen.add(at);
      const cached = currentPaths.get(at);
      if (cached && cached.root.current === cached.current) {
        base = cached;
        break;
      }
      paired ||= Boolean(at.alternate);
      if (at.tag === 3) {
        const root = at.stateNode;
        const current = root?.current;
        if (!current || (current !== at && current !== at.alternate)) return null;
        base = { root, current, node: current, view: view(current, null) };
        remember(at, base);
        break;
      }
      path.push(at);
      at = at.return;
    }
    if (!base) {
      return !paired && !at && path.every(node => typeof node.tag !== 'number') ? fiber : null;
    }
    let budget = 4096;
    for (let index = path.length - 1; index >= 0; index -= 1) {
      const wanted = path[index];
      let selected = null;
      for (let child = base.node.child; child; child = child.sibling) {
        if (--budget < 0) return null;
        if (child !== wanted && child !== wanted.alternate) continue;
        if (selected) return null;
        selected = child;
      }
      if (!selected || base.root.current !== base.current) return null;
      base = {
        root: base.root,
        current: base.current,
        node: selected,
        view: view(selected, base.view)
      };
      remember(wanted, base);
    }
    return base.view;
  }

  function fiberOf(node) {
    if (!node) return null;
    for (const key in node) {
      if (key.startsWith('__reactFiber$')) return committedPath(node[key]);
    }
    return null;
  }

  function modelId(value) {
    return typeof value === 'string' && /^[a-zA-Z0-9._-]{1,80}$/.test(value) ? value : null;
  }

  function groupId(value) {
    return typeof value === 'string'
      && value.length <= 80
      && /^[\p{L}\p{N}._ -]+$/u.test(value)
      && value.trim() === value
      && value.trim()
      ? value
      : null;
  }

  function label(value) {
    return typeof value === 'string' && value.trim().length > 0 && value.length <= 80
      ? value.trim()
      : null;
  }

  function shellProExecutionModel(value) {
    const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
    return /^(?:pro|(?:gpt-?)?\d+(?:[.-]\d+)?-pro)$/.test(normalized);
  }

  function closedPickerSelection(node) {
    if (!node) return null;
    const machine = node.getAttribute('data-selected-reasoning-effort');
    const captionEffort = ({
      instant: 'none',
      minimal: 'minimal',
      low: 'low',
      medium: 'medium',
      high: 'high',
      'extra high': 'xhigh',
      max: 'max',
      ultra: 'ultra',
      pro: 'pro'
    })[String(node.textContent || '').trim().toLowerCase()];
    let model = null;
    let lane = null;
    for (let fiber = fiberOf(node), up = 0; fiber && up < MAX_CLIMB; up += 1, fiber = fiber.return) {
      const selection = fiber.memoizedProps?.selectedPowerSelection
        ?? fiber.memoizedProps?.selectedLabelCandidate;
      if (lane === null && selection) {
        lane = {
          model: selection.model,
          effort: ({
            instant: 'none',
            minimal: 'minimal',
            low: 'low',
            medium: 'medium',
            high: 'high',
            'extra high': 'xhigh',
            max: 'max',
            ultra: 'ultra',
            pro: 'pro'
          })[String(selection.labels?.effort ?? selection.sliderLabel ?? '').trim().toLowerCase()] ?? null
        };
      }
      const current = fiber.memoizedProps?.currentModelId;
      if (current === undefined) continue;
      if (typeof current !== 'string' || !/^[a-zA-Z0-9._-]{1,80}$/.test(current) || (model && model !== current)) {
        return null;
      }
      model = current;
    }
    const effort = shellProExecutionModel(model)
      ? 'pro'
      : (lane && lane.model === model && lane.effort)
        || (machine !== null && REASONING.has(machine) ? machine : captionEffort);
    return model && effort ? { id: model, effort } : null;
  }

  function readPickerSnapshot(node) {
    let fiber = node && fiberOf(node);
    for (let up = 0; fiber && up < MAX_CLIMB; up += 1, fiber = fiber.return) {
      const owner = fiber.memoizedProps;
      const props = owner?.composerIntelligencePickerState ? owner : owner?.dropdownContent?.props;
      const state = props?.composerIntelligencePickerState;
      const data = props?.modelsData;
      if (!state || !Array.isArray(data?.versions)) continue;
      if (data.versions.length > 20 || !Array.isArray(state.bucketSelections) || state.bucketSelections.length > 12) {
        return null;
      }
      const effortOf = choice => choice.category?.modelLane === 'pro'
        ? 'pro'
        : ['auto', 'instant'].includes(choice.category?.modelLane)
          ? 'none'
          : choice.thinkingEffort === 'max' && choice.modelConfig?.isWorkModeModel === true
            ? 'max'
            : ({
                min: 'low',
                standard: 'medium',
                extended: 'high',
                max: 'xhigh',
                minimal: 'minimal',
                low: 'low',
                medium: 'medium',
                high: 'high',
                xhigh: 'xhigh',
                ultra: 'ultra'
              })[choice.thinkingEffort] || null;
      const choices = state.bucketSelections.map(choice => {
        const short = label(choice.category?.shortLabel);
        const family = data.versions.find(version => version.id === choice.category?.modelVersion);
        return {
          bucket: choice.bucket,
          id: modelId(choice.modelSlug),
          label: short && /^\d/.test(short) ? `GPT-${short}` : short,
          effort: effortOf(choice),
          familyId: modelId(choice.category?.modelVersion) || modelId(choice.modelSlug),
          familyLabel: label(family?.displayTextForIntelligence)
            || label(choice.modelConfig?.title)
            || (short && /^\d/.test(short) ? `GPT-${short}` : short),
          available: choice.availability?.status === 'available'
            && !props.modelSwitcherDenialsBySlug?.[choice.modelSlug]
        };
      });
      const versions = data.versions
        .filter(version => version.enabled === true)
        .map(version => ({ id: groupId(version.id), label: label(version.displayTextForIntelligence) }));
      if (
        !versions.length
        || versions.some(item => !item.id || !item.label)
        || choices.some(item => !Number.isInteger(item.bucket) || !item.id || !item.label || !item.effort || !item.familyId || !item.familyLabel)
        || new Set(versions.map(item => item.id)).size !== versions.length
        || new Set(choices.map(item => item.bucket)).size !== choices.length
      ) return null;
      const version = groupId(state.selectedVersionEntry?.id);
      const currentBucket = state.currentBucket;
      if (!versions.some(item => item.id === version) || !choices.some(item => item.bucket === currentBucket)) return null;
      const selected = state.currentSelection;
      const chosen = choices.find(item => item.bucket === currentBucket);
      if (selected?.modelSlug !== chosen.id || effortOf(selected) !== chosen.effort) return null;
      return { version, currentBucket, versions, choices };
    }
    return null;
  }

  function readShellPickerSnapshot(node) {
    for (let fiber = node && fiberOf(node), up = 0; fiber && up < MAX_CLIMB; up += 1, fiber = fiber.return) {
      const props = fiber.memoizedProps;
      if (!Array.isArray(props?.powerSelections)) continue;
      const selected = props.selectedPowerSelection ?? props.selectedLabelCandidate;
      const options = props.modelListConfig?.options;
      if (!selected || !Array.isArray(options) || options.length > 20 || props.powerSelections.length > 12) {
        return null;
      }
      const effort = value => ({
        none: 'none',
        instant: 'none',
        minimal: 'minimal',
        min: 'low',
        low: 'low',
        standard: 'medium',
        medium: 'medium',
        extended: 'high',
        high: 'high',
        xhigh: 'xhigh',
        'extra high': 'xhigh',
        max: 'max',
        ultra: 'ultra',
        pro: 'pro'
      })[value] || null;
      const laneEffort = choice => shellProExecutionModel(choice?.model)
        ? 'pro'
        : effort(String(choice?.labels?.effort ?? choice?.sliderLabel ?? '').trim().toLowerCase())
          ?? effort(choice?.reasoningEffort);
      const current = options.filter(item => item?.selected === true);
      if (current.length !== 1) return null;
      const version = groupId(current[0].id);
      const versions = options
        .filter(item => item && item.disabled !== true)
        .map(item => ({ id: groupId(item.id), label: label(item.label) }));
      const choices = props.powerSelections.map(choice => ({
        bucket: choice?.powerSettingIndex,
        id: modelId(choice?.model),
        label: label(choice?.modelLabel),
        familyId: modelId(choice?.model),
        familyLabel: label(choice?.modelLabel),
        effort: laneEffort(choice),
        available: props.modelSelectionDisabled !== true
          && choice?.disabled !== true
          && (!choice?.availability || choice.availability.status === 'available')
          && !props.modelSwitcherDenialsBySlug?.[choice?.model]
      }));
      if (
        !version
        || !versions.length
        || versions.some(item => !item.id || !item.label)
        || !choices.length
        || choices.some(item => !Number.isInteger(item.bucket) || !item.id || !item.label || !item.effort)
        || new Set(versions.map(item => item.id)).size !== versions.length
        || new Set(choices.map(item => item.bucket)).size !== choices.length
        || !versions.some(item => item.id === version)
      ) return null;
      const matches = choices.filter(item => item.id === modelId(selected.model) && item.effort === laneEffort(selected));
      if (matches.length !== 1 || (selected.powerSettingIndex !== undefined && selected.powerSettingIndex !== matches[0].bucket)) {
        return null;
      }
      return { version, currentBucket: matches[0].bucket, versions, choices };
    }
    return null;
  }

  function pickerSnapshot() {
    const form = document.querySelector(
      '#prompt-textarea, form[data-chatgpt-composer] [contenteditable="true"][role="textbox"]'
    )?.closest('form');
    const reported = '[data-codex-intelligence-trigger],[data-composer-navigation-target="reasoning"]';
    const triggers = [...new Set([
      ...(form?.querySelectorAll('button[aria-haspopup="menu"]') || []),
      ...document.querySelectorAll(reported)
    ])].filter(node => (
      node.matches('button,[role="button"]')
      && !node.closest('[data-testid^="conversation-turn"],[data-message-author-role],.markdown,[contenteditable],[hidden],[aria-hidden="true"],[inert]')
      && node.getClientRects().length > 0
      && node.id !== 'composer-plus-btn'
      && node.getAttribute('data-testid') !== 'composer-plus-btn'
    ));
    const candidates = [];
    if (triggers.length <= 8) {
      for (const trigger of triggers) {
        try {
          const picker = readPickerSnapshot(trigger) || readShellPickerSnapshot(trigger);
          if (picker) candidates.push({ node: trigger, picker });
        } catch {
          // An unrelated menu is not model-picker evidence.
        }
      }
    }
    const specific = candidates.filter(candidate => candidate.node.matches(reported));
    const identified = specific.length === 1 ? specific[0] : candidates.length === 1 ? candidates[0] : null;
    const native = triggers.filter(trigger => trigger.matches(reported));
    const fallback = native.length === 1 ? native[0] : triggers.length === 1 ? triggers[0] : null;
    const node = document.querySelector(PICKER) || identified?.node || fallback;
    let state = null;
    try {
      state = identified?.picker || readPickerSnapshot(node) || readShellPickerSnapshot(node);
    } catch {
      state = null;
    }
    const selected = state
      ? state.choices.find(choice => choice.bucket === state.currentBucket && choice.available)
      : node === fallback
        ? closedPickerSelection(node)
        : null;
    const provenTrigger = identified?.node || (selected && node === fallback ? fallback : null);
    for (const trigger of triggers) {
      if (trigger !== provenTrigger) trigger.removeAttribute('data-l2chart-picker-route');
      else trigger.setAttribute('data-l2chart-picker-route', location.pathname);
      if (trigger !== node) {
        trigger.removeAttribute('data-l2chart-selected-model');
        trigger.removeAttribute('data-l2chart-selected-effort');
        trigger.removeAttribute('data-l2chart-selected-route');
      }
    }
    if (node) {
      for (const [name, value] of [
        ['data-l2chart-selected-model', selected?.id],
        ['data-l2chart-selected-effort', selected?.effort],
        ['data-l2chart-selected-route', selected && location.pathname]
      ]) {
        if (!value) node.removeAttribute(name);
        else node.setAttribute(name, value);
      }
    }
    return state;
  }

  function channelOf(message) {
    return message && typeof message === 'object' ? str(message.channel) : '';
  }

  function neverTerminalChannel(message) {
    const channel = channelOf(message);
    return channel === 'analysis' || channel === 'commentary';
  }

  function turnEndMessageId(messages) {
    if (!Array.isArray(messages)) return null;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (!message || typeof message !== 'object' || message.author?.role !== 'assistant') continue;
      const contentType = message.content?.content_type;
      if (!['text', 'multimodal_text', 'image'].includes(contentType)) continue;
      if (neverTerminalChannel(message)) continue;
      if (message.end_turn === true && message.status === 'finished_successfully') return str(message.id);
      return null;
    }
    return null;
  }

  function messageText(message) {
    const content = message?.content;
    if (!content || typeof content !== 'object') return '';
    if (typeof content.text === 'string') return content.text.slice(0, 128_000);
    if (!Array.isArray(content.parts)) return '';
    const parts = [];
    for (const part of content.parts) {
      if (typeof part === 'string') parts.push(part);
      else if (part && typeof part === 'object' && typeof part.text === 'string') parts.push(part.text);
    }
    return parts.join('\n').trim().slice(0, 128_000);
  }

  function turnMessagesOf(fiber) {
    for (let at = fiber, up = 0; at && up < MAX_CLIMB; up += 1, at = at.return) {
      const props = at.memoizedProps;
      const turn = props?.turn;
      if (turn && typeof turn === 'object' && Array.isArray(turn.messages)) return turn.messages;
      if (Array.isArray(props?.allMessages)) return props.allMessages;
    }
    return null;
  }

  function turnViewMessages(fiber) {
    for (let at = fiber, up = 0; at && up < MAX_CLIMB; up += 1, at = at.return) {
      const turn = at.memoizedProps?.turn;
      if (!turn || typeof turn !== 'object' || !Array.isArray(turn.items)) continue;
      const out = [];
      for (const item of turn.items) {
        if (item?.type === 'user-message') {
          const id = str(item.messageId) || str(item.serverMessageId);
          if (id) out.push({
            id,
            author: { role: 'user' },
            content: { content_type: 'text', parts: [] }
          });
          continue;
        }
        if (item?.type !== 'assistant-message') continue;
        const id = str(item.messageId) || str(item.latestMessageId);
        if (!id) continue;
        const phase = str(item.phase);
        const complete = item.completed === true;
        const text = typeof item.content === 'string' ? item.content.slice(0, 128_000) : '';
        out.push({
          id,
          author: { role: 'assistant' },
          channel: phase === 'final_answer' ? 'final' : 'commentary',
          status: complete ? 'finished_successfully' : 'in_progress',
          end_turn: complete && phase === 'final_answer' && turn.status === 'complete',
          content: { content_type: 'text', parts: text ? [text] : [] }
        });
      }
      return out;
    }
    return null;
  }

  function shellMessages(fiber) {
    for (let at = fiber, up = 0; at && up < 16; up += 1, at = at.return) {
      const entry = at.memoizedProps?.entry;
      if (!Array.isArray(entry?.turn?.items)) continue;
      const out = [];
      for (const item of entry.turn.items) {
        if (!['user-message', 'assistant-message'].includes(item?.type)) continue;
        const user = item.type === 'user-message';
        const id = str(item.messageId) || (user ? str(item.serverMessageId) : str(item.latestMessageId));
        if (!id) continue;
        if (user) {
          out.push({
            id,
            author: { role: 'user' },
            content: { content_type: 'text', parts: [] }
          });
          continue;
        }
        const final = item.phase === 'final_answer';
        const completed = final && item.completed === true && entry.turn.status === 'complete';
        const text = typeof item.content === 'string' ? item.content.slice(0, 128_000) : '';
        out.push({
          id,
          author: { role: 'assistant' },
          channel: final ? 'final' : 'commentary',
          end_turn: completed,
          status: completed ? 'finished_successfully' : 'in_progress',
          content: { content_type: 'text', parts: text ? [text] : [] }
        });
      }
      return out;
    }
    return null;
  }

  function finalMessages() {
    const finals = new Map();
    const sections = [...document.querySelectorAll(TURN_SECTION)].slice(-80);
    for (const section of sections) {
      const fiber = fiberOf(section);
      if (!fiber) continue;
      const messages = shellMessages(fiber) || turnViewMessages(fiber) || turnMessagesOf(fiber);
      const id = turnEndMessageId(messages);
      if (!id || finals.has(id)) continue;
      const terminal = Array.isArray(messages) ? messages.find(message => str(message?.id) === id) : null;
      const text = messageText(terminal);
      if (text) finals.set(id, { id, text });
    }
    return [...finals.values()].slice(-80);
  }

  function userMessageIds() {
    const ids = new Set();
    const sections = [...document.querySelectorAll(TURN_SECTION)].slice(-80);
    for (const section of sections) {
      const fiber = fiberOf(section);
      if (!fiber) continue;
      const messages = shellMessages(fiber) || turnViewMessages(fiber) || turnMessagesOf(fiber);
      if (!Array.isArray(messages)) continue;
      for (const message of messages) {
        if (message?.author?.role !== 'user') continue;
        const id = str(message.id);
        if (id) ids.add(id);
      }
    }
    return [...ids].slice(-120);
  }

  const listener = event => {
    if (event.source !== window || event.origin !== location.origin) return;
    const data = event.data;
    if (!data || data.source !== 'l2chart-page-model-ask' || typeof data.nonce !== 'string') return;
    let picker = null;
    let finals = [];
    if (data.kind === 'picker') {
      try {
        picker = pickerSnapshot();
      } catch {
        picker = null;
      }
    } else if (data.kind === 'finals') {
      try {
        finals = finalMessages();
      } catch {
        finals = [];
      }
    } else if (data.kind === 'users') {
      try {
        finals = userMessageIds();
      } catch {
        finals = [];
      }
    } else {
      return;
    }
    window.postMessage({
      source: 'l2chart-page-model-reply',
      nonce: data.nonce,
      kind: data.kind,
      picker,
      finals,
      version: 1
    }, location.origin);
  };

  window.addEventListener('message', listener);
  globalThis[ACTIVE] = {
    stop() {
      window.removeEventListener('message', listener);
    }
  };
})();
