"""Replay T08/T09 in an isolated backend container.

The backend image must include test/company_board. Attach only a private Docker
network with a disposable S3-compatible service named objects on port 9000.
Pass its ephemeral credentials in BOARD_T09_ACCESS_KEY and BOARD_T09_SECRET_KEY.
Use an empty application config and PYTHONPATH=/app. The fixture uses in-memory
SQLite, a controlled assistant, and test doubles for identity and chat transport.
The code interpreter, S3 upload/download, delivery tool and board queries are real.

Run from the checkout root in PowerShell 7.3+ with both images already present:

    $ErrorActionPreference = 'Stop'
    $PSNativeCommandUseErrorActionPreference = $true
    $tag = 'board-delivery-' + [Guid]::NewGuid().ToString('N').Substring(0,12)
    $net = "$tag-net"
    $store = "$tag-s3"
    $probe = (Resolve-Path 'features/v3.0.2/122-company-boards/acceptance/delivery-observer.py').Path
    $cfg = Join-Path ([IO.Path]::GetTempPath()) "$tag.yaml"
    '{}' | Set-Content -Encoding ascii -LiteralPath $cfg
    $env:RUSTFS_ACCESS_KEY = 't09' + [Guid]::NewGuid().ToString('N').Substring(0,10)
    $env:RUSTFS_SECRET_KEY = [Guid]::NewGuid().ToString('N')
    $env:BOARD_T09_ACCESS_KEY = $env:RUSTFS_ACCESS_KEY
    $env:BOARD_T09_SECRET_KEY = $env:RUSTFS_SECRET_KEY
    $objectImage = 'crpi-6q638zy09wmnj70w.cn-hangzhou.personal.cr.aliyuncs.com/knowflow-ai/rustfs-rustfs:1.0.0-beta.7'
    docker network create --internal $net | Out-Null
    try {
      docker run --pull never --rm -d --name $store --network $net --network-alias objects --tmpfs /data:rw,mode=0777 -e RUSTFS_VOLUMES=/data -e RUSTFS_ACCESS_KEY -e RUSTFS_SECRET_KEY $objectImage | Out-Null
      try {
        docker run --pull never --rm --network $net --mount "type=bind,source=$probe,target=/probe.py,readonly" --mount "type=bind,source=$cfg,target=/tmp/isolated.yaml,readonly" -e config=/tmp/isolated.yaml -e PYTHONPATH=/app -e BOARD_T09_ACCESS_KEY -e BOARD_T09_SECRET_KEY --entrypoint /app/.venv/bin/python local/company-boards-backend:122 /probe.py
      } finally { docker stop $store | Out-Null }
    } finally {
      docker network rm $net | Out-Null
      Remove-Item -LiteralPath $cfg
    }
"""

import json
import os
import time
import unittest
from hashlib import sha256
from pathlib import PurePosixPath
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from urllib.parse import urlsplit
from urllib.request import urlopen
from uuid import uuid4

from langchain_core.messages import AIMessage
from minio import Minio
from sqlalchemy import select
from test.company_board import test_runtime_observation as fixture

from bisheng.api.services.assistant_agent import AssistantAgent
from bisheng.common.constants.enums.telemetry import ApplicationTypeEnum
from bisheng.company_board.domain.models.runtime_event import BoardRuntimeEvent
from bisheng.tool.domain.services.executor import ToolExecutor
from bisheng_langchain.gpts.tools.code_interpreter.local_executor import LocalExecutor
from bisheng_langchain.gpts.tools.code_interpreter.tool import CodeInterpreterTool


class DeliveryObserver(fixture.LocalWebRuntimeTests):
    async def delivery_tools(self):
        endpoint = "objects:9000"
        storage = {
            "endpoint": endpoint,
            "sharepoint": endpoint,
            "access_key": os.environ["BOARD_T09_ACCESS_KEY"],
            "secret_key": os.environ["BOARD_T09_SECRET_KEY"],
            "secure": False,
            "tmp_bucket": "delivery-" + uuid4().hex,
        }
        store = Minio(endpoint, storage["access_key"], storage["secret_key"], secure=False)
        store.make_bucket(storage["tmp_bucket"])
        interpreter = CodeInterpreterTool(executor=LocalExecutor(minio=storage, assistant_skill_outputs=True))
        tool_record = SimpleNamespace(id=7, is_preset=1, tool_key=interpreter.name, name="Code interpreter")
        tool = ToolExecutor.init_by_tool_instance(
            interpreter,
            tool_record,
            app_id="asset",
            app_name="fixture",
            app_type=ApplicationTypeEnum.ASSISTANT,
            user_id=7,
        )
        self.enterContext(
            patch(
                "bisheng.api.services.assistant_agent.AssistantLinkDao.get_assistant_link",
                AsyncMock(return_value=[SimpleNamespace(tool_id=7)]),
            )
        )
        self.enterContext(patch.object(ToolExecutor, "init_by_tool_ids", AsyncMock(return_value=[tool])))
        self.enterContext(patch.object(ToolExecutor, "_require_current_use", AsyncMock()))
        self.enterContext(
            patch("bisheng.tool.domain.services.executor.UserToolAvailabilityService.ensure_enabled", AsyncMock())
        )
        self.enterContext(patch("bisheng.tool.domain.services.executor.telemetry_service.log_event", AsyncMock()))
        self.enterContext(patch("bisheng.common.chat.client.save_message_citations", AsyncMock()))
        agent = AssistantAgent(
            SimpleNamespace(id="asset", name="fixture", skill_ids=[]), "web-session", 7, board_deliveries=True
        )
        await agent.init_tools()
        return {item.name: item for item in agent.tools}

    def verify_files(self, links, expected):
        """Read each signed file link from the private store and check its type and bytes."""
        self.assertEqual(len(links), len(expected))
        contents = {PurePosixPath(name).suffix: text.encode() for name, text in expected.items()}
        receipts = []
        for link in links:
            location = urlsplit(link)
            self.assertIn((location.scheme, location.netloc), {("", ""), ("http", "objects:9000")})
            self.assertTrue(location.path.startswith("/"))
            obj = PurePosixPath(location.path)
            url = link if location.netloc else "http://objects:9000" + link
            with urlopen(url, timeout=5) as response:
                raw = response.read()
            self.assertEqual(raw, contents.pop(obj.suffix))
            receipts.append({"object": obj.name, "sha256": sha256(raw).hexdigest(), "size": len(raw)})
        self.assertFalse(contents)
        return receipts

    async def test_deliveries_and_failed_work_time(self):
        tools = await self.delivery_tools()
        client = self.web_chat_client()
        files = {
            "files": {
                "notes.txt": "three deliveries",
                "terms.csv": "item,qty\nA,7\n",
                "summary.html": "<p>delivered</p>",
            },
            "version": {"main.py": "print(7)\n", "index.html": "<p>v1</p>"},
        }
        receipts = []

        async def respond(prompt, history, callbacks):
            if prompt == "code-text":
                return [AIMessage(content="print(7)")]
            expected = files.get(prompt, {})
            lines = ["from pathlib import Path", "import time", "Path('output').mkdir(exist_ok=True)"]
            if prompt == "failed":
                lines.extend(["time.sleep(0.4)", "print('waited')"])
            for filename, content in expected.items():
                lines.append(f"Path({'output/' + filename!r}).write_text({content!r})")
            config = {"callbacks": callbacks}
            started = time.perf_counter()
            result = await tools["bisheng_code_interpreter"].ainvoke({"python_code": "\n".join(lines)}, config=config)
            tool_seconds = time.perf_counter() - started
            if isinstance(result, str):
                result = json.loads(result)
            self.assertEqual(result["exitcode"], 0, result.get("log", ""))
            links = result["file_list"]
            receipts.append(
                {"turn": prompt, "objects": self.verify_files(links, expected), "tool_seconds": round(tool_seconds, 3)}
            )
            if prompt == "failed":
                raise RuntimeError("controlled failure after the tool wait")
            delivery = tools["register_assistant_delivery"]
            self.assertEqual(await delivery.ainvoke({"file_links": links}, config=config), "Delivery recorded.")
            if prompt == "version":
                # Both already-registered files become members of one version. Repeat its registration.
                version = {"file_links": links, "project": "cost-review", "version": "r1"}
                for _ in range(2):
                    self.assertEqual(await delivery.ainvoke(version, config=config), "Delivery recorded.")
            return [AIMessage(content="done")]

        client.gpts_agent.run = respond
        stages = []
        for stage, totals in [
            ("files", (3, 0, 3)),
            ("version", (3, 1, 4)),
            ("code-text", (3, 1, 4)),
            ("failed", (3, 1, 4)),
        ]:
            started = time.perf_counter()
            await client.handle_gpts_message({"inputs": {"input": stage}})
            elapsed = time.perf_counter() - started
            summary = await self.query()
            observed = tuple(summary[key] for key in ("file_outputs", "code_versions", "deliverables"))
            self.assertEqual(observed, totals)
            stages.append(
                {
                    "stage": stage,
                    "wall_seconds": round(elapsed, 3),
                    "files_versions_total": observed,
                    "success": summary["successful_tasks"],
                    "failed": summary["failed_tasks"],
                    "active_seconds_sum": summary["active_seconds"],
                }
            )
        self.assertEqual((summary["successful_tasks"], summary["failed_tasks"], summary["timed_tasks"]), (3, 1, 4))
        event = BoardRuntimeEvent
        async with self.engine.connect() as db:
            query = select(
                event.kind,
                event.run_id,
                event.status,
                event.active_seconds,
                event.member_file_id,
                event.member_version_id,
            )
            events = (await db.execute(query)).mappings().all()
        failed = next(row for row in events if row["kind"] == "employee" and row["status"] == "failed")
        self.assertGreater(failed["active_seconds"], 0)
        self.assertEqual(receipts[-1]["turn"], "failed")
        self.assertGreaterEqual(receipts[-1]["tool_seconds"], 0.4)
        self.assertGreaterEqual(stages[-1]["wall_seconds"] - failed["active_seconds"], 0.39)
        self.assertAlmostEqual(
            stages[-1]["active_seconds_sum"] - stages[-2]["active_seconds_sum"], failed["active_seconds"], places=3
        )
        members = [row for row in events if row["kind"] == "version_member"]
        self.assertEqual(len(members), 2)
        self.assertEqual(len({row["member_file_id"] for row in members}), 2)
        self.assertEqual(len({row["member_version_id"] for row in members}), 1)
        print(
            "DELIVERY_EVIDENCE "
            + json.dumps({"stages": stages, "objects": receipts, "events": [dict(row) for row in events]})
        )


if __name__ == "__main__":
    unittest.main(defaultTest="DeliveryObserver.test_deliveries_and_failed_work_time", verbosity=2)
