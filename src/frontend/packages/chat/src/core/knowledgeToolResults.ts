import { asRecord } from './normalizeHistory';

/** Group retrieved chunks by knowledge base, preserving first-seen order. */
export function knowledgeToolResults(items: unknown[], fallbackName: string) {
  const bases = new Map<string, { id: string; name: string; error?: string }>();
  for (const item of items) {
    if (!item) continue;
    const fields = asRecord(item);
    const text = String(typeof item === 'string' ? item : fields.chunk || fields.text || fields.content || '');
    const id = /<knowledge_base_id>([^<]*)<\/knowledge_base_id>/.exec(text)?.[1].trim() || '';
    const name = /<knowledge_base_name>([^<]*)<\/knowledge_base_name>/.exec(text)?.[1].trim()
      || /<file_title>([^<]+)<\/file_title>/.exec(text)?.[1].trim()
      || String(fields.knowledge_base_name || fields.kb_name || fields.file_title || fields.title || fallbackName);
    const error = /<retrieval_error>([\s\S]*?)<\/retrieval_error>/.exec(text)?.[1].trim();
    const key = id || name;
    const existing = bases.get(key);
    if (!existing) bases.set(key, { id, name, error });
    else if (!error) existing.error = undefined;
  }
  return [...bases.values()];
}
