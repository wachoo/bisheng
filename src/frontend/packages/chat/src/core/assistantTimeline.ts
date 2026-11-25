import { assistantRunCategories } from './assistantStream';
import { asRecord, displayText, parsePayload, sourceId } from './normalizeHistory';
import { splitMessageContent } from './messageContent';
import type { ChatMessage } from './types';

export type TimelineStep =
  | { kind: 'reasoning'; key: string; text: string }
  | { kind: 'tool'; key: string; name: string; status: 'running' | 'done' | 'error' | 'stopped'; message?: ChatMessage };

export function isAssistantTool(message: ChatMessage) {
  return assistantRunCategories.some(category => category === message.category);
}

function extra(message: ChatMessage) { return asRecord(parsePayload(message.raw.extra)); }
function stopped(message: ChatMessage) { return message.raw.stopped === true || message.raw.remark === 'break_answer'; }
function runId(message: ChatMessage) {
  return sourceId(extra(message).run_id) ?? sourceId(parsePayload(message.raw.extra));
}
function recordedTimeline(messages: ChatMessage[]) {
  return messages.map(message => extra(message).assistant_timeline).find((value): value is unknown[] =>
    Array.isArray(value) && value.some(entry => {
      const event = asRecord(entry);
      return (event.type === 'reasoning' && typeof event.text === 'string' && !!event.text)
        || (event.type === 'tool' && sourceId(event.run_id) !== undefined);
    }));
}
function tool(key: string, message?: ChatMessage, status?: unknown, name?: unknown): TimelineStep {
  const payload = asRecord(message?.payload);
  const phase = message && extra(message).status;
  const interrupted = message?.raw.interrupted === true;
  const wasStopped = phase === 'stopped' || Boolean(message && stopped(message));
  const failed = phase === 'error' || !!payload.error || /^Error:\s/i.test(displayText(payload.output)) || interrupted;
  return { kind: 'tool', key, name: displayText(name || payload.tool_key || payload.name), message,
    status: status === 'done' || status === 'error' || status === 'stopped' ? status
      : wasStopped ? 'stopped' : failed ? 'error'
      : phase === 'done' || message?.final ? 'done' : 'running' };
}

type Group = { key: string; steps: TimelineStep[]; summary?: string; running: boolean; stopped: boolean; messages: ChatMessage[] };

function buildGroup(messages: ChatMessage[], trailing: boolean): Group {
  const steps: TimelineStep[] = [];
  const summaries = new Set<string>();
  const addReasoning = (text: string, key: string) => {
    if (!text) return;
    const last = steps[steps.length - 1];
    if (last?.kind === 'reasoning') last.text += text;
    else steps.push({ kind: 'reasoning', text, key });
  };
  const tools = messages.filter(isAssistantTool);
  const recorded = recordedTimeline(messages);
  if (recorded) {
    const byId = new Map(tools.map(message => [runId(message), message]));
    recorded.forEach((item, i) => {
      const event = asRecord(item);
      if (event.type === 'reasoning' && typeof event.text === 'string') addReasoning(event.text, String(i));
      if (event.type === 'tool' && sourceId(event.run_id)) {
        const id = String(event.run_id);
        steps.push(tool(id, byId.get(id), event.status, event.tool_key));
      }
    });
  } else {
    // Live passages have a known position. The old aggregate is a turn-level
    // summary; displaying it outside the ordered list preserves that distinction.
    const passages = new Map<string | undefined, string>();
    messages.forEach(message => {
      if (!Array.isArray(message.raw.chat_reasoning_passages)) return;
      for (const value of message.raw.chat_reasoning_passages) {
        const part = asRecord(value);
        const key = sourceId(part.after);
        passages.set(key, (passages.get(key) ?? '') + displayText(part.text));
      }
    });
    addReasoning(passages.get(undefined) ?? '', 'opening');
    messages.forEach(message => {
      if (isAssistantTool(message)) {
        steps.push(tool(message.key, message));
        addReasoning(passages.get(message.key) ?? '', `after-${message.key}`);
      } else if (!Array.isArray(message.raw.chat_reasoning_passages)) {
        const reasoning = message.kind === 'reasoning' ? message.text || message.reasoning
          : message.reasoning || splitMessageContent(message.text).reasoning;
        if (reasoning && tools.length) summaries.add(reasoning);
        else addReasoning(reasoning, message.key);
      }
    });
  }
  const didStop = messages.some(stopped);
  const answerStarted = messages.some(message => message.kind === 'answer' && !!splitMessageContent(message.text).text);
  return { key: messages[0].key, steps, summary: [...summaries].join('\n\n'),
    running: trailing && !didStop && !answerStarted && !recorded, stopped: didStop, messages };
}

/** Only visible non-process messages delimit a group. */
export function assistantGroups(messages: readonly ChatMessage[], running: boolean): Group[] {
  const groups: Group[] = [];
  let batch: ChatMessage[] = [];
  function flush(trailing = false) {
    if (batch.length) groups.push(buildGroup(batch, trailing));
    batch = [];
  }
  for (const message of messages) {
    if (message.kind === 'hidden') continue;
    if (isAssistantTool(message) || message.kind === 'answer' || message.kind === 'reasoning') {
      batch.push(message);
      // Persisted history is ordered by insertion (tools, then answer).
      // Live snapshots may instead update an answer row preceding the tools.
      if (message.kind === 'answer' && message.final && (message.category !== 'stream_msg' || !message.raw.chat_ui_key)) flush();
    } else {
      flush();
      groups.push({ key: message.key, steps: [], messages: [message], running: false, stopped: false });
    }
  }
  flush(running);
  return groups;
}
