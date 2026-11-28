import unittest

from sqlalchemy.ext.asyncio import create_async_engine
from sqlmodel.ext.asyncio.session import AsyncSession

from bisheng.company_board.domain.repositories.planning_departments import (
    PLANNING_COMPANY, board_departments, department_scope,
)
from bisheng.database.models.department import Department


class BoardDepartmentsTest(unittest.IsolatedAsyncioTestCase):
    async def test_only_direct_units_are_exposed_and_descendants_share_their_ancestor(self):
        engine = create_async_engine("sqlite+aiosqlite://")
        self.addAsyncCleanup(engine.dispose)
        async with engine.begin() as conn:
            await conn.run_sync(Department.__table__.create)
        async with AsyncSession(engine) as db:
            for ident, name, parent, tenant in [
                (1, PLANNING_COMPANY, None, 1), (2, "采购", 1, 1), (3, "科室", 2, 1),
                (4, "班组", 3, 1), (5, "财务", 1, 1), (6, "临时访客", None, 1),
                (7, "已撤销部门", 1, 1), (8, "撤销部门下属", 7, 1),
                (9, PLANNING_COMPANY, None, 2), (10, "其他租户", 9, 2),
            ]:
                db.add(Department(id=ident, dept_id=str(ident), name=name, tenant_id=tenant,
                                  parent_id=parent, is_deleted=int(ident == 7)))
            await db.commit()
            with department_scope():
                scope = await board_departments(db, 1)
                self.assertEqual(scope.options, [{"id": 2, "name": "采购"}, {"id": 5, "name": "财务"}])
                self.assertEqual(scope.by_id, {2: 2, 3: 2, 4: 2, 5: 5})
                self.assertIs(scope, await board_departments(db, 1))
                self.assertEqual((await board_departments(db, 2)).by_id, {10: 10})
                self.assertEqual((await board_departments(db, 3)).options, [])
            db.add(Department(id=11, dept_id="duplicate", tenant_id=1, name=PLANNING_COMPANY))
            await db.commit()
            with department_scope():
                self.assertEqual((await board_departments(db, 1)).by_id, {})
