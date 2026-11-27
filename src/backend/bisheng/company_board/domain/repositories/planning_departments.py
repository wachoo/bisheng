from collections import defaultdict
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass

from sqlmodel import select

from bisheng.common.errcode.company_board import BoardLedgerInvalidError
from bisheng.core.database import get_async_db_session
from bisheng.database.models.department import Department

PLANNING_COMPANY = "葛洲坝供应链公司"


@dataclass
class BoardDepartments:
    options: list[dict]
    by_id: dict[int, int]

    def resolve(self, raw_id: int | None) -> int | None:
        return self.by_id.get(raw_id)


_request_departments: ContextVar[dict[int, BoardDepartments] | None] = ContextVar("board_departments", default=None)


@contextmanager
def department_scope():
    token = _request_departments.set({})
    try:
        yield
    finally:
        _request_departments.reset(token)


async def board_departments(db, tenant) -> BoardDepartments:
    cache = _request_departments.get()
    if cache is not None and tenant in cache:
        return cache[tenant]
    rows = (await db.exec(select(Department.id, Department.name, Department.parent_id).where(
        Department.tenant_id == tenant, Department.is_deleted == 0, Department.status == "active"
    ).order_by(Department.sort_order, Department.id))).all()
    roots = [ident for ident, name, _ in rows if name == PLANNING_COMPANY]
    result = BoardDepartments([], {})
    if len(roots) == 1:
        root = roots[0]
        children = defaultdict(list)
        for ident, name, parent in rows:
            children[parent].append(ident)
            if parent == root and ident != root:
                result.options.append({"id": ident, "name": name})
        for option in result.options:
            top = option["id"]
            pending = [top]
            while pending:
                ident = pending.pop()
                if ident != root and ident not in result.by_id:
                    result.by_id[ident] = top
                    pending.extend(children[ident])
    if cache is not None:
        cache[tenant] = result
    return result


async def load_board_departments(tenant) -> BoardDepartments:
    cache = _request_departments.get()
    if cache is not None and tenant in cache:
        return cache[tenant]
    async with get_async_db_session() as db:
        return await board_departments(db, tenant)


async def validate_plan_departments(db, tenant, ids):
    if ids:
        departments = await board_departments(db, tenant)
        if any(departments.resolve(ident) != ident for ident in ids):
            raise BoardLedgerInvalidError(msg=f"请选择{PLANNING_COMPANY}的有效直属部门")
