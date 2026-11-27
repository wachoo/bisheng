import json

from sqlalchemy import case, func
from sqlmodel import select
from bisheng.company_board.domain.repositories.planning_departments import board_departments

from bisheng.core.database import get_async_db_session
from bisheng.database.models.app import APP_STATE_ONLINE, App
from bisheng.database.models.assistant import Assistant, AssistantStatus
from bisheng.database.models.flow import Flow, FlowStatus, FlowType
from bisheng.knowledge.domain.models.knowledge import AuthTypeEnum, Knowledge, KnowledgeState, KnowledgeTypeEnum
from bisheng.linsight.domain.models.linsight_skill import LinsightSkill
from bisheng.tool.domain.const import ToolPresetType
from bisheng.tool.domain.models.gpts_tools import GptsTools, GptsToolsType


def mcp_display_name(metadata, operation):
    if isinstance(metadata, str):
        try:
            metadata = json.loads(metadata)
        except ValueError:
            return operation
    if isinstance(metadata, dict):
        annotations = metadata.get("annotations")
        for title in (metadata.get("title"), annotations.get("title") if isinstance(annotations, dict) else None):
            if isinstance(title, str) and title.strip():
                return title.strip()
    return operation


async def load_catalog(tenant_id: int) -> tuple[list[dict], list[dict]]:
    """Read catalog metadata only. Current availability does not prove a historical first release."""
    sources = [
        (
            "employee",
            "assistant",
            select(Assistant.id, Assistant.name, Assistant.desc).where(
                Assistant.tenant_id == tenant_id,
                Assistant.status == AssistantStatus.ONLINE.value,
                Assistant.is_delete == 0,
            ),
        ),
        (
            "employee",
            "flow",
            select(Flow.id, Flow.name, Flow.description).where(
                Flow.tenant_id == tenant_id,
                Flow.status == FlowStatus.ONLINE.value,
                Flow.flow_type == FlowType.WORKFLOW.value,
            ),
        ),
        (
            "employee",
            "app",
            select(App.id, App.name, App.description).where(App.tenant_id == tenant_id, App.state == APP_STATE_ONLINE),
        ),
        (
            "knowledge",
            "knowledge",
            select(Knowledge.id, Knowledge.name, Knowledge.description).where(
                Knowledge.tenant_id == tenant_id,
                Knowledge.state == KnowledgeState.PUBLISHED.value,
                Knowledge.type != KnowledgeTypeEnum.PRIVATE.value,
                Knowledge.auth_type == AuthTypeEnum.PUBLIC,
            ),
        ),
        (
            "skill",
            "skill",
            select(
                LinsightSkill.id,
                func.coalesce(func.nullif(LinsightSkill.display_name, ""), LinsightSkill.name),
                LinsightSkill.description,
            ).where(LinsightSkill.tenant_id == tenant_id, LinsightSkill.owner_user_id == 0, LinsightSkill.enabled == 1),
        ),
        (
            "tool",
            "tool",
            select(
                GptsTools.id, GptsTools.name, GptsTools.desc, GptsTools.type,
                case((GptsTools.is_preset == ToolPresetType.MCP.value, GptsTools.extra)),
            )
            .join(GptsToolsType, GptsToolsType.id == GptsTools.type)
            .where(
                GptsTools.tenant_id == tenant_id,
                GptsToolsType.tenant_id == tenant_id,
                GptsTools.is_delete == 0,
                GptsToolsType.is_delete == 0,
            ),
        ),
    ]
    async with get_async_db_session() as session:
        departments = (await board_departments(session, tenant_id)).options
        assets = []
        for kind, prefix, query in sources:
            for ident, name, description, *group in (await session.exec(query)).all():
                asset = {
                    "id": f"{prefix}:{ident}",
                    "kind": kind,
                    "name": name,
                    "description": description,
                    "department_id": None,
                }
                if group:
                    asset["context_key"] = f"toolset:{group[0]}"
                    asset["name"] = mcp_display_name(group[1], name)
                assets.append(asset)
    return departments, sorted(assets, key=lambda a: (a["kind"], a["name"], a["id"]))
