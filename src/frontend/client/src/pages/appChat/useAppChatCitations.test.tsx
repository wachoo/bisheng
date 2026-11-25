import { renderHook, waitFor } from '@testing-library/react';
import { normalizeHistory } from '@bisheng/chat/core';
import { transformPrivateCitations } from '@bisheng/chat/citations';
import { resolveCitationDetails } from '~/api/chatApi';
import { useAppChatCitations } from './useAppChatCitations';

jest.mock('~/api/chatApi', () => ({ resolveCitationDetails: jest.fn() }));
const resolver = jest.mocked(resolveCitationDetails);
const citationId = 'knowledgesearch_470c52b7';
const detail = { citationId, type: 'rag', sourcePayload: { items: [{ itemId: '0' }] } };
const options = { mode: 'assistant', sessionKey: 's' } as const;

it('hydrates repeated bare chunk zero on both history and finalized live rows in one authorized request', async () => {
  resolver.mockResolvedValue([detail]);
  const text = Array(6).fill(`${citationId}:0`).join(' ');
  const rows = normalizeHistory([{ category: 'question', message: text }, { category: 'answer', id: 65, message: text },
    { category: 'stream_msg', id: 66, end: true, message: text }], options);
  const { result } = renderHook(() => useAppChatCitations(rows, true));
  await waitFor(() => expect(result.current[1].raw.citations).toEqual([detail]));
  expect(result.current[0].raw.citations).toBeUndefined();
  expect(result.current[2].raw.citations).toEqual([detail]);
  expect(transformPrivateCitations(text, [detail]).transformedContent).toBe(Array(6).fill(`[citationref:${citationId}:0]`).join(' '));
  expect(resolver).toHaveBeenCalledTimes(1);
  expect(resolver).toHaveBeenCalledWith([citationId]);
});

it('normalizes the registry alias immediately and waits for final before resolving absent metadata', () => {
  const rows = normalizeHistory([{ category: 'answer', message: `${citationId}:0`, citation_registry_items: [detail] },
    { category: 'stream_msg', end: false, message: 'websearch_abcd1234:1' }], options);
  const { result } = renderHook(() => useAppChatCitations(rows, true));
  expect(result.current[0].raw.citations).toEqual([detail]);
  expect(result.current[1].text).toBe('');
  expect(rows[1].text).toBe('websearch_abcd1234:1');
  expect(resolver).not.toHaveBeenCalled();
});
