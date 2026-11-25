from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest import IsolatedAsyncioTestCase
from unittest.mock import AsyncMock, Mock, patch

from bisheng.api.services.assistant_skills import bind_skill_tools, selected_skills
from bisheng.api.v1.schemas import AssistantUpdateReq
from bisheng_langchain.gpts.tools.code_interpreter.local_executor import LocalExecutor


class AssistantManagedSkillsTest(IsolatedAsyncioTestCase):
    def test_legacy_save_and_explicit_removal(self):
        self.assertIsNone(AssistantUpdateReq(id="old").skill_ids)
        self.assertEqual(AssistantUpdateReq(id="old", skill_ids=[]).skill_ids, [])

    async def test_only_bound_and_currently_available_ids_are_loaded(self):
        allowed = SimpleNamespace(id=19)
        other = SimpleNamespace(id=20)
        records = AsyncMock(return_value=[(allowed, True), (other, True)])
        with patch("bisheng.api.services.assistant_skills.UserSkillsService.records", records):
            self.assertEqual(await selected_skills(None, 7), [])
            records.assert_not_called()
            self.assertEqual(await selected_skills([18, 19], 7), [allowed])
            records.return_value = []
            self.assertEqual(await selected_skills([19], 7), [])

    async def test_reader_and_interpreter_receive_same_selected_bundle(self):
        row = SimpleNamespace(name="word", display_name="Word", description="docs", content_hash="v1",
                              tenant_id=1, owner_user_id=0)
        executor = LocalExecutor(minio={})
        tools = [SimpleNamespace(name="bisheng_code_interpreter", executor=executor)]
        with TemporaryDirectory() as source, patch("bisheng.api.services.assistant_skills.SkillStore") as store:
            Path(source, "SKILL.md").write_text("instructions")
            store.return_value.materialize.return_value = Path(source)
            store.return_value.read_text.return_value = "instructions"
            workspace = await bind_skill_tools([row], tools)
            self.addCleanup(workspace.cleanup)
            self.assertEqual(Path(executor.local_sync_path, "skills/word/SKILL.md").read_text(), "instructions")
            reader = tools[-1]
            self.assertEqual(reader.invoke({"name": "other"}), "Skill unavailable")
            store.return_value.read_text.assert_not_called()
            self.assertEqual(reader.invoke({"name": "word"}), "instructions")
            store.return_value.read_text.assert_called_once_with(1, "word", "v1", "SKILL.md", owner_user_id=0)

    async def test_react_loop_can_read_a_bound_skill(self):
        from langchain_core.language_models.fake import FakeListLLM
        from bisheng_langchain.gpts.agent_types.llm_react_agent import get_react_agent_executor

        row = SimpleNamespace(name="word", display_name="Word", description="docs", content_hash="v1",
                              tenant_id=1, owner_user_id=0)
        tools = []
        with patch("bisheng.api.services.assistant_skills.SkillStore") as store:
            store.return_value.read_text.return_value = "bundle instructions"
            await bind_skill_tools([row], tools)
            llm = FakeListLLM(responses=[
                '{"action":"read_assistant_skill","action_input":{"name":"word"}}',
                '{"action":"Final Answer","action_input":"done"}',
            ])
            graph = get_react_agent_executor(tools, llm, "Use the selected skill.", False)
            result = await graph.ainvoke({"input": "read word", "chat_history": []})
        self.assertEqual(result["intermediate_steps"][0][1], "bundle instructions")
        self.assertEqual(result["agent_outcome"].return_values["output"], "done")

    def test_skill_delivery_exposes_only_outputs_through_same_origin_proxy(self):
        executor = LocalExecutor(minio={})
        executor.assistant_skill_outputs = True
        executor.upload_minio = Mock(return_value="http://internal/tmp-dir/report.docx?signature=abc")
        with TemporaryDirectory() as directory:
            for rel in ("scratch/build.py", "output/report.docx"):
                path = Path(directory, rel)
                path.parent.mkdir()
                path.write_bytes(b"test")
            links = executor._publish_generated_files(directory, ["scratch/build.py", "output/report.docx"])
        self.assertEqual(links, ["/tmp-dir/report.docx?signature=abc"])
        executor.upload_minio.assert_called_once()
