from sqlalchemy import func, or_, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import aliased
from sqlmodel import select

from bisheng.company_board.domain.models.runtime_event import BoardRuntimeEvent
from bisheng.core.context.tenant import strict_tenant_filter
from bisheng.core.database.manager import get_async_db_session
from bisheng.database.models.department import Department, UserDepartment


async def primary_department(user_id):
    with strict_tenant_filter():
        async with get_async_db_session() as session:
            stmt = (
                select(Department.id)
                .join(UserDepartment, UserDepartment.department_id == Department.id)
                .where(
                    UserDepartment.user_id == user_id,
                    UserDepartment.is_primary == 1,
                    Department.is_deleted == 0,
                )
                .limit(2)
            )
            ids = (await session.exec(stmt)).all()
            return ids[0] if len(ids) == 1 else None


async def insert_events(events):
    """Replay the same immutable business facts without replacing their first timestamps."""
    ids = [event.id for event in events]
    with strict_tenant_filter():
        for attempt in range(2):
            async with get_async_db_session() as session:
                previously_seen = (
                    await session.exec(select(BoardRuntimeEvent).where(BoardRuntimeEvent.id.in_(ids)))
                ).all()
                known = {existing.id: existing for existing in previously_seen}
                for fact in events:
                    existing = known.get(fact.id)
                    if not existing or fact.kind not in {"file", "version", "version_member"}:
                        continue
                    match = update(BoardRuntimeEvent).where(BoardRuntimeEvent.id == fact.id)
                    if existing.occurred_at > fact.occurred_at:
                        # Two tasks can finish out of order. Keep the first formation and its original attribution.
                        await session.execute(
                            match.where(BoardRuntimeEvent.occurred_at > fact.occurred_at).values(
                                occurred_at=fact.occurred_at,
                                run_id=fact.run_id,
                                user_id=fact.user_id,
                                department_id=fact.department_id,
                                asset_id=fact.asset_id,
                            )
                        )
                    if fact.kind == "version_member" and existing.member_file_id is None:
                        await session.execute(
                            match.where(BoardRuntimeEvent.member_file_id.is_(None)).values(
                                member_file_id=fact.member_file_id,
                                member_version_id=fact.member_version_id,
                            )
                        )
                session.add_all([event for event in events if event.id not in known])
                try:
                    await session.commit()
                    return
                except IntegrityError:
                    await session.rollback()
                    if attempt:
                        raise


async def runtime_rows(start, end):
    event = BoardRuntimeEvent
    within = (event.occurred_at >= start, event.occurred_at < end)
    member = aliased(event)
    belongs_to_version = (
        select(member.id)
        .where(
            member.tenant_id == event.tenant_id,
            member.kind == "version_member",
            member.member_file_id == event.id,
            member.occurred_at < end,
        )
        .correlate(event)
        .exists()
    )
    with strict_tenant_filter():
        async with get_async_db_session() as session:
            counts = (
                await session.exec(
                    select(
                        event.kind,
                        event.asset_id,
                        event.status,
                        event.department_id,
                        func.count(event.id),
                        func.count(event.active_seconds),
                        func.sum(event.active_seconds),
                    )
                    .where(*within, or_(event.kind != "file", ~belongs_to_version))
                    .group_by(event.kind, event.asset_id, event.status, event.department_id)
                )
            ).all()
            recent = (
                await session.exec(
                    select(event)
                    .where(*within, event.kind == "employee")
                    .order_by(event.occurred_at.desc(), event.id.desc())
                    .limit(30)
                )
            ).all()
            # Older builds recorded only irreversible hashes for member keys.
            unresolved = (
                await session.exec(
                    select(event.id)
                    .where(
                        event.kind == "version_member",
                        event.member_file_id.is_(None),
                        event.occurred_at < end,
                    )
                    .limit(1)
                )
            ).first()
            return counts, recent, unresolved is not None
