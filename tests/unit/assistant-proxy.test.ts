import { describe, expect, it } from 'vitest';

import {
  isAllowedAssistantRequestHeaders,
  sanitizeAssistantProxyHeaders,
} from '../../examples/assistant/vite-plugin';

describe('assistant Vite proxy', () => {
  it('accepts HTTPS same-origin requests when HTTP/2 supplies :authority instead of Host', () => {
    expect(isAllowedAssistantRequestHeaders({
      ':authority': 'localhost:3000',
      origin: 'https://localhost:3000',
      'sec-fetch-site': 'same-origin',
    })).toBe(true);
  });

  it('rejects cross-site requests', () => {
    expect(isAllowedAssistantRequestHeaders({
      host: 'localhost:3000',
      origin: 'https://example.com',
      'sec-fetch-site': 'cross-site',
    })).toBe(false);
  });

  it('strips HTTP/2 pseudo headers and hop-by-hop headers before forwarding', () => {
    expect(sanitizeAssistantProxyHeaders({
      ':method': 'POST',
      ':authority': 'localhost:3000',
      host: 'localhost:3000',
      connection: 'keep-alive',
      'keep-alive': 'timeout=5',
      'content-length': '123',
      'content-type': 'application/json',
      origin: 'https://localhost:3000',
    })).toEqual({
      'content-type': 'application/json',
      origin: 'https://localhost:3000',
    });
  });
});
