import { ConversationMessages, ConversationAttachments, CopyMessageAction } from '@bisheng/chat';
import { asRecord, parsePayload, describeRun, createRunLabels, displayText, messagesForPresentation, selectQaPair, splitMessageContent, type ChatMessage, type ChatMode } from '@bisheng/chat/core';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { hideStreamingCitations } from '@bisheng/chat/citations';
import type { CitationReferencesDesktopPayload } from '@bisheng/chat/citation-views';
import { useCitationMediaQuery } from '../chatComponent/useCitationMediaQuery';
import { useTranslation } from 'react-i18next';
import { Button } from '@bisheng/ui';
import { FlagIcon } from '@/components/bs-icons';
import { copyText } from '@/utils';
import { PlatformChatMarkdown } from './PlatformChatMarkdown';
import { checkSassUrl } from '@/components/bs-comp/FileView';
import { downloadFile } from '@/util/utils';
import { PlatformVoiceAction } from './PlatformVoiceAction';
import CitationReferencesDrawer from '../chatComponent/CitationReferencesDrawer';
import { normalizeCitationItems } from '../chatComponent/citationUtils';
import SourceEntry from '../chatComponent/SourceEntry';
import ResouceModal from '@/pages/ChatAppPage/components/ResouceModal';

interface PlatformConversationMessagesProps {
    mode: ChatMode;
    sessionKey: string;
    messages: readonly unknown[];
    canExecute: boolean;
    running?: boolean;
    canAnnotate: boolean;
    logo?: ReactNode;
    title?: string;
    runCatalog?: unknown;
    userName?: string;
    version?: string;
    onMarkClick?: (kind: 'question' | 'answer', sourceMessageId: string, qa: { q: string; a: string }) => void;
    onChoice?: (message: ChatMessage, value: string) => void | Promise<void>;
}
/** Authenticated host operations surround the same client-based message renderer. */
export function PlatformConversationMessages({ mode, sessionKey, messages: rows, canExecute, running = false, canAnnotate, logo, title = '', runCatalog, userName = '', version, onMarkClick, onChoice }: PlatformConversationMessagesProps) {
    const { t } = useTranslation(['bs', 'shared']);
    const [citationPanel, setCitationPanel] = useState<CitationReferencesDesktopPayload | null>(null);
    const narrow = useCitationMediaQuery('(max-width:768px)');
    const openPanel = mode === 'assistant' && !narrow ? setCitationPanel : undefined;
    useEffect(() => { setCitationPanel(null); }, [sessionKey, narrow]);
    const messages = messagesForPresentation(rows, { mode, sessionKey });
    const sourceRef = useRef<{ openModal: (value: { chatId: string; messageId?: string; message: string }) => void }>(null);
    const handleMark = (message: ChatMessage) => {
        if (!canAnnotate || !message.sourceMessageId) return;
        const pair = selectQaPair(messages, message.key);
        if (pair) onMarkClick?.(message.kind === 'user' ? 'question' : 'answer', message.sourceMessageId, { q: pair.question, a: pair.answer });
    };
    return <>
        <ConversationMessages messages={messages} assistantTimeline={mode === 'assistant'} running={running} canExecute={canExecute} onChoice={onChoice}
            labels={{ confirm: t('chat.confirm'), confirmed: t('chat.confirmed'), thinking: t('flow:thinking'), completed: t('flow:thoughtCompleted'),
                deepThinking: t('shared:app_chat.timeline.deepThinking'),
                deepThought: t('shared:app_chat.timeline.deepThought'),
                reasoningContent: t('shared:app_chat.timeline.reasoningContent'),
                toolInput: t('shared:app_chat.timeline.toolInput'),
                knowledge: t('shared:app_chat.timeline.knowledge'),
                knowledgeResults: count => t('shared:app_chat.timeline.knowledgeResults', { count }),
                toolResult: t('shared:app_chat.timeline.toolResult'),
                toolError: t('shared:app_chat.timeline.toolError'),
                tool: t('shared:app_chat.timeline.tool'),
                stopped: t('shared:app_chat.timeline.stopped'),
            }}
            slots={{
                runPresentation: message => describeRun(message, runCatalog, createRunLabels(key => String(t(key)))),
                title: message => message.kind === 'user' ? displayText(message.raw.user_name) || userName : title,
                avatar: message => message.kind === 'user' ? <img className="w-6 h-6 min-w-6" src={__APP_ENV__.BASE_URL + '/assets/user.png'} alt="" /> : logo,
                content: (text, message) => {
                    if (['divider', 'separator'].includes(message.category)) return text || t('chat.roundOver');
                    const { referenceText, webContent } = splitMessageContent(text);
                    return <PlatformChatMarkdown messageId={message.sourceMessageId ?? message.key} onOpenCitationPanel={openPanel} content={mode === 'assistant' && !message.final ? hideStreamingCitations(referenceText) : referenceText} citations={normalizeCitationItems(message.raw)?.map(detail => ({ ...detail, type: detail.type ?? '' }))} webContent={webContent} />;
                },
                attachments: message => <ConversationAttachments files={message.files} services={{ resolveUrl: checkSassUrl,
                    onDownload: file => downloadFile(checkSassUrl(file.url), file.name),
                    labels: { download: t('shared:app_chat.attachment_download'), unavailable: t('shared:app_chat.attachment_unavailable'), close: t('shared:app_chat.close'), preview: t('shared:app_chat.image_preview') },
                }} />,
                footer: (message, contentRef) => {
                    const id = message.sourceMessageId;
                    if (message.category === 'guide_word') return canExecute ? <PlatformVoiceAction id={id ?? message.key} text={message.text} /> : null;
                    if (message.kind === 'form' || message.kind === 'choice') return <PlatformVoiceAction id={id ?? message.key} text={message.text} />;
                    if (message.kind === 'user') return <div className="bisheng-message-actions">
                        <CopyMessageAction label={t('shared:app_chat.copy')} copiedLabel={t('shared:app_chat.copied')} onCopy={() => copyText(message.text)} />
                        {canAnnotate && id && <Button size="small" variant="solid" color="primary" onClick={() => handleMark(message)}><FlagIcon className="size-3.5" />{t('addSimilarQuestion')}</Button>}
                    </div>;
                    const { referenceText, webContent } = splitMessageContent(message.text);
                    return <div className="bisheng-message-actions">
                        <CopyMessageAction label={t('shared:app_chat.copy')} copiedLabel={t('shared:app_chat.copied')} onCopy={() => copyText(contentRef.current ?? referenceText)} />
                        {canAnnotate && id && message.kind === 'answer' && message.text.trim() && <Button size="small" variant="solid" color="primary" onClick={() => handleMark(message)}><FlagIcon className="size-3.5" />{t('addQa')}</Button>}
                        {mode === 'assistant' && version !== 'v2' && <PlatformVoiceAction id={id ?? message.key} text={referenceText} />}
                        <CitationReferencesDrawer content={referenceText} webContent={webContent} citations={normalizeCitationItems(message.raw)}
                            messageId={id ?? message.key} desktopMode={openPanel ? 'inline-panel' : 'overlay'}
                            onDesktopOpen={openPanel} open={citationPanel?.messageId === (id ?? message.key)} allowRemoteCitationResolve />
                        <SourceEntry extra={asRecord(parsePayload(message.raw.extra))} end={message.final} source={message.raw.source} onSource={() => sourceRef.current?.openModal({ chatId: sessionKey, messageId: id, message: referenceText })} />
                    </div>;
                },
            }} />
        {citationPanel && openPanel && createPortal(
            <aside data-citation-popover-surface className="fixed inset-y-0 right-0 z-[130] w-[min(480px,100vw)] bg-background shadow-lg">
                <CitationReferencesDrawer {...citationPanel} allowRemoteCitationResolve panelOnly desktopMode="inline-panel"
                    open onOpenChange={open => { if (!open) setCitationPanel(null); }} />
            </aside>, document.body)}
        <ResouceModal ref={sourceRef} />
    </>;
}
