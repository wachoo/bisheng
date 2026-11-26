from datetime import datetime
from enum import Enum
from typing import Union

from pydantic import BaseModel
from sqlalchemy import Column, DateTime, Integer, text
from sqlmodel import Field, col, delete, select

from bisheng.common.models.base import SQLModelSerializable
from bisheng.core.database import get_async_db_session, get_sync_db_session
from bisheng.core.database.dialect_helpers import UPDATE_TIME_SERVER_DEFAULT


class RoleAccessBase(SQLModelSerializable):
    role_id: int = Field(index=True)
    third_id: str = Field(index=False)
    type: int = Field(index=False)
    tenant_id: int | None = Field(
        default=None,
        sa_column=Column(Integer, nullable=False, server_default=text("1"), index=True, comment="Tenant ID"),
    )
    create_time: datetime | None = Field(
        default=None, sa_column=Column(DateTime, nullable=False, server_default=text("CURRENT_TIMESTAMP"))
    )
    update_time: datetime | None = Field(
        default=None, sa_column=Column(DateTime, nullable=False, server_default=UPDATE_TIME_SERVER_DEFAULT)
    )


class RoleAccess(RoleAccessBase, table=True):
    id: int | None = Field(default=None, primary_key=True)


class RoleAccessRead(RoleAccessBase):
    id: int | None = None


class RoleAccessCreate(RoleAccessBase):
    pass


class WebMenuResource(Enum):
    """Front-end menu bar resources — updated for v2.5 PRD (F005)."""

    # Level-1 menus
    WORKSTATION = "workstation"  # Workspace (user portal)
    ADMIN = "admin"  # Admin console (management portal)
    # Level-2 menus — build / resources
    BUILD = "build"  # Application build
    CREATE_APP = "create_app"  # Entry for "新建应用"/"管理应用模板" (sub-toggle of BUILD)
    KNOWLEDGE = "knowledge"  # Knowledge management
    CREATE_KNOWLEDGE = "create_knowledge"  # Admin KB list: "创建" (doc/QA lib); sub-toggle of KNOWLEDGE
    KNOWLEDGE_SPACE = "knowledge_space"  # Knowledge space
    MODEL = "model"  # Model management
    TOOL = "tool"  # Tool management
    MCP = "mcp"  # MCP services
    CHANNEL = "channel"  # Channel management
    # Level-2 menus — evaluation / data
    EVALUATION = "evaluation"  # Model evaluation
    DATASET = "dataset"  # Dataset management
    MARK_TASK = "mark_task"  # Annotation tasks
    BOARD = "board"  # Dashboard / kanban
    COMPANY_LEADBOARD = "company_leadboard"
    COMPANY_MONITORBOARD = "company_monitorboard"
    COMPANY_BOARD_LEDGER = "company_board_ledger"
    COMPANY_BOARD_FEEDBACK = "company_board_feedback"
    # System management
    SUBSCRIPTION = "subscription"  # Subscription management
    # Workbench sidebar (user portal) — granular toggles under ``workstation``
    HOME = "home"  # Chat / 首页
    LINSIGHT_TASK_MODE = "linsight_task_mode"  # 灵思任务模式 (sub-toggle under 首页, F035)
    APPS = "apps"  # 应用中心 / Agent hub
    # Deprecated (AD-07, kept for backward compat)
    FRONTEND = "frontend"  # deprecated
    BACKEND = "backend"  # deprecated
    CREATE_DASHBOARD = "create_dashboard"  # deprecated


COMPANY_WIDE_BOARD_KEYS = frozenset({
    WebMenuResource.COMPANY_LEADBOARD.value,
    WebMenuResource.COMPANY_BOARD_LEDGER.value,
    WebMenuResource.COMPANY_BOARD_FEEDBACK.value,
})


class AccessType(Enum):
    """Type of the role_access"""

    KNOWLEDGE = 1  # Knowledge Base Reading Permissions
    KNOWLEDGE_WRITE = 3  # Knowledge Base Write Permissions
    ASSISTANT_READ = 5  # Assistant Read Permissions
    ASSISTANT_WRITE = 6  # Assistant Write Permissions
    GPTS_TOOL_READ = 7  # Tool Read Permissions
    GPTS_TOOL_WRITE = 8  # Tool Write Permissions
    WORKFLOW = 9  # Workflow Read Permissions
    WORKFLOW_WRITE = 10  # Workflow write permissions
    DASHBOARD = 11  # Kanban Reading Permissions
    DASHBOARD_WRITE = 12  # Kanban writing permissions

    WEB_MENU = 99  # Frontend Menu Bar Permission Restrictions


class RoleRefresh(BaseModel):
    role_id: int
    access_id: list[Union[str, int]]
    type: int


class RoleAccessDao(RoleAccessBase):
    @classmethod
    def company_board_roles_query(cls):
        return select(RoleAccess.role_id).where(
            RoleAccess.type == AccessType.WEB_MENU.value, RoleAccess.third_id.in_(COMPANY_WIDE_BOARD_KEYS)
        ).distinct()

    @classmethod
    async def acompany_board_role_ids(cls, role_ids: set[int]) -> set[int]:
        """Find protected grants among the caller's candidate roles, including global roles."""
        if not role_ids:
            return set()
        from bisheng.core.context.tenant import bypass_tenant_filter

        # A global role can be shared across tenants. Only return the preselected
        # candidate IDs; this lookup never makes a role visible or assignable.
        with bypass_tenant_filter():
            async with get_async_db_session() as session:
                rows = await session.exec(cls.company_board_roles_query().where(RoleAccess.role_id.in_(role_ids)))
                return set(rows.all())

    @classmethod
    def get_role_access(cls, role_ids: list[int], access_type: AccessType) -> list[RoleAccess]:
        with get_sync_db_session() as session:
            if access_type:
                return session.exec(
                    select(RoleAccess).where(RoleAccess.role_id.in_(role_ids), RoleAccess.type == access_type.value)
                ).all()
            return session.exec(select(RoleAccess).where(RoleAccess.role_id.in_(role_ids))).all()

    @classmethod
    async def aget_role_access(cls, role_ids: list[int], access_type: AccessType = None) -> list[RoleAccess]:
        statement = select(RoleAccess).where(RoleAccess.role_id.in_(role_ids))
        if access_type:
            statement = statement.where(RoleAccess.type == access_type.value)

        async with get_async_db_session() as session:
            return (await session.exec(statement)).all()

    @classmethod
    def get_role_access_batch(cls, role_ids: list[int], access_type: list[AccessType]) -> list[RoleAccess]:
        with get_sync_db_session() as session:
            if access_type:
                return session.exec(
                    select(RoleAccess).where(
                        RoleAccess.role_id.in_(role_ids), RoleAccess.type.in_([x.value for x in access_type])
                    )
                ).all()

    @classmethod
    async def aget_role_access_batch(cls, role_ids: list[int], access_type: list[AccessType]) -> list[RoleAccess]:
        statement = select(RoleAccess).where(col(RoleAccess.role_id).in_(role_ids))
        if access_type:
            statement = statement.where(col(RoleAccess.type).in_([x.value for x in access_type]))

        async with get_async_db_session() as session:
            return (await session.exec(statement)).all()

    @classmethod
    def judge_role_access(cls, role_ids: list[int], third_id: str, access_type: AccessType) -> RoleAccess | None:
        with get_sync_db_session() as session:
            return session.exec(
                select(RoleAccess).filter(
                    RoleAccess.role_id.in_(role_ids),
                    RoleAccess.type == access_type.value,
                    RoleAccess.third_id == third_id,
                )
            ).first()

    @classmethod
    async def ajudge_role_access(
        cls, role_ids: list[int], third_id: str, access_type: AccessType
    ) -> RoleAccess | None:
        statement = select(RoleAccess).filter(
            col(RoleAccess.role_id).in_(role_ids),
            col(RoleAccess.type) == access_type.value,
            col(RoleAccess.third_id) == third_id,
        )
        async with get_async_db_session() as session:
            return (await session.exec(statement)).first()

    @classmethod
    def find_role_access(cls, role_ids: list[int], third_ids: list[str], access_type: AccessType) -> list[RoleAccess]:
        with get_sync_db_session() as session:
            if access_type:
                return session.exec(
                    select(RoleAccess).where(
                        RoleAccess.role_id.in_(role_ids),
                        RoleAccess.third_id.in_(third_ids),
                        RoleAccess.type == access_type.value,
                    )
                ).all()
            return session.exec(select(RoleAccess).where(RoleAccess.role_id.in_(role_ids))).all()

    @classmethod
    async def afind_role_access(
        cls, role_ids: list[int], third_ids: list[str], access_type: AccessType
    ) -> list[RoleAccess]:
        statement = select(RoleAccess).where(
            col(RoleAccess.role_id).in_(role_ids), col(RoleAccess.third_id).in_(third_ids)
        )
        if access_type:
            statement = statement.where(col(RoleAccess.type) == access_type.value)
        async with get_async_db_session() as session:
            return (await session.exec(statement)).all()

    @classmethod
    async def update_role_access_all(
        cls, role_id: int, access_type: AccessType, access_ids: list[Union[str, int]]
    ) -> None:
        """
        Update the role's permissions, delete it first and add it later
        """
        async with get_async_db_session() as session:
            # Clear all old permissions first
            statement = delete(RoleAccess).where(
                col(RoleAccess.role_id) == str(role_id), col(RoleAccess.type) == access_type.value
            )
            await session.exec(statement)
            # Add New Permission
            for access_id in access_ids:
                role_access = RoleAccess(role_id=role_id, third_id=str(access_id), type=access_type.value)
                session.add(role_access)
            await session.commit()
