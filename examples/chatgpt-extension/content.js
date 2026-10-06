(() => {
  'use strict';

  const ACTIVE = '__L2CHART_CONTENT__';
  const previous = globalThis[ACTIVE];
  if (previous && typeof previous.stop === 'function') previous.stop();

  const PICKER = '[data-testid="composer-intelligence-picker-content"], [data-model-picker-view]';
  const STOP =
    'button[data-testid="stop-button"], button[data-testid="composer-stop-button"], ' +
    'button[aria-label="Stop streaming"], button[aria-label="Stop generating"], button[aria-label="Stop answering"]';
  const SEND =
    'button[data-testid="send-button"], form button[aria-label^="Send" i], ' +
    'form[data-chatgpt-composer] button[type="submit"]';
  const STOP_SQUARE = /^\s*M4\.5 5\.75/;
  const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'pro'];
  const activeRequests = new Map();
  let running = true;

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const compactText = value => String(value || '').replace(/\s+/g, '');

  function conversationId(pathname = location.pathname) {
    const match = /^\/(?:g\/[^/]+\/)?c\/([0-9a-f-]{8,64})(?:\/|$)/i.exec(String(pathname || ''));
    return match ? match[1] : null;
  }

  function visible(node) {
    if (!node?.isConnected || node.closest('[hidden],[aria-hidden="true"],[inert]')) return false;
    for (let at = node; at; at = at.parentElement) {
      const style = getComputedStyle(at);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    }
    return node.getClientRects().length > 0;
  }

  function composer() {
    const classic = [...document.querySelectorAll('#prompt-textarea')].filter(visible);
    if (classic.length) return classic.length === 1 ? classic[0] : null;
    const editors = [...document.querySelectorAll(
      'form[data-chatgpt-composer] [contenteditable="true"][role="textbox"], ' +
      'form [data-composer-markdown][contenteditable="true"][role="textbox"]'
    )].filter(node => (
      visible(node)
      && !node.closest('[data-turn-key],.markdown,[data-message-author-role]')
    ));
    return editors.length === 1 ? editors[0] : null;
  }

  function primarySlotControls() {
    const form = composer()?.closest('form');
    if (!form) return [];
    return [...form.querySelectorAll('button[class*="size-token-button-composer"][class*="bg-composer-primary"]')]
      .filter(button => visible(button) && button.closest('form') === form);
  }

  function isStopSquare(button) {
    if (!button || button.hasAttribute('data-state')) return false;
    const paths = button.querySelectorAll('svg path');
    return paths.length === 1 && STOP_SQUARE.test(paths[0].getAttribute('d') || '');
  }

  function nativeComposerControls(selector) {
    const form = composer()?.closest('form');
    return [...(form || document).querySelectorAll(selector)]
      .filter(button => visible(button) && (!form || button.closest('form') === form));
  }

  function stopControls() {
    const labelled = nativeComposerControls(STOP);
    return labelled.length ? labelled : primarySlotControls().filter(isStopSquare);
  }

  function generating() {
    return stopControls().length > 0 || primarySlotControls().some(isStopSquare);
  }

  function localeFreeSendControls() {
    const box = composer();
    const form = box?.closest('form');
    if (!box || !form || compactText(box.textContent) === '' || generating()) return [];
    return primarySlotControls().filter(button => {
      if (button.hasAttribute('data-state') || isStopSquare(button)) return false;
      const paths = button.querySelectorAll('svg path');
      return paths.length >= 1 && paths.length <= 2;
    });
  }

  function sendButton() {
    const labelled = nativeComposerControls(SEND);
    const candidates = labelled.length ? labelled : localeFreeSendControls();
    return candidates.length === 1 ? candidates[0] : null;
  }

  function sendEnabled(button) {
    return Boolean(
      button
      && visible(button)
      && !button.disabled
      && button.getAttribute('aria-disabled') !== 'true'
    );
  }

  function stopGeneration() {
    const controls = stopControls();
    if (controls.length !== 1) return false;
    const button = controls[0];
    if (!visible(button) || button.disabled || button.getAttribute('aria-disabled') === 'true') return false;
    button.click();
    return true;
  }

  function insertPrompt(value) {
    const box = composer();
    if (!box || typeof value !== 'string' || !value.trim()) return { ok: false, error: 'composer_missing' };
    const existing = (box.textContent || '').trim();
    if (existing && compactText(existing) !== compactText(value)) return { ok: false, error: 'composer_has_user_draft' };
    if (existing && compactText(existing) === compactText(value)) return { ok: true };
    try {
      box.focus();
      const selection = document.getSelection();
      if (!selection) return { ok: false, error: 'selection_missing' };
      selection.selectAllChildren(box);
      if (!box.isConnected || composer() !== box || document.activeElement !== box) {
        return { ok: false, error: 'composer_replaced' };
      }
      const paragraph = document.createElement('p');
      const host = box.matches('[data-composer-markdown]') && box.closest('form[data-chatgpt-composer]')
        ? document.createElement('span')
        : paragraph;
      if (host !== paragraph) {
        host.setAttribute('data-prompt-literal-paste', '');
        paragraph.append(host);
      }
      value.split('\n').forEach((line, index) => {
        if (index) host.append(document.createElement('br'));
        host.append(document.createTextNode(line));
      });
      if (!document.execCommand('insertHTML', false, paragraph.innerHTML)) {
        return { ok: false, error: 'native_edit_rejected' };
      }
      if (!box.isConnected || composer() !== box || compactText(box.textContent) !== compactText(value)) {
        return { ok: false, error: 'composer_text_mismatch' };
      }
      return { ok: true };
    } catch {
      return { ok: false, error: 'composer_insert_failed' };
    }
  }

  function messageIdOf(node) {
    const direct = node?.getAttribute?.('data-message-id');
    if (direct) return direct;
    const selected = node?.getAttribute?.('data-chatgpt-selection-message-id')
      || node?.querySelector?.('[data-chatgpt-selection-message-id]')?.getAttribute?.('data-chatgpt-selection-message-id');
    if (selected) return selected;
    const listed = node?.getAttribute?.('data-chatgpt-search-message-ids') || '';
    return listed.trim().split(/\s+/).find(Boolean) || null;
  }

  function userMessageIds() {
    const ids = new Set();
    for (const node of document.querySelectorAll(
      '[data-message-author-role="user"], [data-content-search-unit-key$=":user"], [data-chatgpt-search-unit-key$=":user"]'
    )) {
      const id = messageIdOf(node);
      if (id) ids.add(id);
    }
    return ids;
  }

  function assistantDomMessages() {
    const messages = [];
    const nodes = [...new Set(document.querySelectorAll(
      '[data-message-author-role="assistant"], ' +
      '[data-content-search-unit-key$=":assistant"], ' +
      '[data-chatgpt-search-unit-key$=":assistant"]'
    ))];
    const seen = new Set();
    for (const node of nodes) {
      if (!node?.isConnected) continue;
      const turn = node.closest(
        'section[data-testid^="conversation-turn"], [data-turn-key], ' +
        '[data-content-search-turn-key], [data-chatgpt-search-turn-key]'
      );
      const body = node.querySelector('.markdown, [data-message-content]') || node;
      const text = String(body.innerText || body.textContent || '').trim().slice(0, 128_000);
      if (!text) continue;
      const id = messageIdOf(node)
        || node.getAttribute('data-content-search-unit-key')
        || node.getAttribute('data-chatgpt-search-unit-key')
        || messageIdOf(turn)
        || turn?.getAttribute?.('data-turn-key')
        || turn?.getAttribute?.('data-content-search-turn-key')
        || turn?.getAttribute?.('data-chatgpt-search-turn-key');
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const completed = Boolean(
        turn?.querySelector?.('button[data-testid="copy-turn-action-button"]')
        || node.querySelector?.('button[data-testid="copy-turn-action-button"]')
      );
      messages.push({ id, text, completed });
    }
    return messages.slice(-80);
  }

  function pageModel(kind, timeoutMs = 2_000) {
    return new Promise(resolve => {
      const nonce = crypto.randomUUID();
      let done = false;
      const finish = value => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        window.removeEventListener('message', receive);
        resolve(value);
      };
      const receive = event => {
        const data = event.data;
        if (
          event.source !== window
          || event.origin !== location.origin
          || data?.source !== 'l2chart-page-model-reply'
          || data.nonce !== nonce
          || data.version !== 1
          || data.kind !== kind
        ) return;
        finish(data);
      };
      const timer = setTimeout(() => finish(null), timeoutMs);
      window.addEventListener('message', receive);
      window.postMessage({ source: 'l2chart-page-model-ask', nonce, kind }, location.origin);
    });
  }

  async function readPickerState() {
    const reply = await pageModel('picker');
    const state = reply?.picker;
    if (
      !state
      || typeof state.version !== 'string'
      || !Number.isInteger(state.currentBucket)
      || !Array.isArray(state.versions)
      || !Array.isArray(state.choices)
    ) return null;
    return state;
  }

  async function readFinalMessages() {
    const reply = await pageModel('finals');
    return Array.isArray(reply?.finals)
      ? reply.finals.filter(item => (
          item
          && typeof item.id === 'string'
          && typeof item.text === 'string'
          && item.text.trim()
        )).slice(-80)
      : [];
  }

  async function readNativeUserIds() {
    const reply = await pageModel('users');
    return new Set(Array.isArray(reply?.finals)
      ? reply.finals.filter(value => typeof value === 'string' && value)
      : []);
  }

  function modelPickerTrigger() {
    const reported = '[data-codex-intelligence-trigger],[data-composer-navigation-target="reasoning"]';
    const candidates = [...new Set([
      ...(composer()?.closest('form')?.querySelectorAll('button[aria-haspopup="menu"]') || []),
      ...document.querySelectorAll(reported)
    ])].filter(node => (
      visible(node)
      && !node.closest('[data-testid^="conversation-turn"],[data-message-author-role],.markdown,[contenteditable]')
      && node.id !== 'composer-plus-btn'
      && node.getAttribute('data-testid') !== 'composer-plus-btn'
    ));
    const observed = candidates.filter(node => node.getAttribute('data-l2chart-picker-route') === location.pathname);
    return observed.length === 1
      ? observed[0]
      : candidates.length === 1 && !candidates[0].matches(reported)
        ? candidates[0]
        : null;
  }

  async function prepareChatModelSurface(stillCurrent) {
    const radios = () => [...document.querySelectorAll('[role="radio"][data-tpp-toggle-value]')].filter(visible);
    const state = () => {
      const nodes = radios();
      const chat = nodes.filter(node => node.getAttribute('data-tpp-toggle-value') === 'chatgpt');
      const work = nodes.filter(node => node.getAttribute('data-tpp-toggle-value') === 'work');
      return chat.length === 1 && work.length === 1 ? { chat: chat[0], work: work[0] } : null;
    };
    const before = state();
    if (!stillCurrent()) return false;
    if (!before) return radios().length === 0;
    if (before.chat.getAttribute('aria-checked') === 'true') return true;
    if (
      before.work.getAttribute('aria-checked') !== 'true'
      || before.chat.disabled
      || before.chat.getAttribute('aria-disabled') === 'true'
    ) return false;
    before.chat.click();
    return Boolean(await waitFor(() => {
      const next = state();
      return next?.chat.getAttribute('aria-checked') === 'true'
        && next.work.getAttribute('aria-checked') === 'false';
    }, 5_000, stillCurrent));
  }

  function pickerVersionNamed(row, expected) {
    const text = node => String(node?.textContent || '').replace(/\s+/g, ' ').trim();
    const name = expected.replace(/\s+/g, ' ').trim();
    for (let node = row, depth = 0; node && depth < 8; depth += 1) {
      if (text(node) === name) return true;
      node = [...node.childNodes].find(child => (
        text(child)
        && (child.nodeType === Node.TEXT_NODE
          || child.nodeType === Node.ELEMENT_NODE && !child.matches('svg,[hidden],[aria-hidden="true"],[inert]'))
      ));
    }
    return false;
  }

  function waitFor(read, timeoutMs, stillCurrent = () => true, intervalMs = 100) {
    const deadline = Date.now() + timeoutMs;
    return (async () => {
      while (Date.now() < deadline) {
        if (!running || !stillCurrent()) return null;
        try {
          const value = await read();
          if (value) return value;
        } catch {
          return null;
        }
        await sleep(intervalMs);
      }
      return null;
    })();
  }

  function pickerAccess(stillCurrent) {
    const panel = () => document.querySelector(PICKER);
    const openPanel = () => {
      const value = panel();
      return value && value.closest('[role="menu"],[role="dialog"]')?.getAttribute('data-state') !== 'closed'
        ? value
        : null;
    };
    const state = async predicate => await waitFor(async () => {
      const value = await readPickerState();
      return value && (!predicate || predicate(value)) ? value : null;
    }, 3_500, stillCurrent, 80);
    const readyTrigger = async () => await waitFor(async () => {
      await readPickerState();
      return modelPickerTrigger();
    }, 15_000, stillCurrent, 100);
    const key = (node, value) => {
      if (!node || !stillCurrent()) return false;
      node.focus();
      node.dispatchEvent(new KeyboardEvent('keydown', {
        key: value,
        code: value,
        bubbles: true,
        cancelable: true
      }));
      return true;
    };
    let motion = null;
    return {
      state,
      async open() {
        if (!stillCurrent()) return null;
        motion = document.createElement('style');
        motion.textContent =
          '[role="menu"]:has(> [data-testid="composer-intelligence-picker-content"]),' +
          '[role="dialog"]:has([data-testid="composer-intelligence-picker-content"]),' +
          '[role="menu"]:has([data-model-picker-view]),[role="menu"][data-model-picker-view]' +
          '{animation:none!important}';
        document.head.append(motion);
        if (!await readyTrigger() || !await prepareChatModelSurface(stillCurrent)) return null;
        if (!openPanel()) {
          const trigger = await readyTrigger();
          if (!key(trigger, 'Enter') || !await waitFor(openPanel, 3_500, stillCurrent, 80)) return null;
        }
        return await state();
      },
      async close() {
        try {
          if (!stillCurrent()) return false;
          const value = panel();
          if (!value || !visible(value)) return true;
          const dialog = value.closest('[role="dialog"]');
          const target = value.contains(document.activeElement) || dialog?.contains(document.activeElement)
            ? document.activeElement
            : value;
          if (!key(target, 'Escape')) return false;
          const closed = Boolean(await waitFor(
            () => !visible(panel()) && (!dialog?.isConnected || !visible(dialog)),
            3_500,
            stillCurrent,
            80
          ));
          if (closed) await readPickerState();
          return closed;
        } finally {
          motion?.remove();
          motion = null;
        }
      },
      async version(version) {
        const before = await state();
        if (!before) return null;
        const rows = () => [...(panel()?.querySelectorAll('[role="menuitemradio"]') || [])].filter(visible);
        if (before.version === version && rows().length === 0) return before;
        const expected = before.versions.find(item => item.id === version)?.label;
        if (!expected) return null;
        if (rows().length === 0) {
          const toggles = [...panel().querySelectorAll('[role="menuitem"][aria-expanded], [role="menuitem"][data-model-picker-view-toggle]')]
            .filter(visible);
          if (toggles.length !== 1) return null;
          toggles[0].click();
        }
        const option = await waitFor(() => {
          const matches = rows().filter(node => (
            pickerVersionNamed(node, expected) && node.getAttribute('aria-disabled') !== 'true'
          ));
          return matches.length === 1 ? matches[0] : null;
        }, 3_500, stillCurrent, 80);
        if (!key(option, 'Enter')) return null;
        return await state(next => next.version === version && rows().length === 0);
      },
      async bucket(bucket) {
        let current = await state();
        for (let count = 0; current && count < 12; count += 1) {
          if (current.currentBucket === bucket) return current;
          const from = current.choices.findIndex(item => item.bucket === current.currentBucket);
          const to = current.choices.findIndex(item => item.bucket === bucket);
          if (from < 0 || to < 0) return null;
          const expected = current.choices[from + (to > from ? 1 : -1)].bucket;
          const controls = [...panel().querySelectorAll('[role="menuitem"][aria-keyshortcuts]')]
            .filter(node => visible(node) && node.getAttribute('aria-keyshortcuts').includes('ArrowRight'));
          if (controls.length !== 1 || !key(controls[0], to > from ? 'ArrowRight' : 'ArrowLeft')) return null;
          const version = current.version;
          current = await state(next => next.version === version && next.currentBucket === expected);
        }
        return null;
      }
    };
  }

  const normalizeModelLabel = value => String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}.]/gu, '');

  async function selectModelSettings(model, effort, stillCurrent) {
    // "ChatGPT current" must not depend on the model picker. The picker is an
    // optional native control whose DOM/React shape can change independently of
    // the composer. If no explicit model was requested, keep ChatGPT's current
    // native selection and continue with Send instead of blocking chat.
    if (!model) return { ok: true, selection: null };
    const ui = pickerAccess(stillCurrent);
    const original = await ui.open();
    if (!original) {
      await ui.close();
      return { ok: false, error: 'model_picker_unavailable' };
    }
    let selected = null;
    let closed = false;
    try {
      const current = original.choices.find(choice => choice.bucket === original.currentBucket);
      if (
        current?.available
        && (!model || current.id === model || current.familyId === model)
        && (!effort || current.effort === effort)
      ) {
        selected = current;
      } else {
        const name = normalizeModelLabel(model);
        const offered = [];
        const orderedVersions = [
          original.versions.find(item => item.id === original.version),
          ...original.versions.filter(item => item.id !== original.version)
        ].filter(Boolean);
        for (const version of orderedVersions) {
          const state = await ui.version(version.id);
          if (!state) return { ok: false, error: 'model_picker_unconfirmed' };
          for (const choice of state.choices) {
            if (!choice.available) continue;
            const rank = !model || choice.familyId === model || choice.id === model
              ? 2
              : name && normalizeModelLabel(choice.familyLabel) === name
                ? 1
                : 0;
            if (rank) offered.push({ version: version.id, choice, rank });
          }
        }
        const wantedEffort = EFFORTS.includes(effort) ? effort : null;
        const candidates = offered.filter(entry => !wantedEffort || entry.choice.effort === wantedEffort);
        const rank = Math.max(0, ...candidates.map(entry => entry.rank));
        const matches = candidates.filter(entry => entry.rank === rank);
        if (
          !matches.length
          || (model && new Set(matches.map(entry => entry.choice.familyId)).size !== 1)
        ) return { ok: false, error: 'requested_model_unavailable' };
        const wanted = matches.find(entry => (
          entry.version === original.version && entry.choice.bucket === original.currentBucket
        )) || matches[0];
        const state = await ui.version(wanted.version);
        if (!state?.choices.some(choice => (
          choice.bucket === wanted.choice.bucket
          && choice.available
          && choice.id === wanted.choice.id
          && choice.effort === wanted.choice.effort
        ))) return { ok: false, error: 'model_choice_changed' };
        const after = await ui.bucket(wanted.choice.bucket);
        const confirmed = after?.choices.find(choice => choice.bucket === after.currentBucket);
        if (
          !confirmed?.available
          || confirmed.id !== wanted.choice.id
          || confirmed.effort !== wanted.choice.effort
        ) return { ok: false, error: 'model_selection_failed' };
        selected = confirmed;
      }
    } finally {
      closed = await ui.close();
    }
    if (!selected || !closed || !stillCurrent()) return { ok: false, error: 'model_selection_not_confirmed' };
    return {
      ok: true,
      selection: {
        model: selected.id,
        reasoningEffort: selected.effort
      }
    };
  }

  async function inspectModels(stillCurrent) {
    const ui = pickerAccess(stillCurrent);
    const original = await ui.open();
    if (!original) {
      await ui.close();
      return { ok: false, error: 'model_picker_unavailable' };
    }
    const catalog = new Map();
    let restored = false;
    let closed = false;
    try {
      for (const version of original.versions) {
        const state = await ui.version(version.id);
        if (!state) return { ok: false, error: 'model_picker_unconfirmed' };
        for (const choice of state.choices.filter(item => item.available)) {
          const entry = catalog.get(choice.familyId) || {
            id: choice.familyId,
            label: choice.familyLabel,
            efforts: [],
            aliases: []
          };
          if (!entry.efforts.includes(choice.effort)) entry.efforts.push(choice.effort);
          if (!entry.aliases.includes(choice.id)) entry.aliases.push(choice.id);
          catalog.set(choice.familyId, entry);
        }
      }
    } finally {
      if (stillCurrent() && await ui.version(original.version)) {
        const state = await ui.bucket(original.currentBucket);
        const before = original.choices.find(choice => choice.bucket === original.currentBucket);
        const after = state?.choices.find(choice => choice.bucket === state.currentBucket);
        restored = before?.id === after?.id && before?.effort === after?.effort;
      }
      closed = await ui.close();
    }
    return restored && closed
      ? { ok: true, models: [...catalog.values()] }
      : { ok: false, error: 'model_picker_restore_failed' };
  }

  async function handlePrepare(payload) {
    const expected = payload?.conversationId ?? null;
    const stillCurrent = () => running && conversationId() === expected;
    if (conversationId() !== expected) return { ok: false, error: 'wrong_conversation' };
    if (generating()) return { ok: false, error: 'chat_is_generating' };
    if (!await waitFor(() => composer(), 30_000, stillCurrent)) {
      return { ok: false, error: 'composer_unavailable' };
    }
    const selected = await selectModelSettings(payload?.model ?? null, payload?.reasoningEffort ?? null, stillCurrent);
    if (!selected.ok) return selected;
    if (!await waitFor(() => composer(), 12_000, stillCurrent)) {
      return { ok: false, error: 'composer_unavailable_after_model_selection' };
    }
    return { ok: true, selection: selected.selection };
  }

  async function handleSend(payload) {
    const requestId = payload?.requestId;
    if (typeof requestId !== 'string' || !requestId) return { ok: false, error: 'invalid_request_id' };
    if (activeRequests.size > 0) return { ok: false, error: 'chat_busy' };
    const expectedConversation = payload?.conversationId ?? null;
    if (conversationId() !== expectedConversation) return { ok: false, error: 'wrong_conversation' };
    const active = { cancelled: false };
    activeRequests.set(requestId, active);
    const stillCurrent = () => (
      running
      && !active.cancelled
      && conversationId() === expectedConversation
    );
    try {
      if (generating()) return { ok: false, error: 'chat_is_generating' };
      if (!await waitFor(() => composer(), 30_000, stillCurrent)) {
        return { ok: false, error: active.cancelled ? 'cancelled' : 'composer_unavailable' };
      }
      const selected = await selectModelSettings(
        payload?.model ?? null,
        payload?.reasoningEffort ?? null,
        stillCurrent
      );
      if (!selected.ok) return selected;
      if (!await waitFor(() => composer(), 12_000, stillCurrent)) {
        return { ok: false, error: active.cancelled ? 'cancelled' : 'composer_unavailable_after_model_selection' };
      }
      const baselineUsers = userMessageIds();
      for (const id of await readNativeUserIds()) baselineUsers.add(id);
      const baselineFinals = new Set((await readFinalMessages()).map(item => item.id));
      const baselineDomAssistantIds = new Set(assistantDomMessages().map(item => item.id));
      let sawGenerating = false;
      let stableDomCandidate = null;
      if (!stillCurrent()) return { ok: false, error: active.cancelled ? 'cancelled' : 'route_changed' };
      const insertion = insertPrompt(String(payload?.prompt || ''));
      if (!insertion.ok) return insertion;
      const button = await waitFor(() => {
        const value = sendButton();
        return sendEnabled(value) ? value : null;
      }, 30_000, stillCurrent);
      if (!button) return { ok: false, error: active.cancelled ? 'cancelled' : 'send_unavailable' };
      const box = composer();
      if (
        !box
        || !box.isConnected
        || composer() !== box
        || compactText(box.textContent) !== compactText(payload.prompt)
        || generating()
        || sendButton() !== button
        || !sendEnabled(button)
        || !stillCurrent()
      ) return { ok: false, error: 'send_state_changed' };
      button.click();

      const sentId = await waitFor(async () => {
        if (generating()) sawGenerating = true;
        const observed = userMessageIds();
        for (const id of await readNativeUserIds()) observed.add(id);
        for (const id of observed) if (!baselineUsers.has(id)) return id;
        return null;
      }, 30_000, () => running && !active.cancelled, 100);
      if (!sentId) return { ok: false, error: active.cancelled ? 'cancelled' : 'user_message_not_observed' };

      const concreteConversation = await waitFor(
        () => conversationId(),
        15_000,
        () => running && !active.cancelled,
        100
      );
      if (!concreteConversation) {
        return { ok: false, error: active.cancelled ? 'cancelled' : 'conversation_id_not_observed' };
      }
      if (expectedConversation && concreteConversation !== expectedConversation) {
        return { ok: false, error: 'conversation_changed_during_send' };
      }

      const final = await waitFor(async () => {
        if (conversationId() !== concreteConversation) return null;
        const finals = await readFinalMessages();
        const native = finals.find(item => !baselineFinals.has(item.id));
        if (native) return native;
        if (generating()) {
          sawGenerating = true;
          stableDomCandidate = null;
          return null;
        }
        const dom = assistantDomMessages();
        let candidate = null;
        for (let index = dom.length - 1; index >= 0; index -= 1) {
          if (!baselineDomAssistantIds.has(dom[index].id)) {
            candidate = dom[index];
            break;
          }
        }
        if (!candidate) {
          stableDomCandidate = null;
          return null;
        }
        if (candidate.completed) return candidate;
        if (!sawGenerating) return null;
        const signature = `${candidate.id}\n${candidate.text}`;
        if (stableDomCandidate?.signature !== signature) {
          stableDomCandidate = { signature, since: Date.now() };
          return null;
        }
        return Date.now() - stableDomCandidate.since >= 750 ? candidate : null;
      }, 180_000, () => running && !active.cancelled, 250);
      if (!final) return { ok: false, error: active.cancelled ? 'cancelled' : 'assistant_final_not_observed' };

      return {
        ok: true,
        conversationId: concreteConversation,
        message: final.text.slice(0, 128_000),
        selection: selected.selection,
        userMessageId: sentId,
        assistantMessageId: final.id
      };
    } finally {
      activeRequests.delete(requestId);
    }
  }

  async function handleCommand(message) {
    if (!message || typeof message !== 'object') return { ok: false, error: 'invalid_command' };
    if (message.type === 'l2chart:ping') {
      return { ok: true, conversationId: conversationId() };
    }
    if (message.type === 'l2chart:prepare') return await handlePrepare(message.payload ?? {});
    if (message.type === 'l2chart:models') {
      const expected = conversationId();
      const stillCurrent = () => running && conversationId() === expected && !generating();
      if (!await waitFor(() => composer(), 30_000, stillCurrent)) return { ok: false, error: 'composer_unavailable' };
      return await inspectModels(stillCurrent);
    }
    if (message.type === 'l2chart:status') {
      const picker = await readPickerState();
      const selected = picker?.choices?.find(choice => choice.bucket === picker.currentBucket && choice.available);
      return {
        ok: true,
        conversationId: conversationId(),
        selection: selected ? { model: selected.id, reasoningEffort: selected.effort } : null
      };
    }
    if (message.type === 'l2chart:send') return await handleSend(message.payload ?? {});
    if (message.type === 'l2chart:cancel') {
      const requestId = message.payload?.requestId;
      const active = activeRequests.get(requestId);
      if (!active) return { ok: true, cancelled: false };
      active.cancelled = true;
      stopGeneration();
      return { ok: true, cancelled: true };
    }
    return { ok: false, error: 'unknown_command' };
  }

  const runtimeListener = (message, _sender, sendResponse) => {
    if (!running || !message || typeof message.type !== 'string' || !message.type.startsWith('l2chart:')) {
      return false;
    }
    void handleCommand(message).then(
      value => sendResponse(value),
      error => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) })
    );
    return true;
  };

  chrome.runtime.onMessage.addListener(runtimeListener);
  globalThis[ACTIVE] = {
    stop() {
      running = false;
      chrome.runtime.onMessage.removeListener(runtimeListener);
      for (const active of activeRequests.values()) active.cancelled = true;
      activeRequests.clear();
    }
  };
})();
