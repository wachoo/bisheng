import { Outlined } from 'bisheng-icons';
import { CopyButton } from '~/components/Chat/MessageCopyButton';
import { emitAreaTextEvent, EVENT_TYPE } from '../useAreaText';
import { useLocalize } from '~/hooks';
import { formatStrTime } from '~/utils';
interface ClientUserActionsProps {
    text: string;
    canResend: boolean;
    searchUrl?: string;
    createTime?: string;
}
export function ClientUserActions({ text, canResend, searchUrl, createTime }: ClientUserActionsProps) {
    const localize = useLocalize();
    const handleResend = (send: boolean) => emitAreaTextEvent({ action: EVENT_TYPE.RE_ENTER, autoSend: send, text });
    return <div className="bisheng-message-actions justify-end">
        {createTime && <span className="bisheng-message-time">{formatStrTime(createTime, localize('shared:app_chat.timestamp_format'))}</span>}
        <CopyButton text={text} />
        <>
            {canResend && <button type="button" aria-label={localize('com_ui_edit')} title={localize('com_ui_edit')} onClick={() => handleResend(false)}><Outlined.Edit size={15} /></button>}
            {canResend && <button type="button" aria-label={localize('com_ui_regenerate')} title={localize('com_ui_regenerate')} onClick={() => handleResend(true)}><Outlined.Refresh size={15} /></button>}
            {searchUrl && <button type="button" aria-label={localize('com_ui_search')} title={localize('com_ui_search')} onClick={() => window.open(searchUrl + encodeURIComponent(text))}><Outlined.Search size={15} /></button>}
        </>
    </div>;
}
