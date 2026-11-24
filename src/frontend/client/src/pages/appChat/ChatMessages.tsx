// @ts-strict-ignore
import { ConversationMessages, SuggestedQuestions } from "@bisheng/chat";
import {
  messagesForPresentation,
  asRecord,
  displayText,
  describeRun,
  createRunLabels,
} from "@bisheng/chat/core";
import { ClientChatMarkdown } from "./components/ClientChatMarkdown";
import appStore from "~/store";
import { MessageCheckbox } from "~/components/Chat/MessageSelection";
import { Avatar, AvatarImage, AvatarName } from "~/components/ui/Avatar";
import { useAuthContext } from "~/hooks";
import { ClientMessageFooter } from "./components/ClientMessageFooter";
import { ClientMessageAttachments } from "./components/ClientMessageAttachments";
import { ClientUserActions } from "./components/ClientUserActions";
import { emitAreaTextEvent, EVENT_TYPE } from "./useAreaText";
import { useMemo } from "react";
import { useRecoilValue } from "recoil";
import type { CitationReferencesDesktopPayload } from "~/components/Chat/Messages/Content/CitationReferencesDrawer";
import { SelectionMessagesProvider, SelectAllBelowBanner } from "~/components/Chat/MessageSelection";
import type { SelectableMessage } from "~/hooks/useMessageSelection";
import { useLocalize } from "~/hooks";
import InputForm from "./components/InputForm";
import InputFormSkill from "./components/InputFormSkill";
import { bishengConfState, currentChatState, currentRunningState } from "./store/atoms";
import { useMessage } from "./useMessages";
import { useAppChatCitations } from "./useAppChatCitations";

// F028: only question + answer category rows are selectable. Intermediate
// rows (tool, flow, knowledge, node_run, system, ...) stay out of the
// selection model so the pair-group walk (question → adjacent answers)
// finds the right neighbors. Order preserved so adjacency works.
const _SELECTABLE_CATEGORIES = new Set(["question", "answer", "agent_answer", "output_msg", "stream_msg"]);

type ChatMessagesProps = {
  useName?: string;
  readOnly: any;
  title: string;
  logo: React.ReactNode;
  disabledSearch?: boolean;
  isGuestMode?: boolean;
  onOpenCitationPanel?: (payload: CitationReferencesDesktopPayload) => void;
  activeCitationMessageId?: string | null;
  /** F028: selection mode is active for this chat — show the "select all below" bar. */
  selectionActive?: boolean;
};
export default function ChatMessages({
  useName,
  readOnly,
  title,
  logo,
  disabledSearch = false,
  onOpenCitationPanel,
  activeCitationMessageId = null,
  selectionActive = false,
}: ChatMessagesProps) {
  const { messageScrollRef, messages, chatId } = useMessage(readOnly);
  const { inputForm, guideWord, inputDisabled, running, error } = useRecoilValue(currentRunningState);
  const chatState = useRecoilValue(currentChatState);
  const config = useRecoilValue(bishengConfState);
  const latexParsing = useRecoilValue(appStore.LaTeXParsing);
  const showThinking = useRecoilValue(appStore.showThinking);
  const localize = useLocalize();
  const { user } = useAuthContext();

  // F028 selection messages — filtered to question + answer categories so
  // ``buildPairGroup`` (array-position adjacency) walks the right
  // neighbors. Keep the relative order from the source list.
  const selectableMessages = useMemo<SelectableMessage[]>(() => {
    return (messages ?? [])
      .filter((m: any) => m?.id != null && _SELECTABLE_CATEGORIES.has(m?.category))
      .map((m: any) => ({
        messageId: String(m.id),
        parentMessageId: "",
        isCreatedByUser: m.category === "question",
      }));
  }, [messages]);

  const isAssistant = chatState?.flow?.flow_type !== 10;

  const remark = chatState?.flow?.guide_word;
  const normalized = useMemo(() => messagesForPresentation(
    remark ? [{ category: "guide_word", message: remark, chat_ui_key: `${chatId}:greeting` }, ...messages] : messages,
    { mode: isAssistant ? "assistant" : "workflow", sessionKey: chatId ?? "" },
  ), [messages, remark, chatId, isAssistant]);
  const transcript = useAppChatCitations(normalized, isAssistant);

  return (
    <div
      id="messageScrollPanne"
      ref={messageScrollRef}
      className="h-full overflow-y-auto scrollbar-hide pt-2 pb-4"
    >
      <div className="bisheng-chat-reading">
      <SelectionMessagesProvider messages={selectableMessages}>
        {selectionActive && messages.length > 0 && <SelectAllBelowBanner scrollRef={messageScrollRef} />}
        <ConversationMessages
          messages={transcript}
          canExecute={!readOnly}
          assistantTimeline={isAssistant}
          running={Boolean(running)}
          initiallyShowReasoning={showThinking}
          labels={{
            confirm: localize("com_bschoose_confirm"),
            confirmed: localize("com_bschoose_confirmed"),
            thinking: localize("com_bs_reasoning_thinking"),
            completed: localize("com_bs_reasoning_done"),
            deepThinking: localize("shared:app_chat.timeline.deepThinking"),
            deepThought: localize("shared:app_chat.timeline.deepThought"),
            reasoningContent: localize("shared:app_chat.timeline.reasoningContent"),
            toolInput: localize("shared:app_chat.timeline.toolInput"),
            knowledge: localize("shared:app_chat.timeline.knowledge"),
            knowledgeResults: count => localize("shared:app_chat.timeline.knowledgeResults", { count }),
            toolResult: localize("shared:app_chat.timeline.toolResult"),
            toolError: localize("shared:app_chat.timeline.toolError"),
            tool: localize("shared:app_chat.timeline.tool"),
            stopped: localize("shared:app_chat.timeline.stopped"),
          }}
          onChoice={(message, value) => {
            const payload = asRecord(message.payload);
            emitAreaTextEvent({
              action: EVENT_TYPE.MESSAGE_INPUT,
              data: {
                nodeId: payload.node_id,
                msgId: message.raw.id,
                message: JSON.stringify({ ...payload, hisValue: value }),
                data: { [String(payload.key)]: value },
              },
            });
          }}
          slots={{
            runPresentation: (message) => describeRun(message, chatState?.flow, createRunLabels(localize)),
            title: (message) =>
              message.kind === "user" ? displayText(message.raw.user_name) || useName || "" : title,
            avatar: (message) =>
              message.kind === "user" ? (
                <Avatar className="w-6 h-6 text-xs">
                  {user?.avatar ? (
                    <AvatarImage src={user.avatar} alt={user.username} />
                  ) : (
                    <AvatarName name={user?.username} />
                  )}
                </Avatar>
              ) : (
                logo
              ),
            content: (text, message) =>
              ["divider", "separator"].includes(message.category) ? (
                localize(text)
              ) : (
                <ClientChatMarkdown
                  content={text}
                  readOnly={Boolean(readOnly)}
                  latexParsing={latexParsing}
                  citations={message.raw.citations as import("@bisheng/chat").ChatCitation[] | undefined}
                  messageId={message.sourceMessageId}
                  onOpenCitationPanel={onOpenCitationPanel}
                />
              ),
            attachments: (message) => (
              <ClientMessageAttachments message={message} conversationId={chatId ?? ""} />
            ),
            selection: (message) =>
              selectionActive && message.sourceMessageId && ["user", "answer"].includes(message.kind) ? (
                <MessageCheckbox
                  chatId={chatId ?? ""}
                  messageId={message.sourceMessageId}
                  className="mt-2 ml-2 shrink-0"
                />
              ) : undefined,
            footer: (message, contentRef) =>
              message.kind === "user" ? (
                <ClientUserActions
                  createTime={displayText(message.raw.create_time)}
                  text={message.text}
                  canResend={!readOnly && !error?.code && !inputDisabled && chatState?.flow.flow_type !== 10}
                  searchUrl={!readOnly && !disabledSearch ? config?.dialog_quick_search : undefined}
                />
              ) : (
                <ClientMessageFooter
                  message={message}
                  contentRef={contentRef}
                  readOnly={Boolean(readOnly)}
                  onOpenCitationPanel={onOpenCitationPanel}
                  activeCitationMessageId={activeCitationMessageId}
                />
              ),
          }}
        />

        {guideWord && !error?.code && !inputDisabled && !inputForm && !readOnly && (
          <SuggestedQuestions
            questions={guideWord}
            canExecute={!readOnly}
            onSelect={(word) => emitAreaTextEvent({ action: EVENT_TYPE.INPUT_SUBMIT, data: word })}
          />
        )}
        {!readOnly &&
          !error?.code && inputForm &&
          (chatState?.flow.flow_type === 10 ? (
            <InputForm data={inputForm} flow={chatState.flow} logo={logo} />
          ) : (
            <InputFormSkill flow={chatState.flow} logo={logo} />
          ))}
      </SelectionMessagesProvider>
      </div>
    </div>
  );
}
