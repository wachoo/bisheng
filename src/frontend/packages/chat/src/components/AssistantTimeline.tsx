import { Outlined } from 'bisheng-icons';
import { useState, type ReactNode } from 'react';
import type { TimelineStep } from '../core/assistantTimeline';
import { asRecord, displayText, parsePayload } from '../core/normalizeHistory';
import { knowledgeToolResults } from '../core/knowledgeToolResults';
import type { ConversationLabels, ConversationMessageSlots } from './ConversationMessages';
import { DeepThinkingDisclosure } from './DeepThinkingDisclosure';

interface TimelineProps {
  steps: TimelineStep[];
  summary?: string;
  running: boolean;
  stopped: boolean;
  labels: ConversationLabels;
  runPresentation?: ConversationMessageSlots['runPresentation'];
  initiallyShowReasoning?: boolean;
}

function TimelineItem({ step, hasNext, labels, runPresentation, initiallyShowReasoning, standalone = false }:
  Pick<TimelineProps, 'labels' | 'runPresentation' | 'initiallyShowReasoning'> & { step: TimelineStep; hasNext: boolean; standalone?: boolean }) {
  const [open, setOpen] = useState(step.kind === 'reasoning' && (initiallyShowReasoning ?? true));
  let title: string;
  let detail: ReactNode;
  let icon = <Outlined.CheckCircle size={16} className="text-text-3" />;
  if (step.kind === 'reasoning') {
    title = labels.reasoningContent ?? labels.thinking;
    detail = step.text;
  } else {
    const { name, status, message } = step;
    // A terminal snapshot can confirm completion after the host locally froze this row.
    const presentationMessage = status === 'done' && message?.raw.interrupted
      ? { ...message, final: true, raw: { ...message.raw, interrupted: false } } : message;
    const run = presentationMessage && runPresentation?.(presentationMessage);
    const payload = asRecord(message?.payload);
    title = run?.title || name || labels.tool || labels.completed;
    if (status === 'error' || status === 'stopped') {
      const phase = status === 'error' ? labels.toolError : labels.stopped;
      title = [name || labels.tool, phase].filter(Boolean).join(' ') || title;
      icon = <Outlined.CloseCircle size={16} className="text-danger" />;
    } else if (status === 'running') icon = <Outlined.Loading size={16} className="animate-spin text-primary" />;
    else if (run?.unavailable) icon = <Outlined.CloseCircle size={16} className="text-danger" />;
    const input = displayText(payload.input_str ?? payload.input);
    const output = displayText(payload.error ?? payload.output);
    detail = input || output ? <>
      {input && <div><strong>{labels.toolInput}</strong><p>{input}</p></div>}
      {output && <div><strong>{status === 'error' ? labels.toolError : labels.toolResult}</strong><p>{output}</p></div>}
    </> : displayText(message?.raw.thought || message?.raw.intermediate_steps);
    if (message?.category === 'knowledge' && status === 'done' && !payload.error) {
      const chunks = parsePayload(payload.output);
      if (Array.isArray(chunks)) {
        const bases = knowledgeToolResults(chunks, labels.knowledge || name);
        title = labels.knowledgeResults?.(bases.length) ?? title;
        icon = <Outlined.BookOpenText size={16} className="text-text-3" />;
        detail = bases.length > 0 && <div className="flex flex-wrap gap-2">
          {bases.map(base => <span key={base.id || base.name} title={base.error || base.name}
            className="inline-flex max-w-full items-center gap-1 rounded bg-gray-100 px-2 py-1 text-text-1 dark:bg-gray-800">
            <Outlined.BookOpenText size={14} className="shrink-0" />
            <span>{base.name}{base.error && ` · ${base.error}`}</span>
          </span>)}
        </div>;
      }
    }
  }
  const Container = standalone ? 'div' : 'li';
  return <Container className="flex w-full min-w-0 gap-1.5">
    <div aria-hidden="true" className="flex shrink-0 flex-col items-center gap-2 self-stretch pt-[3px]">
      {icon}{(hasNext || (detail && open)) && <div className="w-px flex-1 bg-border-base" />}
    </div>
    <div className="flex min-w-0 flex-1 flex-col pb-3">
      <button type="button" aria-expanded={detail ? open : undefined} disabled={!detail}
        className="flex w-fit max-w-full items-center gap-1 text-sm leading-[22px] text-text-3 hover:text-text-1"
        onClick={() => setOpen(value => !value)}>
        {title}{!!detail && <Outlined.Down size={16} className={open ? 'shrink-0' : 'shrink-0 -rotate-90'} />}
      </button>
      {!!detail && open && <div className="mt-2 whitespace-pre-wrap [overflow-wrap:anywhere] text-xs leading-5 text-text-2">{detail}</div>}
    </div>
  </Container>;
}

export function AssistantTimeline({ steps, summary, running, stopped, labels, ...props }: TimelineProps) {
  const label = stopped && labels.stopped ? labels.stopped : running ? labels.deepThinking ?? labels.thinking : labels.deepThought ?? labels.completed;
  return <DeepThinkingDisclosure label={label} running={running}>
    {summary && <TimelineItem standalone step={{ kind: 'reasoning', key: 'summary', text: summary }} hasNext={false} labels={labels} {...props} />}
    <ol className="m-0 flex min-w-0 list-none flex-col gap-2 p-0">
      {steps.map((step, index) => <TimelineItem key={`${step.kind}-${step.key}`} step={step} hasNext={index + 1 < steps.length} labels={labels} {...props} />)}
    </ol>
  </DeepThinkingDisclosure>;
}
