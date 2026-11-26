from sqlalchemy import and_, case, func
from sqlmodel import select

from bisheng.company_board.domain.models.feedback import BoardRating
from bisheng.company_board.domain.models.ledger import BoardLedger
from bisheng.company_board.domain.models.runtime_event import BoardRuntimeEvent as Run
from bisheng.company_board.domain.repositories.activity_trends import beijing_day
from bisheng.core.database import get_async_db_session


async def scene_inputs(tenant, start, end):
    """Read daily employee totals and historical commissioning records, without user content."""
    latest = (
        select(BoardLedger.id, func.max(BoardLedger.revision).label("rev"))
        .where(BoardLedger.tenant_id == tenant, BoardLedger.kind.in_(["scene", "release", "topic"]))
        .group_by(BoardLedger.id)
        .subquery()
    )
    catalog = (
        select(BoardLedger)
        .join(latest, and_(latest.c.id == BoardLedger.id, latest.c.rev == BoardLedger.revision))
        .where(BoardLedger.tenant_id == tenant)
    )
    rating = (
        select(BoardRating.rating)
        .where(
            BoardRating.tenant_id == tenant,
            BoardRating.message_id == Run.terminal_message_id,
            BoardRating.user_id == Run.user_id,
            BoardRating.rated_at < end,
        )
        .order_by(BoardRating.rated_at.desc(), BoardRating.id.desc())
        .limit(1)
        .correlate(Run)
        .scalar_subquery()
    )
    async with get_async_db_session() as session:
        entries = (await session.exec(catalog)).all()
        day = beijing_day(Run.occurred_at, session.get_bind().dialect.name)
        observations = (
            select(
                day,
                Run.asset_id,
                Run.status,
                func.count(Run.id),
                func.count(Run.active_seconds),
                func.sum(Run.active_seconds),
                func.count(Run.terminal_message_id),
                func.sum(case((rating == 2, 1), else_=0)),
            )
            .where(
                Run.tenant_id == tenant,
                Run.kind == "employee",
                Run.status.in_(["success", "failed"]),
                Run.occurred_at >= start,
                Run.occurred_at < end,
            )
            .group_by(day, Run.asset_id, Run.status)
        )
        return entries, (await session.exec(observations)).all()
