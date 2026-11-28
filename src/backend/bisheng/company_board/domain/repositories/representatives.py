from datetime import UTC, datetime
import json
from uuid import NAMESPACE_URL, uuid5

from sqlalchemy.exc import IntegrityError
from sqlmodel import select

from bisheng.common.errcode.company_board import BoardLedgerConflictError
from bisheng.company_board.domain.models.supplement import BoardSupplement
from bisheng.core.database import get_async_db_session


KIND = "topic-example"


async def save_selection(tenant, actor, topic, year, day, employee, expected_revision):
    ident = str(uuid5(NAMESPACE_URL, f"bisheng:board:{tenant}:{year}:{KIND}:{topic}"))
    query = (select(BoardSupplement)
             .where(BoardSupplement.tenant_id == tenant, BoardSupplement.id == ident)
             .order_by(BoardSupplement.revision.desc()).limit(1))
    payload = json.dumps({"asset": employee})
    async with get_async_db_session() as db:
        latest = (await db.exec(query.with_for_update())).first()
        if latest and latest.payload == payload:
            return
        revision = latest.revision if latest else 0
        if revision != expected_revision:
            raise BoardLedgerConflictError()
        db.add(BoardSupplement(
            tenant_id=tenant, id=ident, kind=KIND, parent_id=topic, revision=revision + 1,
            year=year, business_date=day, name=KIND, payload=payload, operator_id=actor,
            recorded_at=datetime.now(UTC).replace(tzinfo=None),
        ))
        try:
            await db.commit()
        except IntegrityError as exc:
            await db.rollback()
            winner = (await db.exec(query)).first()
            if not winner or winner.payload != payload:
                raise BoardLedgerConflictError() from exc
