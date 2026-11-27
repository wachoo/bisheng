from datetime import datetime, timedelta

from sqlalchemy import case, func, or_
from sqlmodel import select

from bisheng.company_board.domain.models.runtime_event import BoardRuntimeEvent as Event
from bisheng.company_board.domain.repositories.planning_departments import load_board_departments
from bisheng.core.database import get_async_db_session


async def asset_activity(tenant, asset, start, end, department, details, status, search, page):
    prefix, ident = asset.split(":", 1)
    kind = "employee" if prefix == "assistant" else prefix
    scope = [Event.tenant_id == tenant, Event.kind == kind, Event.asset_id == ident]
    if department:
        departments = await load_board_departments(tenant)
        # Old bookmarks can still carry "unassigned" or a leaf ID. Neither selects a department.
        direct_id = int(department) if department.isdecimal() else None
        raw_ids = [raw for raw, direct in departments.by_id.items() if direct == direct_id]
        scope.append(Event.department_id.in_(raw_ids))
    base = [*scope, Event.occurred_at >= start, Event.occurred_at < end]
    # Use Beijing calendar days up to 31 days, months for the annual view, weeks for 90 days.
    boundaries = []
    day = start
    while day < end:
        if (end - start).days > 100:
            following = (day + timedelta(hours=8)).replace(day=1) + timedelta(days=32)
            following = following.replace(day=1) - timedelta(hours=8)
        else:
            following = day + timedelta(days=7 if (end - start).days > 31 else 1)
        boundaries.append((following, (day + timedelta(hours=8)).date().isoformat()))
        day = following
    bucket = case(*[(Event.occurred_at < stop, label) for stop, label in boundaries]) if boundaries else None
    bins = {label: {"date": label, "success": 0, "failed": 0, "entered": 0} for _, label in boundaries}
    async with get_async_db_session() as db:
        known = (await db.exec(select(func.count(Event.id)).where(*scope, Event.occurred_at < end))).one() > 0
        if bucket is not None:
            for label, state, number in (
                await db.exec(
                    select(bucket, Event.status, func.count(Event.id)).where(*base).group_by(bucket, Event.status)
                )
            ).all():
                if state in {"entered", "success", "failed"}:
                    bins[label][state] = number
        last = (await db.exec(select(func.max(Event.occurred_at)).where(*base))).one()
        result = {
            "series": list(bins.values()),
            "known": known,
            "last": last,
            "rows": [],
            "latest": None,
            "total": None,
        }
        if details and kind == "employee":

            def public(row):
                return {"id": row.run_id, "start": row.started_at, "end": row.occurred_at, "status": row.status}

            ordered = select(Event).where(*base).order_by(Event.occurred_at.desc(), Event.id.desc())
            latest = (await db.exec(ordered.limit(1))).first()
            result["latest"] = public(latest) if latest else None
            filters = []
            if status:
                filters.append(Event.status == status)
            if search:
                by_id = Event.run_id.contains(search, autoescape=True)
                try:
                    date = datetime.fromisoformat(search).replace(tzinfo=None) - timedelta(hours=8)
                except ValueError:
                    filters.append(by_id)
                else:
                    span = timedelta(days=1) if len(search) == 10 else timedelta(minutes=1)
                    filters.append(
                        or_(
                            by_id,
                            Event.occurred_at.between(date, date + span),
                            Event.started_at.between(date, date + span),
                        )
                    )
            result["total"] = (await db.exec(select(func.count(Event.id)).where(*base, *filters))).one()
            rows = (await db.exec(ordered.where(*filters).offset((page - 1) * 8).limit(8))).all()
            result["rows"] = [public(row) for row in rows]
    return result
