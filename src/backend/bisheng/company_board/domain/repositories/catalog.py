from sqlalchemy import func
from sqlmodel import select

from bisheng.core.database import get_async_db_session
from bisheng.database.models.app import APP_STATE_ONLINE, App
from bisheng.database.models.assistant import Assistant, AssistantStatus
from bisheng.database.models.department import Department
from bisheng.database.models.flow import Flow, FlowStatus, FlowType
from bisheng.knowledge.domain.models.knowledge import AuthTypeEnum, Knowledge, KnowledgeState, KnowledgeTypeEnum
from bisheng.linsight.domain.models.linsight_skill import LinsightSkill
from bisheng.tool.domain.models.gpts_tools import GptsTools, GptsToolsType


async def load_catalog(tenant_id: int) -> tuple[list[dict], list[dict]]:
    """Read catalog metadata only. Current availability does not prove a historical first release."""
    sources = [
        (
            "employee",
            "assistant",
            select(Assistant.id, Assistant.name).where(
                Assistant.tenant_id == tenant_id,
                Assistant.status == AssistantStatus.ONLINE.value,
                Assistant.is_delete == 0,
            ),
        ),
        (
            "employee",
            "flow",
            select(Flow.id, Flow.name).where(
                Flow.tenant_id == tenant_id,
                Flow.status == FlowStatus.ONLINE.value,
                Flow.flow_type == FlowType.WORKFLOW.value,
            ),
        ),
        ("employee", "app", select(App.id, App.name).where(App.tenant_id == tenant_id, App.state == APP_STATE_ONLINE)),
        (
            "knowledge",
            "knowledge",
            select(Knowledge.id, Knowledge.name).where(
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
                LinsightSkill.id, func.coalesce(func.nullif(LinsightSkill.display_name, ""), LinsightSkill.name)
            ).where(LinsightSkill.tenant_id == tenant_id, LinsightSkill.owner_user_id == 0, LinsightSkill.enabled == 1),
        ),
        (
            "tool",
            "tool",
            select(GptsTools.id, GptsTools.name)
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
        rows = await session.exec(
            select(Department.id, Department.name)
            .where(Department.tenant_id == tenant_id, Department.is_deleted == 0, Department.status == "active")
            .order_by(Department.name, Department.id)
        )
        departments = [{"id": ident, "name": name} for ident, name in rows.all()]
        assets = []
        for kind, prefix, query in sources:
            for ident, name in (await session.exec(query)).all():
                assets.append({"id": f"{prefix}:{ident}", "kind": kind, "name": name, "department_id": None})
    return departments, sorted(assets, key=lambda a: (a["kind"], a["name"], a["id"]))
