import { getBareCitationRefs } from '@bisheng/chat/citations';
import type { ChatCitation, ChatMessage } from './chatApi';

export function missingBareCitationIds(text: string, citations?: ChatCitation[] | null) {
  const registered = new Set<string>();
  for (const citation of citations ?? []) {
    if (citation.itemId != null) registered.add(`${citation.citationId}:${citation.itemId}`);
    for (const item of citation.sourcePayload?.items ?? []) {
      if (item.itemId != null) registered.add(`${citation.citationId}:${item.itemId}`);
    }
  }
  return [...new Set(getBareCitationRefs(text).filter(ref => !registered.has(ref)).map(ref => ref.slice(0, ref.lastIndexOf(':'))))];
}

/** Old stream-format history omits registries; resolve candidates through the existing permission gate. */
export async function hydrateStreamChatCitations(
  messages: ChatMessage[],
  resolve: (ids: string[]) => Promise<ChatCitation[]>,
): Promise<ChatMessage[]> {
  const idsByMessage = messages.map(message => message.isCreatedByUser ? [] : missingBareCitationIds(message.text, message.citations));
  const ids = [...new Set(idsByMessage.flat())];
  if (!ids.length) return messages;
  try {
    const resolved = await resolve(ids);
    return messages.map((message, index) => idsByMessage[index].length ? {
      ...message,
      citations: [...(message.citations || []), ...resolved.filter(citation => idsByMessage[index].includes(citation.citationId))],
    } : message);
  } catch {
    console.warn('[StreamChatHistory] Citation registry lookup failed');
    return messages;
  }
}
