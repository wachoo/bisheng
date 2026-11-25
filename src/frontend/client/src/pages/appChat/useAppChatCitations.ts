import { useEffect, useMemo, useState } from 'react';
import { hideStreamingCitations, normalizeCitationItems, type ChatCitation } from '@bisheng/chat/citations';
import { splitMessageContent, type ChatMessage } from '@bisheng/chat/core';
import { getCitationAccessScope } from '~/api/citationScope';
import { missingBareCitationIds } from '~/api/hydrateStreamChatCitations';

/** Both history and final websocket answers use the same authorized registry for badges and sources. */
export function useAppChatCitations(messages: ChatMessage[], enabled: boolean) {
  const candidates = useMemo(() => messages.map(message => {
    const citations = normalizeCitationItems({ ...message.raw, message: message.payload });
    const ids = enabled && message.final && message.kind === 'answer'
      ? missingBareCitationIds(splitMessageContent(message.text).referenceText, citations) : [];
    return { citations, ids };
  }), [messages, enabled]);
  const requested = JSON.stringify([...new Set(candidates.flatMap(item => item.ids))].sort());
  const scope = getCitationAccessScope();
  const [result, setResult] = useState<{ scope: string; details: ChatCitation[] }>();
  useEffect(() => {
    if (requested === '[]') return;
    let active = true;
    void import('~/api/chatApi').then(({ resolveCitationDetails }) => resolveCitationDetails(JSON.parse(requested)))
      .then(details => { if (active) setResult({ scope, details }); })
      .catch(() => { /* Keep the original answer readable if the registry is unavailable. */ });
    return () => { active = false; };
  }, [requested, scope]);
  return useMemo(() => messages.map((message, index) => {
    if (enabled && message.kind === 'answer' && !message.final) {
      return { ...message, text: hideStreamingCitations(message.text) };
    }
    const { ids, citations } = candidates[index];
    const recovered = result?.scope === scope ? result.details.filter(item => ids.includes(item.citationId)) : [];
    if (!citations?.length && !recovered.length) return message;
    const merged = [...(citations ?? []), ...recovered];
    return { ...message, raw: { ...message.raw, citations: merged } };
  }), [enabled, messages, candidates, result, scope]);
}
