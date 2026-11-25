import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { CitationReferencesProps } from '@bisheng/chat/citation-views';
import { PlatformConversationMessages } from './PlatformConversationMessages';

const source = vi.hoisted(() => ({
    citationId: 'knowledgesearch_ab12cd',
    type: 'rag',
    sourcePayload: { documentName: 'Example.pdf', items: [{ itemId: '12' }, { itemId: '5' }] },
}));
vi.mock('@/controllers/API', () => ({
    getCitationDetail: async () => source,
    resolveCitationDetails: async () => [source],
    getCitationUnresolvedReason: () => undefined,
}));
vi.mock('@/components/bs-comp/FileView', () => ({ checkSassUrl: (url: string) => url }));
vi.mock('@/workspace/markdown/Mermaid', () => ({ loadScript: vi.fn() }));
vi.mock('./PlatformVoiceAction', () => ({ PlatformVoiceAction: () => null }));
vi.mock('../chatComponent/CitationDocumentPreviewDrawer', () => ({ default: () => null }));
vi.mock('../chatComponent/CitationSourceIcon', () => ({ CitationSourceIcon: () => null }));
vi.mock('../chatComponent/CitationReferencesDrawer', () => ({
    default: (props: CitationReferencesProps) => props.panelOnly
        ? <output>{props.messageId}/{props.initialDocumentPreview?.detail.citationId}/{props.initialDocumentPreview?.itemId}</output>
        : null,
}));
vi.mock('@/pages/ChatAppPage/components/ResouceModal', async () => ({ default: (await import('react')).forwardRef(() => null) }));

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('opens the precise cited passage in the desktop preview panel and clears it on session switch', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
        matches: query.includes('pointer: fine'),
        addEventListener: vi.fn(), removeEventListener: vi.fn(),
    }));
    const messages = [{ id: 42, category: 'answer', is_bot: true, end: true, citations: [source],
        message: `First ${source.citationId}:12 and second ${source.citationId}:5` }];
    const transcript = (sessionKey: string) => <PlatformConversationMessages mode="assistant"
        sessionKey={sessionKey} messages={messages} canExecute canAnnotate={false} />;
    const { rerender } = render(transcript('session-a'));
    await act(async () => { fireEvent.click(screen.getByText('2')); });
    expect(await screen.findByText(`42/${source.citationId}/5`)).toBeVisible();
    await act(async () => { rerender(transcript('session-b')); });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
});
