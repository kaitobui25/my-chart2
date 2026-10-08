import { describe, expect, it } from 'vitest';
import { AssistantChatHistory } from '../../examples/excel-content-addin/assistant-chat-history';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

describe('Excel assistant chat history', () => {
  it('archives both providers independently and preserves past chats after New Chat', () => {
    const local = memoryStorage();
    const session = memoryStorage();
    const history = new AssistantChatHistory(local, session);
    const firstCodexId = history.activeId('codex');
    history.append('codex', 'user', 'Phân tích 7203');
    history.append('codex', 'assistant', 'Xu hướng tăng');
    history.append('chatgpt', 'user', 'So sánh 6758');
    const chatGptId = history.activeId('chatgpt');
    history.newChat('codex');
    history.append('codex', 'user', 'Giải thích RSI');
    const secondCodexId = history.activeId('codex');

    expect(secondCodexId).not.toBe(firstCodexId);
    expect(new AssistantChatHistory(local, session).activeId('chatgpt')).toBe(chatGptId);
    expect(new AssistantChatHistory(local, session).activeId('codex')).toBe(secondCodexId);
    expect(history.list()).toHaveLength(3);
    expect(history.get(firstCodexId)?.messages).toEqual([
      { role: 'user', content: 'Phân tích 7203' },
      { role: 'assistant', content: 'Xu hướng tăng' },
    ]);
    expect(history.get(chatGptId)?.provider).toBe('chatgpt');
  });

  it('keeps browsable history when a new browser tab has no session ID', () => {
    const local = memoryStorage();
    const prior = new AssistantChatHistory(local, memoryStorage());
    prior.append('codex', 'user', 'Lịch sử cũ');
    const freshTab = new AssistantChatHistory(local, memoryStorage());
    expect(freshTab.list()[0].messages[0].content).toBe('Lịch sử cũ');
    expect(freshTab.activeId('codex')).not.toBe(prior.activeId('codex'));
  });

  it('migrates an older transcript once without truncating a richer saved history', () => {
    const store = new AssistantChatHistory(memoryStorage(), memoryStorage());
    store.seed('codex', [{ role: 'user', content: 'first' }]);
    store.append('codex', 'assistant', 'answer');
    store.seed('codex', [{ role: 'user', content: 'stale' }]);
    expect(store.list()[0].messages.map(item => item.content)).toEqual(['first', 'answer']);
  });

  it('limits message length, count and number of chats', () => {
    const store = new AssistantChatHistory(memoryStorage(), memoryStorage());
    store.append('codex', 'user', 'x'.repeat(20_000));
    for (let i = 0; i < 120; i++) store.append('codex', 'assistant', `message ${i}`);
    expect(store.list()[0].messages).toHaveLength(100);
    expect(store.list()[0].messages.some(item => item.content.length > 8000)).toBe(false);
    for (let i = 0; i < 50; i++) {
      store.newChat('codex');
      store.append('codex', 'user', `chart ${i}`);
    }
    expect(store.list()).toHaveLength(40);
  });

  it('ignores corrupted data and works with blocked storage', () => {
    const local = memoryStorage();
    local.setItem('l2chart.excel.assistant.history.v1', '{broken');
    const history = new AssistantChatHistory(local, memoryStorage());
    expect(history.list()).toEqual([]);
    history.append('codex', 'user', 'new');
    expect(history.list()).toHaveLength(1);

    const blocked = new AssistantChatHistory({
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
    }, null);
    expect(() => blocked.append('chatgpt', 'user', 'test')).not.toThrow();
    expect(blocked.list()).toEqual([]);
  });
});
