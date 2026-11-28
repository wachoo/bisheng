import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException

from bisheng.common.dependencies.user_deps import UserPayload
from bisheng.common.errcode.role import RolePermissionDeniedError
from bisheng.company_board.domain.services.boards import board_access, require_access
from bisheng.role.domain.services.role_service import RoleService


class BoardAccessTest(unittest.IsolatedAsyncioTestCase):
    async def test_global_admin_can_open_both_pages(self):
        admin = UserPayload(user_id=1, user_role=[], is_global_super=True)
        self.assertTrue(all((await board_access(admin)).values()))

    async def test_monitor_only_is_independent_of_finance_and_issue_management(self):
        user = UserPayload(user_id=9, user_role=[20], tenant_id=2)
        records = [SimpleNamespace(third_id="company_monitorboard", role_id=20)]
        with (
            patch("bisheng.user.domain.models.user.UserDao.aget_user", AsyncMock(return_value=user)),
            patch("bisheng.user.domain.services.auth.UserRoleDao.aget_user_roles", AsyncMock(return_value=records)),
            patch("bisheng.user.domain.services.auth.RoleAccessDao.aget_role_access", AsyncMock(return_value=records)),
            patch(
                "bisheng.user.domain.services.auth.UserMenuAccessService.list_effective_menu_grants",
                AsyncMock(return_value=["company_board_feedback", "company_leadboard", "company_board_ledger"]),
            ),
        ):
            self.assertEqual(
                await board_access(user), {"monitor": True, "lead": False, "manage": False, "resolve": False}
            )
            with self.assertRaises(HTTPException):
                await require_access(user, "manage")
            with self.assertRaises(HTTPException):
                await require_access(user, "lead")

    async def test_department_role_cannot_grant_or_acquire_company_ledger_by_menu(self):
        user = UserPayload(user_id=9, user_role=[20], tenant_id=2)
        grants = [SimpleNamespace(third_id=key, role_id=20) for key in ("company_monitorboard", "company_board_ledger")]
        with (
            patch("bisheng.user.domain.models.user.UserDao.aget_user", AsyncMock(return_value=user)),
            patch("bisheng.user.domain.services.auth.UserRoleDao.aget_user_roles", AsyncMock(return_value=grants[:1])),
            patch("bisheng.user.domain.services.auth.RoleAccessDao.aget_role_access", AsyncMock(return_value=grants)),
            patch(
                "bisheng.user.domain.services.auth.RoleDao.aget_role_by_ids",
                AsyncMock(return_value=[SimpleNamespace(id=20, department_id=33)]),
            ),
            patch(
                "bisheng.user.domain.services.auth.UserMenuAccessService.list_effective_menu_grants",
                AsyncMock(return_value=[]),
            ),
            patch.object(RoleService, "_get_permission_level", AsyncMock(return_value="dept_admin")),
        ):
            self.assertFalse((await board_access(user))["manage"])
            with self.assertRaises(RolePermissionDeniedError):
                await RoleService._assert_company_menu_assignment(["company_board_ledger"], user)
