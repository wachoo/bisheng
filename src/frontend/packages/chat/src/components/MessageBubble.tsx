import { Outlined } from 'bisheng-icons';
import { useState, type ReactNode, type Ref } from 'react';
import '../styles/message-layout.css';

export interface ReasoningDetailsProps {
  text: string;
  pending: boolean;
  stopped?: boolean;
  initiallyOpen?: boolean;
  labels: { thinking: string; completed: string; stopped?: string };
}
/** Reasoning presentation extracted from the client answer message. */
export function ReasoningDetails({ text, pending, stopped = false, initiallyOpen = true, labels }: ReasoningDetailsProps) {
  const [open, setOpen] = useState(initiallyOpen);
  if (!text) return null;
  return <div className="min-w-0 pb-3 text-text-3">
    <button type="button" aria-expanded={open}
      className="flex items-center gap-1 text-sm leading-[22px] hover:text-text-1"
      onClick={() => setOpen(value => !value)}>
      {pending ? <Outlined.Loading size={16} className="text-primary duration-300 animate-spin" />
        : stopped ? <Outlined.Square size={16} /> : <Outlined.CheckCircle size={16} />}
      <span>{stopped ? labels.stopped : pending ? labels.thinking : labels.completed}</span>
      <Outlined.Down size={16} className={open ? undefined : '-rotate-90'} />
    </button>
    {open && <p className="ml-2 mt-2 border-l pl-3 whitespace-pre-wrap [overflow-wrap:anywhere] text-xs leading-5 text-text-2">{text}</p>}
  </div>;
}

export interface MessageBubbleProps {
  speaker?: 'user' | 'assistant';
  title?: string;
  logo?: ReactNode;
  sender?: string;
  selection?: ReactNode;
  reasoning?: ReactNode;
  children?: ReactNode;
  attachments?: ReactNode;
  footer?: ReactNode;
  status?: ReactNode;
  pending?: boolean;
  contentRef?: Ref<HTMLDivElement>;
  hideBody?: boolean;
}
/** Host actions/resources are slots; one shared message layout owns both apps. */
export function MessageBubble({ speaker = 'assistant', title, sender, selection, reasoning, children, attachments, footer, status, pending, contentRef, hideBody }: MessageBubbleProps) {
  return <div className="bisheng-message" data-speaker={speaker}>
    {selection}
    <div className="bisheng-message__column group">
      {title && <span className="sr-only">{title}</span>}
      {sender && <p className="text-xs text-text-3">{sender}</p>}
      {reasoning}
      {!hideBody && <div className="bisheng-message__body" ref={contentRef}>
        {speaker === 'user' && attachments}
        {children}
        {speaker === 'assistant' && attachments}
        {pending && <Outlined.Loading size={24} className="animate-spin text-primary" />}
      </div>}
      {status}
      {footer && <div className={speaker === 'user' ? 'flex justify-end' : 'flex justify-between'}>{footer}</div>}
    </div>
  </div>;
}
