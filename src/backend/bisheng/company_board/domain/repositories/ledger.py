from datetime import date, datetime, time, timedelta
from uuid import NAMESPACE_URL, uuid5

from sqlalchemy import and_, func
from sqlalchemy.exc import IntegrityError
from sqlmodel import select

from bisheng.common.errcode.company_board import BoardLedgerConflictError, BoardLedgerInvalidError
from bisheng.common.errcode.http_error import NotFoundError
from bisheng.company_board.domain.models.ledger import BoardLedger
from bisheng.company_board.domain.models.supplement import BoardSupplement
from bisheng.company_board.domain.schemas.ledger import LedgerInput
from bisheng.core.database import get_async_db_session
from bisheng.database.models.app import App
from bisheng.database.models.audit_log import AuditLog
from bisheng.database.models.department import Department


def public_row(row: BoardLedger) -> dict:
    return row.model_dump(mode="python", exclude={"operator_id", "tenant_id", "recorded_at"})


async def list_ledger(tenant_id: int, year: int, as_of: date | None = None) -> list[dict]:
    latest = select(BoardLedger.id, func.max(BoardLedger.revision).label("version")).where(
        BoardLedger.tenant_id == tenant_id, BoardLedger.year == year
    )
    if as_of is not None:
        # A scene's date is its actual commissioning date. Keep planned scenes
        # visible, including those that have not commissioned yet.
        latest = latest.where(
            (BoardLedger.kind.in_(["scene", "release", "collection"]))
            | BoardLedger.effective_date.is_(None)
            | (BoardLedger.effective_date <= as_of)
        )
    latest = latest.group_by(BoardLedger.id).subquery()
    query = (
        select(BoardLedger)
        .join(latest, and_(BoardLedger.id == latest.c.id, BoardLedger.revision == latest.c.version))
        .where(BoardLedger.tenant_id == tenant_id)
        .order_by(BoardLedger.kind, BoardLedger.name, BoardLedger.id)
    )
    async with get_async_db_session() as session:
        rows = [public_row(row) for row in (await session.exec(query)).all()]
        cutoff = as_of or date(year, 12, 31)
        history = await _app_audit_history(session, tenant_id, cutoff)
        if not history:
            return rows
        firsts = await _ledger_releases(session, tenant_id, cutoff)
        names_needed = {}
        period_releases = {r["asset_key"]: r for r in rows if r["kind"] == "release"}
        for key, day in history.items():
            if key in firsts and firsts[key][1] <= day:
                continue
            row = period_releases.get(key)
            if row:
                # If the audit proved an earlier year, a later registration
                # is not a second commissioning of this digital employee.
                row["effective_date"] = day if year == day.year else None
                row["department_id"] = None
            elif day.year == year:
                names_needed[key.split(":", 1)[1]] = day
        if names_needed:
            names = dict(
                (
                    await session.exec(
                        select(App.id, App.name).where(App.tenant_id == tenant_id, App.id.in_(list(names_needed)))
                    )
                ).all()
            )
            for app_id, day in sorted(names_needed.items()):
                key = f"app:{app_id}"
                rows.append(
                    public_row(
                        BoardLedger(
                            tenant_id=tenant_id,
                            id=str(uuid5(NAMESPACE_URL, f"bisheng:board:{tenant_id}:observed:{key}")),
                            revision=1,
                            kind="release",
                            year=day.year,
                            name=names.get(app_id) or key,
                            asset_key=key,
                            effective_date=day,
                            operator_id=0,
                        )
                    )
                )
        return rows


async def _app_audit_history(session, tenant_id, cutoff):
    # The audit format predates board tracking. The ID is inside the structured
    # metadata, including for applications subsequently stopped or removed.
    end = datetime.combine(cutoff + timedelta(days=1), time.min)
    filters = (AuditLog.tenant_id == tenant_id, AuditLog.action == "app.release.online", AuditLog.create_time < end)
    dialect = session.get_bind().dialect.name
    result = {}
    if dialect in {"mysql", "sqlite"}:
        app_id = func.json_extract(AuditLog.audit_metadata, "$.app_id")
        if dialect == "mysql":
            app_id = func.json_unquote(app_id)
        # One row per app, even when releases generate a large audit history.
        grouped = select(app_id, func.min(AuditLog.create_time)).where(*filters).group_by(app_id)
        for ident, stamp in (await session.exec(grouped)).all():
            if isinstance(ident, str) and ident:
                result[f"app:{ident}"] = stamp.date()
    else:
        # Other supported engines use the portable text representation of JsonType.
        query = select(AuditLog.audit_metadata, AuditLog.create_time).where(*filters)
        for metadata, stamp in (await session.exec(query)).all():
            ident = metadata.get("app_id") if isinstance(metadata, dict) else None
            if isinstance(ident, str) and ident:
                key = f"app:{ident}"
                result[key] = min(result.get(key, stamp.date()), stamp.date())
    baselines = await session.exec(
        select(BoardSupplement.parent_id, BoardSupplement.business_date).where(
            BoardSupplement.tenant_id == tenant_id,
            BoardSupplement.kind == "publication-legacy",
        )
    )
    for key, day in baselines.all():
        if day and day <= cutoff:
            result[key] = day
        else:
            result.pop(key, None)
    return result


async def _ledger_releases(session, tenant_id, cutoff):
    latest = (
        select(BoardLedger.id, func.max(BoardLedger.revision).label("version"))
        .where(BoardLedger.tenant_id == tenant_id, BoardLedger.kind == "release")
        .group_by(BoardLedger.id)
        .subquery()
    )
    query = (
        select(BoardLedger.asset_key, BoardLedger.department_id, BoardLedger.effective_date)
        .join(latest, and_(BoardLedger.id == latest.c.id, BoardLedger.revision == latest.c.version))
        .where(BoardLedger.tenant_id == tenant_id, BoardLedger.effective_date <= cutoff)
        .order_by(BoardLedger.effective_date, BoardLedger.id)
    )
    result = {}
    for asset, department, day in (await session.exec(query)).all():
        result.setdefault(asset, (department, day))
    return result


async def release_info(tenant_id: int, cutoff: date) -> dict:
    """The earliest confirmed release and the department known at that time."""
    async with get_async_db_session() as session:
        result = await _ledger_releases(session, tenant_id, cutoff)
        for key, day in (await _app_audit_history(session, tenant_id, cutoff)).items():
            if key not in result or day < result[key][1]:
                result[key] = (None, day)
        return result


async def release_departments(tenant_id: int, cutoff: date) -> dict[str, int]:
    return {asset: dept for asset, (dept, _) in (await release_info(tenant_id, cutoff)).items() if dept is not None}


def new_id(tenant_id: int, data: LedgerInput) -> str:
    # An annual indicator has one target. Topics and scenes have stable
    # creation identities so a retried POST cannot silently create a duplicate.
    if data.kind == "release":
        return str(uuid5(NAMESPACE_URL, f"bisheng:board:{tenant_id}:release:{data.asset_key}"))
    subject = data.indicator if data.kind == "goal" else data.name
    return str(uuid5(NAMESPACE_URL, f"bisheng:board:{tenant_id}:{data.year}:{data.kind}:{data.parent_id}:{subject}"))


async def save_ledger(
    tenant_id: int, user_id: int, data: LedgerInput, entry_id: str | None = None, expected: int = 0
) -> dict:
    ident = entry_id or new_id(tenant_id, data)
    async with get_async_db_session() as session:
        fields = data.model_dump(exclude={"revision"})
        if data.department_id is not None:
            department = await session.exec(
                select(Department.id).where(
                    Department.tenant_id == tenant_id,
                    Department.id == data.department_id,
                    Department.is_deleted == 0,
                    Department.status == "active",
                )
            )
            if department.first() is None:
                raise BoardLedgerInvalidError(msg="部门不在当前租户的有效目录内")
        if data.parent_id:
            parent_kind = "scene" if data.kind == "release" else "topic"
            topic = await session.exec(
                select(BoardLedger.id)
                .where(
                    BoardLedger.tenant_id == tenant_id,
                    BoardLedger.id == data.parent_id,
                    BoardLedger.kind == parent_kind,
                    BoardLedger.year == data.year,
                )
                .limit(1)
            )
            if topic.first() is None:
                raise BoardLedgerInvalidError(msg="上级台账不存在或类型、年度不一致")
        latest = (
            await session.exec(
                select(BoardLedger)
                .where(BoardLedger.tenant_id == tenant_id, BoardLedger.id == ident)
                .order_by(BoardLedger.revision.desc())
                .limit(1)
            )
        ).first()
        if entry_id and latest is None:
            raise NotFoundError.http_exception()
        if latest and (latest.kind != data.kind or latest.year != data.year or latest.indicator != data.indicator):
            raise BoardLedgerInvalidError(msg="台账类型、年度和指标不可变更")
        if latest and data.kind == "release" and latest.asset_key != data.asset_key:
            raise BoardLedgerInvalidError(msg="已登记的资产不可替换")
        if latest and latest.revision != expected:
            raise BoardLedgerConflictError()
        row = BoardLedger(id=ident, tenant_id=tenant_id, revision=expected + 1, operator_id=user_id, **fields)
        session.add(row)
        try:
            await session.commit()
        except IntegrityError as exc:
            await session.rollback()
            # The composite primary key serializes concurrent revisions and POST retries.
            raise BoardLedgerConflictError() from exc
        await session.refresh(row)
        return public_row(row)
