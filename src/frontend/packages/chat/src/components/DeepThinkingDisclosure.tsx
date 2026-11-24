import { Outlined } from 'bisheng-icons';
import { useEffect, useRef, useState, type ReactNode } from 'react';

interface DeepThinkingDisclosureProps {
  running: boolean;
  label: string;
  children: ReactNode;
}

/** Workbench and assistant transcripts share the same live-to-finished transition. */
export function DeepThinkingDisclosure({ running, label, children }: DeepThinkingDisclosureProps) {
  const [open, setOpen] = useState(running);
  const wasRunning = useRef(running);
  useEffect(() => {
    if (wasRunning.current && !running) setOpen(false);
    wasRunning.current = running;
  }, [running]);
  return <div className="flex w-full min-w-0 flex-col gap-3">
    <button type="button" aria-expanded={open} onClick={() => setOpen(value => !value)}
      className={`group flex w-fit items-center gap-1 text-sm font-medium leading-[22px] text-text-1 ${running ? 'animate-pulse' : ''}`}>
      <span>{label}</span>
      <Outlined.Down size={16} className={`shrink-0 text-text-3 transition-transform duration-200 ${open ? '' : '-rotate-90'}`} />
    </button>
    <div aria-hidden={!open} className="grid transition-all duration-300 ease-out" style={{ gridTemplateRows: open ? '1fr' : '0fr' }}>
      <div className={`min-h-0 overflow-hidden flex flex-col gap-2 ${open ? '' : 'invisible'}`}>{children}</div>
    </div>
  </div>;
}
