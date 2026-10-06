'use strict';

const BRIDGE_BASE = 'http://127.0.0.1:8788';
const BINDING_KEY = 'l2chart.chatgpt.binding.v1';
const CHAT_HOME = 'https://chatgpt.com/';
const CHAT_URLS = ['https://chatgpt.com/*', 'https://chat.openai.com/*'];
const ALARM_NAME = 'l2chart-bridge-wake';
const SOURCE_VERSION = 'phase1a-20261006';
const POLL_RETRY_MS = 1_000;
const CONTENT_READY_MS = 30_000;

let polling = false;
let stopped = false;

function headers(json = false) {
  return {
    'x-l2chart-extension-id': chrome.runtime.id,
    ...(json ? { 'content-type': 'application/json' } : {})
  };
}

async function bridgeFetch(path, options = {}) {
  const response = await fetch(BRIDGE_BASE + path, {
    cache: 'no-store',
    ...options,
    headers: {
      ...headers(Boolean(options.body)),
      ...(options.headers || {})
    }
  });
  const body = await response.text();
  let payload = {};
  if (body) {
    try {
      payload = JSON.parse(body);
    } catch {
      throw new Error('bridge_invalid_json_' + response.status);
    }
  }
  if (!response.ok) {
    throw new Error(typeof payload?.error === 'string' ? payload.error : 'bridge_http_' + response.status);
  }
  return payload;
}

function isChatUrl(url) {
  try {
    const parsed = new URL(url);
    return (
      ['chatgpt.com', 'chat.openai.com'].includes(parsed.hostname)
      && !parsed.pathname.startsWith('/share/')
    );
  } catch {
    return false;
  }
}

function conversationFromUrl(url) {
  if (!isChatUrl(url)) return null;
  try {
    const parsed = new URL(url);
    return /^\/(?:g\/[^/]+\/)?c\/([0-9a-f-]{8,64})(?:\/|$)/i.exec(parsed.pathname)?.[1] ?? null;
  } catch {
    return null;
  }
}

function freshChatUrl(model, reasoningEffort) {
  const url = new URL(CHAT_HOME);
  if (typeof model === 'string' && model.trim()) url.searchParams.set('model', model.trim());
  if (typeof reasoningEffort === 'string' && reasoningEffort.trim()) {
    url.searchParams.set('reasoning_effort', reasoningEffort.trim());
  }
  return url.toString();
}

async function readBinding() {
  const stored = await chrome.storage.local.get(BINDING_KEY);
  const value = stored[BINDING_KEY];
  if (
    !value
    || typeof value !== 'object'
    || typeof value.sessionId !== 'string'
    || !Number.isInteger(value.tabId)
  ) return null;
  return {
    sessionId: value.sessionId,
    tabId: value.tabId,
    conversationId: typeof value.conversationId === 'string' ? value.conversationId : null
  };
}

async function writeBinding(binding) {
  if (!binding) {
    await chrome.storage.local.remove(BINDING_KEY);
    return;
  }
  await chrome.storage.local.set({ [BINDING_KEY]: binding });
}

async function tabById(tabId) {
  if (!Number.isInteger(tabId)) return null;
  try {
    const tab = await chrome.tabs.get(tabId);
    return tab?.id === tabId && isChatUrl(tab.url) ? tab : null;
  } catch {
    return null;
  }
}

async function matchingConversationTab(conversationId) {
  if (!conversationId) return null;
  const tabs = await chrome.tabs.query({ url: CHAT_URLS });
  const matches = tabs.filter(tab => conversationFromUrl(tab.url) === conversationId);
  return matches.length === 1 ? matches[0] : null;
}

async function createFreshTab(payload = {}) {
  const tab = await chrome.tabs.create({
    url: freshChatUrl(payload.model, payload.reasoningEffort),
    active: false
  });
  if (!Number.isInteger(tab?.id)) throw new Error('chat_tab_unavailable');
  return {
    sessionId: payload.sessionId,
    tabId: tab.id,
    conversationId: null
  };
}

async function closeOwnedTab(binding) {
  if (!Number.isInteger(binding?.tabId)) return;
  try {
    await chrome.tabs.remove(binding.tabId);
  } catch {
    // The tab may already be gone.
  }
}

async function waitForContent(tabId, timeoutMs = CONTENT_READY_MS) {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'content_script_unavailable';
  while (Date.now() < deadline) {
    try {
      const reply = await chrome.tabs.sendMessage(tabId, { type: 'l2chart:ping' });
      if (reply?.ok === true) return reply;
      if (typeof reply?.error === 'string') lastError = reply.error;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(lastError);
}

async function sendToContent(tabId, message, timeoutMs = 190_000) {
  await waitForContent(tabId);
  return await Promise.race([
    chrome.tabs.sendMessage(tabId, message),
    new Promise((_, reject) => setTimeout(() => reject(new Error('content_command_timeout')), timeoutMs))
  ]);
}

async function ensureBinding(payload) {
  let binding = await readBinding();
  if (binding?.sessionId === payload.sessionId) {
    let tab = await tabById(binding.tabId);
    if (tab) {
      const actual = conversationFromUrl(tab.url);
      if ((payload.conversationId ?? null) === actual) return binding;
    }
    if (payload.conversationId) {
      tab = await matchingConversationTab(payload.conversationId);
      if (tab?.id) {
        binding = { ...binding, tabId: tab.id, conversationId: payload.conversationId };
        await writeBinding(binding);
        return binding;
      }
      const opened = await chrome.tabs.create({
        url: CHAT_HOME + 'c/' + encodeURIComponent(payload.conversationId),
        active: false
      });
      if (!Number.isInteger(opened?.id)) throw new Error('chat_tab_unavailable');
      binding = { ...binding, tabId: opened.id, conversationId: payload.conversationId };
      await writeBinding(binding);
      return binding;
    }
  }

  if (payload.conversationId) {
    const tab = await matchingConversationTab(payload.conversationId)
      ?? await chrome.tabs.create({
        url: CHAT_HOME + 'c/' + encodeURIComponent(payload.conversationId),
        active: false
      });
    if (!Number.isInteger(tab?.id)) throw new Error('chat_tab_unavailable');
    binding = {
      sessionId: payload.sessionId,
      tabId: tab.id,
      conversationId: payload.conversationId
    };
    await writeBinding(binding);
    return binding;
  }

  const prior = binding;
  binding = await createFreshTab(payload);
  await writeBinding(binding);
  if (prior?.tabId !== binding.tabId) await closeOwnedTab(prior);
  return binding;
}

function unwrapContent(reply, fallback = 'chatgpt_content_error') {
  if (reply?.ok === true) return reply;
  const error = new Error(typeof reply?.error === 'string' && reply.error ? reply.error : fallback);
  error.code = error.message.toUpperCase().replace(/[^A-Z0-9]+/g, '_').slice(0, 80);
  throw error;
}

async function processModels() {
  const current = await readBinding();
  let candidate = current && await tabById(current.tabId) ? current : null;
  let temporary = false;
  if (!candidate) {
    candidate = await createFreshTab({ sessionId: 'catalog-' + crypto.randomUUID() });
    temporary = true;
  }
  try {
    const reply = unwrapContent(await sendToContent(candidate.tabId, { type: 'l2chart:models' }, 90_000));
    return { models: reply.models ?? [] };
  } finally {
    if (temporary) await closeOwnedTab(candidate);
  }
}

async function processNewChat(payload) {
  const candidate = await createFreshTab(payload);
  try {
    const prepared = unwrapContent(await sendToContent(candidate.tabId, {
      type: 'l2chart:prepare',
      payload: {
        conversationId: null,
        model: payload.model ?? null,
        reasoningEffort: payload.reasoningEffort ?? null
      }
    }, 90_000));
    const prior = await readBinding();
    await writeBinding(candidate);
    if (prior && prior.tabId !== candidate.tabId) await closeOwnedTab(prior);
    return {
      conversationId: null,
      selection: prepared.selection ?? null
    };
  } catch (error) {
    await closeOwnedTab(candidate);
    throw error;
  }
}

async function processChatSend(payload) {
  const binding = await ensureBinding(payload);
  const reply = unwrapContent(await sendToContent(binding.tabId, {
    type: 'l2chart:send',
    payload
  }, 190_000));
  if (typeof reply.conversationId !== 'string' || !reply.conversationId) {
    throw new Error('conversation_id_missing');
  }
  if (payload.conversationId && payload.conversationId !== reply.conversationId) {
    throw new Error('conversation_identity_changed');
  }
  const next = {
    sessionId: payload.sessionId,
    tabId: binding.tabId,
    conversationId: reply.conversationId
  };
  await writeBinding(next);
  return {
    conversationId: reply.conversationId,
    message: reply.message,
    selection: reply.selection ?? null,
    userMessageId: reply.userMessageId ?? null,
    assistantMessageId: reply.assistantMessageId ?? null
  };
}

async function processCancel(payload) {
  const binding = await readBinding();
  if (!binding || binding.sessionId !== payload.sessionId) return { cancelled: false };
  const tab = await tabById(binding.tabId);
  if (!tab) return { cancelled: false };
  const reply = await sendToContent(binding.tabId, {
    type: 'l2chart:cancel',
    payload: { requestId: payload.requestId }
  }, 10_000);
  return { cancelled: reply?.cancelled === true };
}

async function processStatus(payload) {
  const binding = await readBinding();
  if (!binding || binding.sessionId !== payload.sessionId) {
    return { conversationId: null, selection: null };
  }
  const tab = await tabById(binding.tabId);
  if (!tab) return { conversationId: binding.conversationId, selection: null };
  const reply = unwrapContent(await sendToContent(binding.tabId, { type: 'l2chart:status' }, 15_000));
  return {
    conversationId: reply.conversationId ?? binding.conversationId,
    selection: reply.selection ?? null
  };
}

async function processCommand(command) {
  if (!command || typeof command.id !== 'string' || typeof command.type !== 'string') {
    throw new Error('invalid_bridge_command');
  }
  const payload = command.payload && typeof command.payload === 'object' ? command.payload : {};
  if (command.type === 'models') return await processModels();
  if (command.type === 'new_chat') return await processNewChat(payload);
  if (command.type === 'chat_send') return await processChatSend(payload);
  if (command.type === 'cancel') return await processCancel(payload);
  if (command.type === 'status') return await processStatus(payload);
  throw new Error('unsupported_bridge_command');
}

async function postResult(commandId, result) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await bridgeFetch('/bridge/result', {
        method: 'POST',
        body: JSON.stringify({ commandId, result })
      });
      return;
    } catch (error) {
      lastError = error;
      await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }
  throw lastError ?? new Error('bridge_result_failed');
}

async function executeAndReport(command) {
  try {
    const data = await processCommand(command);
    await postResult(command.id, { ok: true, data });
  } catch (error) {
    await postResult(command.id, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      code: typeof error?.code === 'string' ? error.code : 'CHATGPT_EXTENSION_ERROR'
    }).catch(() => undefined);
  }
}

async function pollLoop() {
  if (polling || stopped) return;
  polling = true;
  try {
    while (!stopped) {
      try {
        const payload = await bridgeFetch(`/bridge/poll?source=${encodeURIComponent(SOURCE_VERSION)}`);
        if (payload?.command) void executeAndReport(payload.command);
      } catch {
        await new Promise(resolve => setTimeout(resolve, POLL_RETRY_MS));
      }
    }
  } finally {
    polling = false;
  }
}

chrome.runtime.onInstalled.addListener(() => {
  void chrome.alarms.create(ALARM_NAME, { periodInMinutes: 0.5 });
  void pollLoop();
});

chrome.runtime.onStartup.addListener(() => {
  void chrome.alarms.create(ALARM_NAME, { periodInMinutes: 0.5 });
  void pollLoop();
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === ALARM_NAME) void pollLoop();
});

void chrome.alarms.create(ALARM_NAME, { periodInMinutes: 0.5 });
void pollLoop();
