"""Dated topic preferences and tombstones in the revision ledger."""
import json

from sqlmodel import select

from bisheng.company_board.domain.models.supplement import BoardSupplement

KIND = "topic-state"


async def topic_states(db, tenant, *, year=None, cutoff=None, topic=None):
    row = BoardSupplement
    query = select(row).where(row.tenant_id == tenant, row.kind == KIND)
    if year is not None:
        query = query.where(row.year == year)
    if cutoff:
        query = query.where(row.business_date <= cutoff)
    if topic:
        query = query.where(row.parent_id == topic)
    return {r.parent_id: json.loads(r.payload) for r in (await db.exec(query.order_by(row.revision))).all()}
