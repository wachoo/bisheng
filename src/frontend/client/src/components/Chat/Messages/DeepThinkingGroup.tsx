/**
 * DeepThinkingGroup — outer collapsible wrapper around a contiguous run of
 * thinking + tool_call events. Header reads "已深度思考" once the run is closed
 * by a following text block (or stream end), or "正在深度思考…" while still
 * open. Collapsing the wrapper hides everything inside, including any inner
 * ThinkingContent state.
 *
 * **No duration (2026-08-13).** The header used to end in "（用时 N 秒）", driven
 * by a 100ms ticker. A live counter promises the number matters, and for model
 * reasoning it does not — it only measures how long you have waited, with no
 * denominator to reason against, at a precision that implies the work should
 * have been quick. On a long run it made the product look broken rather than
 * busy. Liveness is carried by the streaming glyph and the reasoning text.
 * Removed here in lockstep with task mode's GroupHeaderLabel, which the two
 * surfaces are deliberately isomorphic with — see Linsight/Execution/
 * GroupHeaderLabel.tsx for the full reasoning.
 */
import { DeepThinkingDisclosure } from "@bisheng/chat";
import {
    memo,
    useMemo,
    type FC,
} from "react";
import type { AgentEvent } from "~/api/chatApi";
import { useLocalize } from "~/hooks";
import ThinkingContent from "./ThinkingContent";
import ToolCallDisplay from "./ToolCallDisplay";

export interface DeepThinkingGroupProps {
    /** Ordered events in this group — only thinking + tool_call entries. */
    events: AgentEvent[];
    /** True if this group is the currently-open trailing run. */
    isStreaming: boolean;
}

const DeepThinkingGroup: FC<DeepThinkingGroupProps> = memo(
    ({ events, isStreaming }) => {
        const localize = useLocalize();
        // Shared with task mode on purpose: the two 深度思考 surfaces are
        // explicitly isomorphic, so one key pair keeps their wording from
        // drifting apart. (The `_compact` name is historical — it was the
        // duration-free variant back when a duration variant existed.)
        const label = localize(
            isStreaming ? "com_linsight_deep_thinking_running_compact" : "com_linsight_deep_thinking_done_compact",
        );

        // Walk the events in arrival order, folding only ADJACENT thinking
        // fragments into one passage. The wire and the DB already interleave
        // thinking and tool calls truthfully (the backend closes the open
        // thinking segment before every tool call), so the render must not
        // regroup them: reasoning that happened after a search belongs below
        // that search, not merged into the block above it. Mirrors task mode's
        // DeepStepGroup.buildSegments.
        const segments = useMemo(() => {
            type Segment =
                | { kind: "thinking"; key: string; content: string }
                | { kind: "tool"; key: string; toolCall: Extract<AgentEvent, { type: "tool_call" }> };
            const out: Segment[] = [];
            events.forEach((ev, i) => {
                if (ev.type === "thinking") {
                    // A just-opened live segment has no text yet — skip it so the
                    // connector chain never points at a row that renders nothing.
                    if (!ev.content) return;
                    const last = out[out.length - 1];
                    if (last?.kind === "thinking") {
                        // Adjacent rounds are distinct closed passages (unlike task
                        // mode's per-frame chunks), so a paragraph break is right.
                        last.content += `\n\n${ev.content}`;
                    } else {
                        out.push({ kind: "thinking", key: `think-${i}`, content: ev.content });
                    }
                } else if (ev.type === "tool_call") {
                    out.push({ kind: "tool", key: ev.tool_call_id || `tc-${i}`, toolCall: ev });
                }
            });
            return out;
        }, [events]);

        return (
            <DeepThinkingDisclosure running={isStreaming} label={label}>
                {segments.map((seg, i) => {
                    // Connector runs to the next row, whatever kind it is.
                    const hasNext = i < segments.length - 1;
                    return seg.kind === "thinking" ? (
                        <ThinkingContent
                            key={seg.key}
                            reasoning={seg.content}
                            showConnector={hasNext}
                        />
                    ) : (
                        <ToolCallDisplay
                            key={seg.key}
                            toolCall={seg.toolCall}
                            showConnector={hasNext}
                        />
                    );
                })}
            </DeepThinkingDisclosure>
        );
    },
);

DeepThinkingGroup.displayName = "DeepThinkingGroup";

export default DeepThinkingGroup;
