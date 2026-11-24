"""Presentation history for one assistant generation and its model callbacks."""

from contextvars import ContextVar


class AssistantTurn:
    def __init__(self):
        self.answer_chunks: list[str] = []
        self.steps: list[dict] = []
        self.tools: dict[str, dict] = {}

    def record_token(self, token: str, reasoning: str):
        if token:
            self.answer_chunks.append(token)
        if reasoning:
            if not self.steps or self.steps[-1]["type"] != "reasoning":
                self.steps.append({"type": "reasoning", "chunks": []})
            self.steps[-1]["chunks"].append(reasoning)

    def start_tool(self, run_id: str, category: str, tool_key: str):
        step = {"type": "tool", "run_id": run_id, "category": category, "tool_key": tool_key, "status": "stopped"}
        self.steps.append(step)
        self.tools[run_id] = step

    def finish_tool(self, run_id: str, status: str):
        if run_id in self.tools:
            self.tools[run_id]["status"] = status

    def timeline(self) -> list[dict]:
        return [
            {"type": "reasoning", "text": "".join(step["chunks"])} if step["type"] == "reasoning" else step.copy()
            for step in self.steps
        ]


# A cached callback may serve several generations. Tasks spawned by LangChain
# inherit the context of the generation that invoked them.
current_assistant_turn: ContextVar[AssistantTurn | None] = ContextVar("current_assistant_turn", default=None)
