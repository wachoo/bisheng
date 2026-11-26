"""Local test doubles for the two upstream services used by live-assets.cjs.

Run only on the local BiSheng Docker network. No host ports, credentials or
access to BiSheng storage are needed. The application still performs its real
MCP discovery/invocation, embedding requests, indexing and retrieval.
"""

import base64
import hashlib
import math
import struct

from mcp.server.fastmcp import FastMCP
from starlette.responses import JSONResponse


mcp = FastMCP("board1126-local", host="0.0.0.0", port=8126, stateless_http=True, json_response=True)


@mcp.tool()
def board1126_quote(supplier: str = "甲", reject: bool = False) -> str:
    """查询验收供应商报价，reject=true 时模拟供应商接口拒绝服务。"""
    if reject:
        raise ValueError("验收模拟：供应商报价服务拒绝请求")
    return f"验收报价单 Q-1126：供应商{supplier}，含税总价 18.6 万元。"


@mcp.custom_route("/v1/embeddings", methods=["POST"])
async def embed(request):
    body = await request.json()
    inputs = body["input"]
    if isinstance(inputs, str):
        inputs = [inputs]
    data = []
    for index, entry in enumerate(inputs):
        vector = [0.0] * 64
        for char in str(entry) or " ":
            vector[hashlib.sha256(char.encode()).digest()[0] % len(vector)] += 1
        norm = math.sqrt(sum(x * x for x in vector))
        values = [x / norm for x in vector]
        if body.get("encoding_format") == "base64":
            values = base64.b64encode(struct.pack("<64f", *values)).decode()
        data.append({"index": index, "object": "embedding", "embedding": values})
    return JSONResponse({"object": "list", "data": data, "model": body["model"],
                         "usage": {"prompt_tokens": len(inputs), "total_tokens": len(inputs)}})


if __name__ == "__main__":
    mcp.run(transport="streamable-http")
