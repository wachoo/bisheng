"""Adapt authorized managed bundles to the assistant's native tool interface."""
import asyncio
import shutil
from pathlib import Path
from tempfile import TemporaryDirectory

from langchain_core.tools import StructuredTool

from bisheng.linsight.domain.services.skill_store import SkillStore
from bisheng.linsight.domain.services.user_skills import UserSkillsService


async def selected_skills(skill_ids, user_id):
    if not skill_ids:
        return []
    allowed = {row.id: row for row, _ in await UserSkillsService(user_id).records()}
    return [allowed[i] for i in skill_ids if i in allowed]


async def bind_skill_tools(rows, tools):
    store = SkillStore()
    selected = {row.name: row for row in rows}
    catalog = "\n".join(f"{row.name}: {row.display_name} — {row.description}" for row in rows)

    def read_skill(name: str, path: str = "SKILL.md") -> str:
        """Read the instructions or a referenced text file from a selected skill."""
        row = selected.get(name)
        if row is None:
            return "Skill unavailable"
        try:
            return store.read_text(row.tenant_id, name, row.content_hash, path, owner_user_id=row.owner_user_id)
        except (FileNotFoundError, ValueError):
            return "Skill file unavailable"

    workspace = None
    interpreter = next((tool for tool in tools if tool.name == "bisheng_code_interpreter"), None)
    if interpreter:
        workspace = TemporaryDirectory(prefix="assistant-skills-")

        def stage():
            for row in rows:
                source = store.materialize(row.tenant_id, row.name, row.content_hash, owner_user_id=row.owner_user_id)
                shutil.copytree(source, Path(workspace.name, "skills", row.name))

        try:
            await asyncio.to_thread(stage)
        except BaseException:
            workspace.cleanup()
            raise
        interpreter.executor.local_sync_path = workspace.name
        interpreter.executor.assistant_skill_outputs = True

    tools.append(StructuredTool.from_function(
        read_skill, name="read_assistant_skill",
        description="Read SKILL.md before using a matching skill. Read referenced files by relative path. "
                    "Use the code interpreter for deliverables and copy the exact relative download URL from file_list into a Markdown link. Available skills:\n" + catalog,
    ))
    return workspace
