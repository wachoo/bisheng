"""Local deterministic model for exercising BiSheng's real tool clients and callbacks.

Run inside the local Compose network. This fixture has no database access.
Only prompts bearing the test markers request tools. Tool results must come
back in the conversation before the model will finish the tool scenario.
"""

import json
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from uuid import uuid4


def requested_calls(data):
    messages = data.get("messages", [])
    user_at = max((i for i, m in enumerate(messages) if m["role"] == "user"), default=-1)
    prompt = str(messages[user_at].get("content", "")) if user_at >= 0 else ""
    if "BOARD-TOOLS" not in prompt:
        return []
    done = {
        c["function"]["name"]
        for msg in messages[user_at + 1:]
        for c in msg.get("tool_calls", [])
    }
    for tool in data.get("tools", []):
        fn = tool["function"]
        name = fn["name"]
        if name in done:
            continue
        if name == "use_assistant_skill":
            args = {"name": "board1126-quote-check"}
        elif name.startswith("knowledge_") and name[10:].isdigit():
            fields = fn.get("parameters", {}).get("required", [])
            args = {key: "采购报价的交期与付款条件" for key in fields}
        elif "board1126_quote" in name.lower():
            args = {"supplier": "甲", "reject": "BOARD-REJECT" in prompt}
        else:
            continue
        return [{"id": "call_" + uuid4().hex, "type": "function",
                 "function": {"name": name, "arguments": json.dumps(args, ensure_ascii=False)}}]
    return []


class Handler(BaseHTTPRequestHandler):
    def json_response(self, payload):
        body = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.rstrip("/") == "/v1/models":
            self.json_response({"object": "list", "data": [{"id": "board-live-chat", "object": "model"}]})
        else:
            self.send_error(404)

    def do_POST(self):
        if self.path.rstrip("/") != "/v1/chat/completions":
            return self.send_error(404)
        data = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        calls = requested_calls(data)
        message = {"role": "assistant"}
        if calls:
            message["tool_calls"] = calls
        else:
            replies = [str(m.get("content", "")) for m in data.get("messages", []) if m["role"] == "tool"]
            markers = [m for m in ("K-1126", "Q-1126") if any(m in reply for reply in replies)]
            message["content"] = "采集验收模型已完成本轮。" + " ".join(markers)
        finish = "tool_calls" if calls else "stop"
        meta = {"id": "board-" + uuid4().hex, "created": int(time.time()), "model": "board-live-chat"}
        usage = {"prompt_tokens": 12, "completion_tokens": 6, "total_tokens": 18}
        if not data.get("stream"):
            return self.json_response({**meta, "object": "chat.completion", "usage": usage,
                                       "choices": [{"index": 0, "message": message, "finish_reason": finish}]})
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        for i, call in enumerate(calls):
            call["index"] = i
        for chunk in (
            {"choices": [{"index": 0, "delta": message, "finish_reason": None}]},
            {"choices": [{"index": 0, "delta": {}, "finish_reason": finish}]},
            {"choices": [], "usage": usage},
        ):
            event = json.dumps({**meta, "object": "chat.completion.chunk", **chunk}, ensure_ascii=False)
            self.wfile.write(("data: " + event + "\n\n").encode())
        self.wfile.write(b"data: [DONE]\n\n")


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 8000), Handler).serve_forever()
