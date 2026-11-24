import { afterEach, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { assistantStreamForHost, startAssistantForHost } from '../core/assistantStream';
import { messagesForPresentation, messagesForTransport } from '../core/hostMessages';
import { historyForHost } from '../core/historyForHost';
import { ConversationMessages } from './ConversationMessages';
import type { RawMessage } from '../core/types';

afterEach(cleanup);
const options = { mode: 'assistant', sessionKey: 'session' } as const;
const labels = { confirm: 'Confirm', confirmed: 'Confirmed', thinking: 'Thinking', completed: 'Done',
  deepThinking: 'Thinking deeply', deepThought: 'Thought deeply', reasoningContent: 'Reasoning', toolInput: 'Input', toolResult: 'Result', toolError: 'Failed', stopped: 'Stopped' };
function transcript(rows: RawMessage[], running = false) {
  return <ConversationMessages messages={messagesForPresentation(rows, options)} assistantTimeline running={running} canExecute
    labels={labels} slots={{ content: text => text, attachments: message => message.files.map(file => <span key={file.name}>{file.name}</span>) }} />;
}
const toolStart = { type: 'start', category: 'knowledge', extra: '{"run_id":"run1"}', message: { tool_key: 'Search', input_str: 'apple' } };
const toolEnd = { type: 'end', category: 'knowledge', extra: '{"run_id":"run1"}', message: { tool_key: 'Search', output: 'Found apple' } };
const reasoning = (reasoning_content: string) => ({ type: 'stream', message: { reasoning_content, content: '' } });

it('shows one readable result per knowledge base for serialized retrieval chunks', () => {
  const chunk = '<knowledge_base_id>1</knowledge_base_id><knowledge_base_name>Research</knowledge_base_name><paragraph_content>chunk body</paragraph_content>';
  const rows = historyForHost([{ ...toolEnd, message: { tool_key: 'Search', output: JSON.stringify([chunk, chunk]) } },
    { category: 'answer', message: 'Reply', id: 9 }], options);
  render(<ConversationMessages messages={messagesForPresentation(rows, options)} assistantTimeline canExecute
    labels={{ ...labels, knowledgeResults: count => `Knowledge results: ${count}` }} slots={{ content: text => text }} />);
  fireEvent.click(screen.getByRole('button', { name: 'Thought deeply' }));
  fireEvent.click(screen.getByRole('button', { name: 'Knowledge results: 1' }));
  expect(screen.getAllByText('Research')).toHaveLength(1);
  expect(screen.queryByText(/paragraph_content/)).toBeNull();
});

it('streams passages around a tool, updates the same invocation, collapses on the first answer token and reopens', () => {
  const stream = (rows: RawMessage[], frame: RawMessage) => assistantStreamForHost(rows, frame, options.sessionKey);
  const start = (rows: RawMessage[], frame: RawMessage) => startAssistantForHost(rows, frame, options.sessionKey);
  let rows = stream(start([], { type: 'start', category: 'processing' }), reasoning('Before '));
  rows = stream(rows, reasoning('search'));
  const { rerender } = render(transcript(rows, true));
  expect(screen.getByRole('button', { name: 'Thinking deeply' }).getAttribute('aria-expanded')).toBe('true');
  rows = start(rows, toolStart);
  rerender(transcript(rows, true));
  fireEvent.click(screen.getByRole('button', { name: 'Search' }));
  expect(screen.getByText('apple')).toBeTruthy();
  rows = stream(stream(rows, toolEnd), reasoning('After search'));
  rerender(transcript(rows, true));
  expect(screen.getAllByRole('listitem').map(row => row.textContent)).toEqual(['ReasoningBefore search', 'SearchInputappleResultFound apple', 'ReasoningAfter search']);
  expect(messagesForTransport(rows).some(row => 'chat_reasoning_passages' in row)).toBe(false);
  rows = stream(rows, { type: 'stream', message: 'Answer' });
  rerender(transcript(rows, true));
  const complete = screen.getByRole('button', { name: 'Thought deeply' });
  expect(complete.getAttribute('aria-expanded')).toBe('false');
  expect(screen.queryAllByRole('listitem')).toHaveLength(0);
  expect(screen.getByText('Answer')).toBeTruthy();
  fireEvent.click(complete);
  expect(screen.getAllByRole('listitem')).toHaveLength(3);
});

it('replays the recorded sequence once, joins out-of-order tool details by run ID, and keeps files outside', () => {
  const rows = historyForHost([
    { ...toolEnd, id: 2 },
    { ...toolEnd, id: 3, extra: '{"run_id":"run2"}', message: { tool_key: 'Fetch', output: 'timeout' } },
    { category: 'reasoning_answer', id: 4, message: 'legacy aggregate' },
    { category: 'answer', id: 5, message: 'Reply', files: [{ name: 'report.pdf' }], extra: JSON.stringify({ assistant_timeline: [
      { type: 'reasoning', text: 'First' }, { type: 'tool', run_id: 'run2', tool_key: 'Fetch', status: 'error' },
      { type: 'reasoning', text: 'Second' }, { type: 'tool', run_id: 'run1', tool_key: 'Search', status: 'done' },
    ] }) },
  ], options);
  render(transcript(rows));
  expect(screen.getByText('report.pdf')).toBeTruthy();
  expect(screen.getByText('Reply')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Thought deeply' }).getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(screen.getByRole('button', { name: 'Thought deeply' }));
  const items = screen.getAllByRole('listitem');
  expect(items.map(row => row.textContent)).toEqual(['ReasoningFirst', 'Fetch Failed', 'ReasoningSecond', 'Search']);
  fireEvent.click(within(items[1]).getByRole('button'));
  expect(within(items[1]).getByText('timeout')).toBeTruthy();
  expect(screen.queryByText('legacy aggregate')).toBeNull();
});

it('groups legacy knowledge runs and hidden call/result records under one header with one separate summary', () => {
  const rows = historyForHost([
    { category: 'question', message: 'Question', id: 1 }, { ...toolEnd, id: 2 },
    { ...toolEnd, extra: '{"run_id":"run2"}', id: 3 },
    ...['tool_call', 'tool_result', 'tool_call', 'tool_result'].map((category, index) => ({ category, message: 'Internal', id: 4 + index })),
    { category: 'reasoning_answer', message: 'Aggregate', id: 8 }, { category: 'answer', message: 'Reply', id: 9 },
  ], options);
  render(transcript(rows));
  fireEvent.click(screen.getByRole('button', { name: 'Thought deeply' }));
  expect(screen.getAllByRole('listitem').map(item => item.textContent)).toEqual(['Search', 'Search']);
  expect(screen.getByText('Aggregate').closest('ol')).toBeNull();
  expect(screen.queryByText('Internal')).toBeNull();
});
it.each(['done', 'error'])('uses the server tool status %s when stop raced its end frame', status => {
  const rows = historyForHost([
    { ...toolStart, stopped: true, interrupted: true, end: true },
    { category: 'answer', id: 5, message: 'Partial', stopped: true, extra: JSON.stringify({ assistant_timeline: [
      { type: 'tool', run_id: 'run1', tool_key: 'Search', status },
    ] }) },
  ], options);
  const messages = messagesForPresentation(rows, options);
  render(<ConversationMessages messages={messages} assistantTimeline canExecute labels={labels}
    slots={{ content: text => text, runPresentation: message => ({
      title: message.raw.interrupted ? 'Interrupted' : 'Searched Catalog', unavailable: !!message.raw.interrupted,
    }) }} />);
  fireEvent.click(screen.getByRole('button', { name: 'Stopped' }));
  expect(screen.getByRole('button', { name: status === 'done' ? 'Searched Catalog' : 'Search Failed' })).toBeTruthy();
});
