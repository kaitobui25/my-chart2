import type { AssistantConversationMessage, AssistantProvider } from '../assistant/types';

const HISTORY_KEY = 'l2chart.excel.assistant.history.v1';
const ACTIVE_KEY = 'l2chart.excel.assistant.history.active.v1.';
const MAX_CHATS = 40;
const MAX_MESSAGES = 100;
const MAX_MESSAGE_LENGTH = 8000;
const MAX_STORAGE_CHARS = 1_500_000;
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type StorageReader = Pick<Storage, 'getItem' | 'setItem'>;
type SessionReader = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function browserStorage(kind: 'local' | 'session'): Storage | null {
  try { return kind === 'local' ? localStorage : sessionStorage; } catch { return null; }
}

export interface AssistantHistoryEntry {
  id: string;
  provider: AssistantProvider;
  updatedAt: number;
  messages: AssistantConversationMessage[];
}

function validMessages(value: unknown): AssistantConversationMessage[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): AssistantConversationMessage[] => {
    if (!item || (item.role !== 'user' && item.role !== 'assistant') || typeof item.content !== 'string') return [];
    const content = item.content.trim().slice(0, MAX_MESSAGE_LENGTH);
    return content ? [{ role: item.role, content }] : [];
  }).slice(-MAX_MESSAGES);
}

function validEntries(value: unknown): AssistantHistoryEntry[] {
  if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1
    || !('entries' in value) || !Array.isArray(value.entries)) return [];
  return value.entries.slice(0, MAX_CHATS).flatMap((entry): AssistantHistoryEntry[] => {
    if (!entry || !ID_PATTERN.test(entry.id ?? '') || !['codex', 'chatgpt'].includes(entry.provider)
      || !Number.isFinite(entry.updatedAt)) return [];
    const messages = validMessages(entry.messages);
    return messages.some(message => message.role === 'user')
      ? [{ id: entry.id, provider: entry.provider, updatedAt: entry.updatedAt, messages }]
      : [];
  });
}

/** Browsable local transcript snapshots; never used as native AI session IDs or model context. */
export class AssistantChatHistory {
  private readonly fallbackIds: Partial<Record<AssistantProvider, string>> = {};

  constructor(
    private readonly storage: StorageReader | null = browserStorage('local'),
    private readonly session: SessionReader | null = browserStorage('session'),
  ) {}

  activeId(provider: AssistantProvider): string {
    if (this.fallbackIds[provider]) return this.fallbackIds[provider];
    let existing: string | null = null;
    try { existing = this.session?.getItem(ACTIVE_KEY + provider) ?? null; } catch { /* optional */ }
    const id = existing && ID_PATTERN.test(existing) ? existing : crypto.randomUUID();
    this.fallbackIds[provider] = id;
    try { this.session?.setItem(ACTIVE_KEY + provider, id); } catch { /* optional */ }
    return id;
  }

  newChat(provider: AssistantProvider): void {
    delete this.fallbackIds[provider];
    try { this.session?.removeItem(ACTIVE_KEY + provider); } catch { /* optional */ }
  }

  list(): AssistantHistoryEntry[] {
    try {
      const raw = this.storage?.getItem(HISTORY_KEY);
      return raw ? validEntries(JSON.parse(raw)) : [];
    } catch {
      return [];
    }
  }

  get(id: string): AssistantHistoryEntry | null {
    return this.list().find(entry => entry.id === id) ?? null;
  }

  /** Migrate the previous Codex tab transcript once, without replacing a richer archive. */
  seed(provider: AssistantProvider, messages: AssistantConversationMessage[]): void {
    const id = this.activeId(provider);
    const entries = this.list();
    if (!entries.some(entry => entry.id === id)) this.save(id, provider, messages, entries);
  }

  append(provider: AssistantProvider, role: AssistantConversationMessage['role'], content: string): void {
    const id = this.activeId(provider);
    const entries = this.list();
    const previous = entries.find(entry => entry.id === id);
    this.save(id, provider, [...(previous?.messages ?? []), { role, content }], entries);
  }

  private save(id: string, provider: AssistantProvider, source: AssistantConversationMessage[], previous: AssistantHistoryEntry[]): void {
    const messages = validMessages(source);
    if (!messages.some(message => message.role === 'user')) return;
    const entries = previous.filter(entry => entry.id !== id);
    entries.unshift({ id, provider, updatedAt: Date.now(), messages });
    entries.length = Math.min(entries.length, MAX_CHATS);
    let serialized = JSON.stringify({ version: 1, entries });
    while (serialized.length > MAX_STORAGE_CHARS && entries.length > 1) {
      entries.pop();
      serialized = JSON.stringify({ version: 1, entries });
    }
    try { this.storage?.setItem(HISTORY_KEY, serialized); } catch { /* storage is optional */ }
  }
}
