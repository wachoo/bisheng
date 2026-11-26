"""Aggregate tenant-scoped Web facts without exposing users, messages or request IDs."""

from sqlalchemy import DateTime, Integer, and_, case, distinct, func, literal, or_, text, union_all
from sqlmodel import select

from bisheng.company_board.domain.models.feedback import BoardRating
from bisheng.company_board.domain.models.runtime_event import BoardRuntimeEvent
from bisheng.core.database import get_async_db_session


def beijing_day(occurred_at, dialect):
    if dialect == "sqlite":
        return func.date(occurred_at, "+8 hours")
    elif dialect in {"mysql", "mariadb"}:
        return func.date(func.convert_tz(occurred_at, "+00:00", "+08:00"))
    else:
        return func.date(occurred_at + text("INTERVAL '8 hours'"))


def trend_query(tenant_id, periods, dialect):
    # Each period has its own cutoff for reclassified files and changed feedback.
    period = union_all(
        *(
            select(
                literal(key, Integer).label("period"),
                literal(start, DateTime).label("start_at"),
                literal(end, DateTime).label("cutoff"),
            )
            for key, start, end in periods
        )
    ).subquery()
    ev = BoardRuntimeEvent.__table__.alias("ev")
    member = BoardRuntimeEvent.__table__.alias("member")
    ratings = BoardRating.__table__.alias("rating")
    last = BoardRating.__table__.alias("last_rating")
    m, e, p = member.c, ev.c, period.c

    latest_rating = (
        select(ratings.c.id)
        .where(
            ratings.c.tenant_id == tenant_id,
            ratings.c.message_id == e.terminal_message_id,
            ratings.c.user_id == e.user_id,
            ratings.c.rated_at < p.cutoff,
        )
        .order_by(ratings.c.rated_at.desc(), ratings.c.id.desc())
        .limit(1)
        .correlate(period, ev)
        .scalar_subquery()
    )
    belongs = (
        select(m.id)
        .where(m.tenant_id == tenant_id, m.kind == "version_member", m.member_file_id == e.id, m.occurred_at < p.cutoff)
        .correlate(period, ev)
        .exists()
    )
    eligible = e.status.in_(["success", "failed"])
    timed = and_(eligible, e.kind == "employee")
    replied = and_(timed, e.terminal_message_id.is_not(None))
    metered = and_(e.kind == "model", e.status == "metered", e.input_tokens.is_not(None), e.output_tokens.is_not(None))
    local_day = beijing_day(e.occurred_at, dialect)
    # Daily output subtotals allow valuation against the rate effective on the delivery day.
    delivered = e.kind.in_(["file", "version"])
    delivered_day = case((delivered, local_day))
    output_category = case((delivered, e.output_category))
    query = (
        select(
            p.period,
            e.kind,
            e.asset_id,
            e.department_id,
            delivered_day.label("output_day"),
            output_category.label("output_category"),
            func.sum(case((e.status == "success", 1), else_=0)).label("successful"),
            func.sum(case((e.status == "failed", 1), else_=0)).label("failed"),
            func.sum(case((e.status == "cancelled", 1), else_=0)).label("cancelled"),
            func.sum(case((e.status == "entered", 1), else_=0)).label("entered"),
            func.count(case((timed, e.active_seconds))).label("timed"),
            func.sum(case((timed, e.active_seconds), else_=0)).label("active_seconds"),
            func.count(case((e.status == "success", e.terminal_message_id))).label("linked"),
            func.count(distinct(case((replied, e.run_id)))).label("rounds"),
            func.sum(case((metered, e.input_tokens + e.output_tokens))).label("tokens"),
            func.sum(case((and_(e.status == "success", last.c.rating == 2), 1), else_=0)).label("negative"),
        )
        .select_from(
            period.join(ev, and_(e.tenant_id == tenant_id, e.occurred_at >= p.start_at, e.occurred_at < p.cutoff))
        )
        .outerjoin(last, and_(e.kind == "employee", last.c.tenant_id == tenant_id, last.c.id == latest_rating))
        .where(
            e.kind.in_(["employee", "knowledge", "skill", "tool", "file", "version", "model"]),
            or_(e.kind != "file", ~belongs),
        )
        .group_by(p.period, e.kind, e.asset_id, e.department_id, delivered_day, output_category)
    )
    unknown = select(func.min(m.occurred_at)).where(
        m.tenant_id == tenant_id, m.kind == "version_member", m.member_file_id.is_(None)
    )
    return query, unknown


async def grouped_trends(tenant_id, periods):
    async with get_async_db_session() as session:
        query, unknown = trend_query(tenant_id, periods, session.get_bind().dialect.name)
        result = (await session.exec(query)).all()
        first_unknown = (await session.exec(unknown)).one()
    return [dict(row._mapping) for row in result], first_unknown
