from sqlalchemy import func
from sqlalchemy.orm import aliased
from sqlmodel import select

from bisheng.common.errcode.company_board import BoardLedgerInvalidError
from bisheng.database.models.department import Department

PLANNING_COMPANY = "葛洲坝供应链公司"


def direct_departments(tenant):
    company = aliased(Department)
    # Resolve the named company within this tenant. An absent or ambiguous
    # company must not open the picker to an unrelated organizational branch.
    root_id = (
        select(func.min(company.id))
        .where(company.tenant_id == tenant, company.name == PLANNING_COMPANY,
               company.is_deleted == 0, company.status == "active")
        .having(func.count(company.id) == 1)
        .scalar_subquery()
    )
    return select(Department.id, Department.name).where(
        Department.tenant_id == tenant,
        Department.parent_id == root_id,
        Department.is_deleted == 0,
        Department.status == "active",
    )


async def department_options(db, tenant, assigned):
    rows = (await db.exec(direct_departments(tenant).order_by(Department.sort_order, Department.id))).all()
    choices = [{"id": ident, "name": name} for ident, name in rows]
    previous = assigned - {ident for ident, _ in rows}
    historical = []
    if previous:
        saved = await db.exec(select(Department.id, Department.name).where(
            Department.tenant_id == tenant, Department.id.in_(previous)
        ))
        historical = [{"id": ident, "name": name} for ident, name in saved]
    return {"departments": choices, "historical_departments": historical}


async def validate_plan_departments(db, tenant, ids):
    if ids:
        matches = await db.exec(direct_departments(tenant).where(Department.id.in_(ids)))
        if {ident for ident, _ in matches} != ids:
            raise BoardLedgerInvalidError(msg=f"请选择{PLANNING_COMPANY}的有效直属部门")
