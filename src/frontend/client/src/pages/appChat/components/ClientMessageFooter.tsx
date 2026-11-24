import { CopyMessageAction } from '@bisheng/chat';
import { useLocalize } from '~/hooks';
import { splitMessageContent, type ChatMessage } from '@bisheng/chat/core';
import type { RefObject } from 'react';
import { useParams } from 'react-router-dom';
import type { ChatMessageType } from '~/@types/chat';
import CitationReferencesDrawer, { type CitationReferencesDesktopPayload } from '~/components/Chat/Messages/Content/CitationReferencesDrawer';
import { ExportSelectionButton } from '~/components/Chat/MessageSelection';
import { TextToSpeechButton } from '~/components/Voice/TextToSpeechButton';
import { copyText, formatStrTime } from '~/utils';
import MessageButtons from './MessageButtons';

interface ClientMessageFooterProps {
    message: ChatMessage;
    contentRef: RefObject<HTMLDivElement>;
    readOnly: boolean;
    onOpenCitationPanel?: (payload: CitationReferencesDesktopPayload) => void;
    activeCitationMessageId?: string | null;
}
/** Resource and business operations remain in the client boundary. */
export function ClientMessageFooter({ message, contentRef, readOnly, onOpenCitationPanel, activeCitationMessageId }: ClientMessageFooterProps) {
    const localize = useLocalize();
    const raw = message.raw as unknown as ChatMessageType;
    const { conversationId = '' } = useParams();
    const id = message.sourceMessageId;
    const { referenceText, webContent } = splitMessageContent(message.text);
    if (message.kind === 'user' || message.kind === 'run') return null;
    if (message.kind === 'form' || message.kind === 'choice') return readOnly ? null : <TextToSpeechButton messageId={id ?? message.key} text={message.text} />;
    if (message.category === 'guide_word') return readOnly ? null : <TextToSpeechButton messageId={message.key} text={message.text} />;
    return <div className="bisheng-message-actions">
        {!readOnly && id && message.kind === 'answer'
            ? <MessageButtons id={raw.id ?? id} data={raw.liked} text={referenceText} onCopy={() => copyText(contentRef.current ?? referenceText)}>
                {conversationId && <ExportSelectionButton chatId={conversationId} messageId={id} />}
            </MessageButtons>
            : <CopyMessageAction label={localize('com_ui_copy')} copiedLabel={localize('com_ui_copied')} onCopy={() => copyText(contentRef.current ?? referenceText)} />}
        <CitationReferencesDrawer content={referenceText} webContent={webContent} citations={raw.citations} messageId={id}
            desktopMode={onOpenCitationPanel ? 'inline-panel' : 'overlay'}
            open={onOpenCitationPanel ? activeCitationMessageId === id : undefined}
            onDesktopOpen={onOpenCitationPanel} />
        {raw.create_time && <span className="bisheng-message-time">{formatStrTime(raw.create_time, localize('shared:app_chat.timestamp_format'))}</span>}
    </div>;
}
