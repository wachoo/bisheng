import json
from datetime import UTC, date, datetime
from uuid import NAMESPACE_URL, uuid5

from sqlalchemy import and_, func
from sqlalchemy.exc import IntegrityError
from sqlmodel import select

from bisheng.common.errcode.company_board import BoardLedgerConflictError
from bisheng.company_board.domain.models.supplement import BoardSupplement as Row
from bisheng.company_board.domain.schemas.research_report import ResearchReportInput
from bisheng.core.database import get_async_db_session

REPORT_KIND = "research-report"
SUBJECT_KIND = "research-subject"


async def _subjects(db, tenant, header):
    rows = (
        await db.exec(
            select(Row)
            .where(
                Row.tenant_id == tenant,
                Row.kind == SUBJECT_KIND,
                Row.parent_id == header.id,
                Row.revision == header.revision,
            )
            .order_by(Row.id)
        )
    ).all()
    return sorted((json.loads(r.payload) for r in rows), key=lambda r: (r["start"], r["name"], r["id"]))


async def latest_report(tenant: int, cutoff: date):
    latest = (
        select(Row.id, func.max(Row.revision).label("revision"))
        .where(Row.tenant_id == tenant, Row.kind == REPORT_KIND, Row.year == cutoff.year, Row.business_date <= cutoff)
        .group_by(Row.id)
        .subquery()
    )
    async with get_async_db_session() as db:
        rows = (
            await db.exec(
                select(Row)
                .join(latest, and_(latest.c.id == Row.id, latest.c.revision == Row.revision))
                .where(Row.tenant_id == tenant)
                .order_by(Row.business_date)
            )
        ).all()
        history = []
        for row in rows:
            metrics = json.loads(row.payload)
            history.append(
                {
                    "month": row.business_date.month,
                    "equivalent_days": metrics.get("equivalent_days"),
                    "equivalent_value": metrics.get("equivalent_value"),
                }
            )
        if rows:
            header = rows[-1]
        else:
            header = (
                await db.exec(
                    select(Row)
                    .where(Row.tenant_id == tenant, Row.kind == REPORT_KIND, Row.year < cutoff.year)
                    .order_by(Row.business_date.desc(), Row.revision.desc())
                    .limit(1)
                )
            ).first()
        if header is None:
            return None
        return (
            header.business_date,
            header.revision,
            json.loads(header.payload),
            await _subjects(db, tenant, header),
            history,
        )


async def save_report(tenant: int, operator: int, report: ResearchReportInput):
    first_day = date(report.year, report.month, 1)
    report_uid = uuid5(NAMESPACE_URL, f"bisheng/company-boards/research/{tenant}/{first_day.isoformat()}")
    report_id = str(report_uid)
    metrics = report.metrics.model_dump(mode="json")
    subjects = [s.model_dump(mode="json") for s in report.subjects]
    revision = report.revision + 1
    async with get_async_db_session() as db:
        previous = (
            await db.exec(
                select(Row)
                .where(Row.tenant_id == tenant, Row.kind == REPORT_KIND, Row.id == report_id)
                .order_by(Row.revision.desc())
                .limit(1)
                .with_for_update()
            )
        ).first()
        if (previous.revision if previous else 0) != report.revision:
            if previous and previous.revision == revision and json.loads(previous.payload) == metrics:
                saved = await _subjects(db, tenant, previous)
                if sorted(saved, key=lambda r: r["id"]) == sorted(subjects, key=lambda r: r["id"]):
                    return
            raise BoardLedgerConflictError()
        common = {
            "tenant_id": tenant,
            "revision": revision,
            "year": report.year,
            "business_date": first_day,
            "operator_id": operator,
            "recorded_at": datetime.now(UTC).replace(tzinfo=None),
        }
        db.add(Row(**common, id=report_id, kind=REPORT_KIND, name="科研与经营", payload=json.dumps(metrics)))
        for subject in subjects:
            db.add(
                Row(
                    **common,
                    id=str(uuid5(report_uid, subject["id"])),
                    kind=SUBJECT_KIND,
                    name=subject["name"],
                    parent_id=report_id,
                    payload=json.dumps(subject, ensure_ascii=False),
                )
            )
        try:
            await db.commit()
        except IntegrityError as exc:
            await db.rollback()
            raise BoardLedgerConflictError() from exc
