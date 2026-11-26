import json
from datetime import UTC, date, datetime
from decimal import Decimal

from sqlalchemy import and_, func, or_
from sqlalchemy.exc import IntegrityError
from sqlmodel import select

from bisheng.common.errcode.company_board import BoardLedgerConflictError, BoardLedgerInvalidError
from bisheng.company_board.domain.models.ledger import BoardLedger
from bisheng.company_board.domain.models.supplement import BoardSupplement as Row
from bisheng.company_board.domain.repositories.asset_projection import project_asset_rows
from bisheng.company_board.domain.schemas.supplement import PARENTS
from bisheng.core.database import get_async_db_session
from bisheng.database.models.department import Department


def public(row):
    return {
        "id": row.id,
        "year": row.year,
        "kind": row.kind,
        "revision": row.revision,
        "name": row.name,
        "parent_id": row.parent_id,
        "date": row.business_date,
        "fields": json.loads(row.payload),
    }


async def list_supplements(tenant, cutoff, kinds=None):
    latest = select(Row.id, func.max(Row.revision).label("revision")).where(Row.tenant_id == tenant)
    if kinds is not None:
        included = set(kinds)
        if included & {"case", "scene-asset", "asset-profile"}:
            included.add("asset-binding")
        latest = latest.where(Row.kind.in_(included))
    else:
        latest = latest.where(Row.kind.notin_(("research-report", "research-subject", "publication-watch", "publication-legacy")))
    if cutoff is not None:
        # The annual contract plan includes instalments due later in the reporting year.
        # Other records only take effect on their business date.
        latest = latest.where(
            or_(
                Row.business_date <= cutoff,
                and_(Row.kind == "receivable", Row.business_date <= date(cutoff.year, 12, 31)),
            )
        )
    latest = latest.group_by(Row.id).subquery()
    statement = (
        select(Row)
        .join(latest, and_(latest.c.id == Row.id, latest.c.revision == Row.revision))
        .where(Row.tenant_id == tenant)
    )
    async with get_async_db_session() as db:
        result = (await db.exec(statement.order_by(Row.business_date, Row.id))).all()
    records = [public(r) for r in result if r.kind != "asset-binding"]
    records = [r for r in records if r["kind"] not in {"scene-team", "recognition"} or not r["fields"].get("_removed")]
    bindings = [r for r in result if r.kind == "asset-binding"]
    if bindings:
        return await project_asset_rows(tenant, cutoff, kinds, records, bindings)
    return records


async def allocated_receipts(db, tenant: int, parent_id: str, except_id: str | None = None) -> Decimal:
    statement = select(Row).where(Row.tenant_id == tenant, Row.kind == "receipt", Row.parent_id == parent_id)
    if except_id:
        statement = statement.where(Row.id != except_id)
    rows = (await db.exec(statement.order_by(Row.id, Row.revision.desc()).with_for_update())).all()
    latest = {}
    for row in rows:
        latest.setdefault(row.id, row)
    return sum((Decimal(json.loads(row.payload)["amount"]) for row in latest.values()), Decimal(0))


async def save_supplement(tenant, user_id, data, asset_ids):
    async with get_async_db_session() as db:
        ident = str(data.id)
        if data.kind == "receipt":
            # Lock the stable first revision before either invoices or payments are edited.
            await db.exec(
                select(Row.id)
                .where(Row.tenant_id == tenant, Row.id == data.parent_id, Row.revision == 1)
                .with_for_update()
            )
        elif data.kind == "receivable" and data.revision:
            await db.exec(
                select(Row.id).where(Row.tenant_id == tenant, Row.id == ident, Row.revision == 1).with_for_update()
            )
        current = (
            await db.exec(
                select(Row)
                .where(Row.tenant_id == tenant, Row.id == ident)
                .order_by(Row.revision.desc())
                .limit(1)
                .with_for_update()
            )
        ).first()
        if data.revision != (current.revision if current else 0):
            raise BoardLedgerConflictError()
        if current and (current.kind != data.kind or current.parent_id != data.parent_id or current.year != data.year):
            raise BoardLedgerInvalidError(msg="已有记录的年度、类型和所属对象不可变更")
        parent = PARENTS.get(data.kind)
        if parent == "asset":
            if data.parent_id not in asset_ids:
                raise BoardLedgerInvalidError(msg="无效资产")
        elif parent:
            model = BoardLedger if parent in {"scene", "topic", "collection"} else Row
            query = select(model).where(model.tenant_id == tenant, model.kind == parent, model.id == data.parent_id)
            if model is BoardLedger:
                query = query.where(model.year == data.year)
            found = (await db.exec(query.order_by(model.revision.desc()).limit(1).with_for_update())).first()
            if not found:
                raise BoardLedgerInvalidError(msg="未找到可关联的所属记录")
            if parent == "project" and data.date < found.business_date:
                raise BoardLedgerInvalidError(msg="业务日期不能早于项目开始日期")
            if data.kind == "receipt":
                if await allocated_receipts(db, tenant, found.id, ident) + Decimal(data.fields["amount"]) > Decimal(
                    json.loads(found.payload)["amount"]
                ):
                    raise BoardLedgerInvalidError(msg="累计到账不能超过对应合同节点的计划金额")
        if (
            data.kind == "receivable"
            and current
            and await allocated_receipts(db, tenant, ident) > Decimal(data.fields["amount"])
        ):
            raise BoardLedgerInvalidError(msg="计划金额不能低于该节点的累计到账")
        if data.kind == "case":
            scene = (
                await db.exec(
                    select(BoardLedger)
                    .where(
                        BoardLedger.tenant_id == tenant,
                        BoardLedger.kind == "scene",
                        BoardLedger.id == data.fields["scene"],
                    )
                    .order_by(BoardLedger.revision.desc())
                    .limit(1)
                )
            ).first()
            if not scene or scene.year != data.year or scene.parent_id != data.parent_id:
                raise BoardLedgerInvalidError(msg="案例须使用所属专题的场景")
        if data.kind == "scene-team":
            department = (
                await db.exec(
                    select(Department.id).where(
                        Department.tenant_id == tenant,
                        Department.id == int(data.fields["department"]),
                        Department.is_deleted == 0,
                        Department.status == "active",
                    )
                )
            ).first()
            if department is None:
                raise BoardLedgerInvalidError(msg="支持单位不存在或不属于当前公司")
        if data.kind in {"scene-asset", "case"}:
            referenced = [
                x.strip() for x in data.fields.get("assets", data.fields.get("asset", "")).split(",") if x.strip()
            ]
            if any(x not in asset_ids for x in referenced):
                raise BoardLedgerInvalidError(msg="关联资产不属于当前目录")
        row = Row(
            tenant_id=tenant,
            id=ident,
            revision=data.revision + 1,
            kind=data.kind,
            year=data.year,
            name=data.name,
            parent_id=data.parent_id,
            business_date=data.date,
            payload=json.dumps(data.fields, ensure_ascii=False),
            operator_id=user_id,
            recorded_at=datetime.now(UTC).replace(tzinfo=None),
        )
        db.add(row)
        try:
            await db.commit()
        except IntegrityError as exc:
            await db.rollback()
            raise BoardLedgerConflictError() from exc
        await db.refresh(row)
        return public(row)
