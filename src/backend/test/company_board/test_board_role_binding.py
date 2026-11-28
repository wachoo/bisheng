import unittest
from contextlib import ExitStack, asynccontextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

from fastapi import HTTPException
from sqlalchemy.ext.asyncio import create_async_engine
from sqlmodel.ext.asyncio.session import AsyncSession

from bisheng.common.dependencies.user_deps import UserPayload
from bisheng.common.errcode.company_board import BoardLedgerInvalidError
from bisheng.common.errcode.department import DepartmentInvalidRolesError
from bisheng.company_board.domain.schemas.ledger import LedgerInput
from bisheng.company_board.domain.services.boards import record_entry
from bisheng.database.models.role import Role
from bisheng.database.models.role_access import AccessType, RoleAccess
from bisheng.department.domain.schemas.department_schema import DepartmentMemberEditApply
from bisheng.department.domain.services import department_service as dep
from bisheng.role.domain.services.role_service import RoleService
from bisheng.user.domain.models.user_role import UserRoleCreate, UserRoleDao

DEPARTMENT_ROLE = 20
LEADER_ROLE = 21


class BoardRoleBindingTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.engine = create_async_engine("sqlite+aiosqlite://")
        async with self.engine.begin() as connection:
            await connection.run_sync(Role.__table__.create)
            await connection.run_sync(RoleAccess.__table__.create)

        @asynccontextmanager
        async def session():
            async with AsyncSession(self.engine, expire_on_commit=False) as db:
                yield db

        async with session() as db:
            db.add_all(
                [
                    Role(id=DEPARTMENT_ROLE, role_type="global", tenant_id=1, role_name="monitor"),
                    Role(id=LEADER_ROLE, role_type="global", tenant_id=1, role_name="lead"),
                    RoleAccess(
                        role_id=DEPARTMENT_ROLE, type=AccessType.WEB_MENU.value, third_id="company_monitorboard"
                    ),
                    RoleAccess(role_id=LEADER_ROLE, type=AccessType.WEB_MENU.value, third_id="company_leadboard"),
                ]
            )
            await db.commit()
        self.stack = ExitStack()
        self.stack.enter_context(patch("bisheng.database.models.role_access.get_async_db_session", session))
        self.stack.enter_context(patch.object(dep, "get_async_db_session", session))
        self.dept = SimpleNamespace(id=10, dept_id="BS@test", path="/10/", parent_id=None, status="active")
        self.stack.enter_context(patch.object(dep, "_get_dept_and_check_permission", AsyncMock(return_value=self.dept)))
        self.stack.enter_context(patch.object(dep, "_can_access_dept", AsyncMock(return_value=True)))
        self.stack.enter_context(
            patch.object(RoleService, "_get_permission_level", AsyncMock(return_value="dept_admin"))
        )
        self.user = UserPayload(user_id=8, user_role=[7], tenant_id=1)

    async def asyncTearDown(self):
        self.stack.close()
        await self.engine.dispose()

    async def test_catalog_and_default_replacement(self):
        service = dep.DepartmentService
        rows = await service.aget_assignable_roles(self.dept.dept_id, self.user)
        self.assertEqual([r["id"] for r in rows], [DEPARTMENT_ROLE])
        catalog = await service._aget_assignable_roles_catalog([self.dept], self.user)
        self.assertEqual(catalog[self.dept.dept_id], rows)
        with self.assertRaises(DepartmentInvalidRolesError):
            await service._allowed_default_roles([LEADER_ROLE], [], self.user)
        self.assertEqual(
            await service._allowed_default_roles([], [LEADER_ROLE, DEPARTMENT_ROLE], self.user), [LEADER_ROLE]
        )
        with patch.object(RoleService, "_get_permission_level", AsyncMock(return_value="tenant_admin")):
            roles = await service.aget_assignable_roles(self.dept.dept_id, self.user)
            self.assertEqual({r["id"] for r in roles}, {DEPARTMENT_ROLE, LEADER_ROLE})

    async def test_member_editor_cannot_add_or_revoke_leadership(self):
        # The first session loads the member; subsequent department/catalog
        # lookups run the same SQLite catalog as the real write path.
        session_for_catalog = dep.get_async_db_session
        member_session = AsyncMock()
        member_session.exec.return_value = MagicMock()
        member_session.exec.return_value.first.return_value = SimpleNamespace(is_primary=0)

        @asynccontextmanager
        async def member_lookup():
            yield member_session

        for wanted in ([LEADER_ROLE], []):
            with (
                patch.object(dep, "get_async_db_session", side_effect=[member_lookup(), session_for_catalog()]),
                patch(
                    "bisheng.user.domain.models.user.UserDao.aget_user",
                    AsyncMock(return_value=SimpleNamespace(delete=0)),
                ),
                patch.object(UserRoleDao, "get_user_roles", return_value=[SimpleNamespace(role_id=LEADER_ROLE)]),
                patch.object(UserRoleDao, "delete_user_roles") as delete,
                patch.object(UserRoleDao, "add_user_roles") as add,
            ):
                apply = dep.DepartmentService.aapply_member_edit(
                    self.dept.dept_id, 33, DepartmentMemberEditApply(context_role_ids=wanted), self.user
                )
                if wanted:
                    with self.assertRaises(DepartmentInvalidRolesError):
                        await apply
                else:
                    await apply
                delete.assert_not_called()
                add.assert_not_called()

    async def test_legacy_role_reset_preserves_hidden_role_and_rejects_new_grant(self):
        from bisheng.user.api import user as api

        self.stack.enter_context(patch.object(api.UserGroupDao, "get_user_admin_group", return_value=[]))
        self.stack.enter_context(
            patch(
                "bisheng.database.models.department.DepartmentDao.aget_user_admin_departments",
                AsyncMock(return_value=[self.dept]),
            )
        )
        self.stack.enter_context(patch("bisheng.permission.application.is_tenant_admin", AsyncMock(return_value=False)))
        self.stack.enter_context(
            patch.object(
                RoleService,
                "list_roles",
                AsyncMock(
                    return_value={"data": [SimpleNamespace(id=DEPARTMENT_ROLE), SimpleNamespace(id=LEADER_ROLE)]}
                ),
            )
        )
        self.stack.enter_context(patch.object(api, "update_user_role_hook"))
        self.stack.enter_context(patch.object(api.LegacyRBACSyncService, "sync_user_role_change", AsyncMock()))
        with (
            patch.object(UserRoleDao, "get_user_roles", return_value=[SimpleNamespace(role_id=LEADER_ROLE)]),
            patch.object(UserRoleDao, "delete_user_roles") as delete,
            patch.object(UserRoleDao, "add_user_roles") as add,
        ):
            await api.user_addrole(
                request=MagicMock(), user_role=UserRoleCreate(user_id=33, role_id=[]), login_user=self.user
            )
            delete.assert_not_called()
            add.assert_not_called()
        with patch.object(UserRoleDao, "get_user_roles", return_value=[]), self.assertRaises(HTTPException):
            await api.user_addrole(
                request=MagicMock(), user_role=UserRoleCreate(user_id=33, role_id=[LEADER_ROLE]), login_user=self.user
            )

    async def test_sso_defaults_do_not_create_privileged_grants(self):
        from bisheng.sso_sync.domain.services import login_sync_service as sso

        with (
            patch.object(sso.UserRoleDao, "aget_user_roles", AsyncMock(return_value=[])),
            patch.object(
                sso.DepartmentDao,
                "aget_by_ids",
                AsyncMock(return_value=[SimpleNamespace(default_role_ids=[DEPARTMENT_ROLE, LEADER_ROLE])]),
            ),
            patch.object(sso.UserRoleDao, "add_user_roles") as add,
            patch.object(sso.LegacyRBACSyncService, "sync_user_role_change", AsyncMock()),
        ):
            await sso.LoginSyncService._replace_department_scoped_roles(33, revoke_dept_ids=[], apply_dept_ids=[10])
            add.assert_called_once_with(33, [DEPARTMENT_ROLE])

    async def test_sso_retains_normal_role_regranted_by_new_department(self):
        from bisheng.sso_sync.domain.services import login_sync_service as sso

        with (
            patch.object(
                sso.UserRoleDao, "aget_user_roles", AsyncMock(return_value=[SimpleNamespace(role_id=DEPARTMENT_ROLE)])
            ),
            patch.object(
                sso.RoleDao,
                "aget_role_by_ids",
                AsyncMock(return_value=[SimpleNamespace(id=DEPARTMENT_ROLE, department_id=10)]),
            ),
            patch.object(
                sso.DepartmentDao,
                "aget_by_ids",
                AsyncMock(return_value=[SimpleNamespace(default_role_ids=[DEPARTMENT_ROLE, LEADER_ROLE])]),
            ),
            patch.object(sso.UserRoleDao, "delete_user_roles") as remove,
            patch.object(sso.UserRoleDao, "add_user_roles") as add,
        ):
            await sso.LoginSyncService._replace_department_scoped_roles(33, revoke_dept_ids=[10], apply_dept_ids=[11])
            add.assert_not_called()
            remove.assert_not_called()

    async def test_numeric_knowledge_goal_readonly(self):
        data = LedgerInput(kind="goal", year=2026, indicator="knowledge", target=20, name="清单", unit="个")
        with patch("bisheng.company_board.domain.services.boards.require_access", AsyncMock()):
            for key in (None, "old-record"):
                with self.assertRaises(BoardLedgerInvalidError):
                    await record_entry(self.user, data, key, 1 if key else 0)
