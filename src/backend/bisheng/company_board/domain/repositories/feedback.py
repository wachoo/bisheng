from datetime import UTC, datetime

from sqlalchemy import and_, case, func
from sqlalchemy.exc import IntegrityError
from sqlmodel import select

from bisheng.common.errcode.http_error import NotFoundError
from bisheng.company_board.domain.models.feedback import BoardIssueResolution, BoardRating
from bisheng.company_board.domain.models.runtime_event import BoardRuntimeEvent
from bisheng.core.database import get_async_db_session

Run = BoardRuntimeEvent


def utc_now():
    return datetime.now(UTC).replace(tzinfo=None)


def issue_rows(tenant_id, cutoff):
    # Only a negative rating by the owner of the final message creates an issue.
    # Subsequent feedback is retained independently of the issue's resolution.
    return (
        select(Run.run_id, Run.asset_id, func.min(BoardRating.rated_at).label("opened_at"))
        .select_from(Run)
        .join(
            BoardRating,
            and_(
                BoardRating.message_id == Run.terminal_message_id,
                BoardRating.tenant_id == Run.tenant_id,
                BoardRating.user_id == Run.user_id,
            ),
        )
        .where(
            Run.tenant_id == tenant_id,
            Run.kind == "employee",
            Run.status == "success",
            Run.occurred_at < cutoff,
            BoardRating.rating == 2,
            BoardRating.rated_at < cutoff,
        )
        .group_by(Run.run_id, Run.asset_id)
    )


async def feedback_snapshot(tenant_id, start, cutoff, details, offset, limit):
    issues = issue_rows(tenant_id, cutoff).subquery()
    resolution = BoardIssueResolution.__table__.c
    match = and_(
        resolution.tenant_id == tenant_id, resolution.run_id == issues.c.run_id, resolution.resolved_at < cutoff
    )
    listing = (
        select(issues.c.run_id, issues.c.asset_id, issues.c.opened_at, resolution.resolved_at, resolution.measure)
        .select_from(issues)
        .outerjoin(BoardIssueResolution.__table__, match)
        .where(issues.c.opened_at >= start)
    )
    summary = listing.subquery()
    async with get_async_db_session() as session:
        total, closed = (
            await session.exec(select(func.count(), func.count(summary.c.resolved_at)).select_from(summary))
        ).one()
        rows = []
        if details:
            ordered = (
                listing.order_by(
                    case((resolution.resolved_at.is_(None), 0), else_=1),
                    func.coalesce(resolution.resolved_at, issues.c.opened_at).desc(),
                    issues.c.run_id,
                )
                .offset(offset)
                .limit(limit)
            )
            for row in (await session.exec(ordered)).all():
                rows.append(dict(row._mapping))
    return {"pending": total - closed, "closed": closed, "total": total, "rows": rows}


async def resolve_issue(tenant_id, user_id, run_id, measure):
    now = utc_now()
    async with get_async_db_session() as session:
        issue = await session.exec(issue_rows(tenant_id, now).where(Run.run_id == run_id))
        if not issue.first():
            raise NotFoundError.http_exception()
        key = {"tenant_id": tenant_id, "run_id": run_id}
        if await session.get(BoardIssueResolution, key):
            return
        session.add(BoardIssueResolution(**key, operator_id=user_id, resolved_at=now, measure=measure))
        try:
            await session.commit()
        except IntegrityError:
            await session.rollback()
            if not await session.get(BoardIssueResolution, key):
                raise


async def satisfaction(tenant_id, start, cutoff):
    latest = (
        select(BoardRating.message_id, BoardRating.user_id, func.max(BoardRating.id).label("rating_id"))
        .where(BoardRating.tenant_id == tenant_id, BoardRating.rated_at < cutoff)
        .group_by(BoardRating.message_id, BoardRating.user_id)
        .subquery()
    )
    final_rating = BoardRating.__table__.alias("final_rating")
    stmt = (
        select(
            func.count(Run.id), func.count(Run.terminal_message_id), func.count(case((final_rating.c.rating == 2, 1)))
        )
        .select_from(Run)
        .outerjoin(latest, and_(latest.c.message_id == Run.terminal_message_id, latest.c.user_id == Run.user_id))
        .outerjoin(
            final_rating, and_(final_rating.c.tenant_id == Run.tenant_id, final_rating.c.id == latest.c.rating_id)
        )
        .where(
            Run.tenant_id == tenant_id,
            Run.kind == "employee",
            Run.status == "success",
            Run.occurred_at >= start,
            Run.occurred_at < cutoff,
        )
    )
    async with get_async_db_session() as session:
        total, linked, negative = (await session.exec(stmt)).one()
    return {
        "successful": total,
        "linked": linked,
        "negative": negative,
        "positive_rate": (total - negative) / total if total and linked == total else None,
    }
