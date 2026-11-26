"""Annual category targets and observed knowledge-library connections."""

import json
from collections import Counter

from sqlalchemy import String, and_, cast, func, literal
from sqlmodel import select

from bisheng.company_board.domain.models.ledger import BoardLedger
from bisheng.company_board.domain.models.supplement import BoardSupplement
from bisheng.company_board.domain.repositories.asset_context import KIND
from bisheng.company_board.domain.repositories.planning import category_key, knowledge_targets
from bisheng.core.database import get_async_db_session
from bisheng.knowledge.domain.models.knowledge import Knowledge, KnowledgeTypeEnum


def category_counts(history, year):
    # Credit a library once, in the year it first receives a category. A later
    # reclassification moves that credit without generating another connection.
    first_year = {}
    current = {}
    for key, day, category in history:
        if category:
            first_year.setdefault(key, day.year)
        current[key] = category
    return Counter(category for key, category in current.items() if category and first_year.get(key) == year)


def library_asset_key():
    return literal("knowledge:") + cast(Knowledge.id, String)


async def legacy_connections(db, tenant, cutoff, asset_key=None):
    # Old plans recorded a verified library explicitly. Keep that evidence without
    # changing the records or asking operators to enter the same connection again.
    versions = (select(BoardLedger.id, func.max(BoardLedger.revision).label("rev"))
                .where(BoardLedger.tenant_id == tenant, BoardLedger.kind == "collection", BoardLedger.year <= cutoff.year)
                .group_by(BoardLedger.id).subquery())
    query = (select(BoardLedger.id, BoardLedger.asset_key, BoardLedger.effective_date)
             .join(versions, and_(versions.c.id == BoardLedger.id, versions.c.rev == BoardLedger.revision))
             .join(Knowledge, BoardLedger.asset_key == library_asset_key())
             .where(BoardLedger.tenant_id == tenant, Knowledge.tenant_id == tenant,
                    Knowledge.type.in_([KnowledgeTypeEnum.NORMAL.value, KnowledgeTypeEnum.QA.value]),
                    BoardLedger.effective_date <= cutoff)
             .order_by(BoardLedger.effective_date, BoardLedger.id))
    if asset_key:
        query = query.where(BoardLedger.asset_key == asset_key)
    rows = (await db.exec(query)).all()
    if not rows:
        return []
    metadata = (select(BoardSupplement.parent_id, BoardSupplement.payload)
                .where(BoardSupplement.tenant_id == tenant, BoardSupplement.kind == "collection-meta",
                       BoardSupplement.business_date <= cutoff, BoardSupplement.parent_id.in_([row[0] for row in rows]))
                .order_by(BoardSupplement.business_date, BoardSupplement.revision))
    names = {parent: json.loads(raw).get("category") for parent, raw in (await db.exec(metadata)).all()}
    return [(asset, day, names.get(ident) or "未归类") for ident, asset, day in rows]


async def knowledge_progress(tenant, year, cutoff, catalog=()):
    targets = await knowledge_targets(tenant, year, cutoff)
    if not targets and not any(asset["kind"] == "knowledge" for asset in catalog):
        return []
    # Expose aggregate counts only. The library itself can have restricted access.
    query = (
        select(BoardSupplement.parent_id, BoardSupplement.business_date, BoardSupplement.payload)
        .join(Knowledge, BoardSupplement.parent_id == library_asset_key())
        .where(
            BoardSupplement.kind == KIND,
            BoardSupplement.tenant_id == tenant,
            BoardSupplement.business_date <= cutoff,
            Knowledge.tenant_id == tenant,
            Knowledge.type.in_([KnowledgeTypeEnum.NORMAL.value, KnowledgeTypeEnum.QA.value]),
        )
        .order_by(BoardSupplement.business_date, BoardSupplement.revision)
    )
    async with get_async_db_session() as db:
        legacy = await legacy_connections(db, tenant, cutoff)
        observations = [(key, day, category_key(tenant, name)) for key, day, name in legacy]
        names = {category_key(tenant, name): name for _, _, name in legacy}
        for key, day, raw in (await db.exec(query)).all():
            payload = json.loads(raw)
            if "knowledge_category_id" in payload:
                category = payload["knowledge_category_id"]
                observations.append((key, day, category))
                if category and payload.get("knowledge_category_name"):
                    names[category] = payload["knowledge_category_name"]
    observations.sort(key=lambda event: event[1])
    counts = category_counts(observations, year)
    if catalog:
        names.update({t["id"]: t["name"] for t in targets})
        current = {key: category for key, _, category in observations}
        for asset in catalog:
            if asset["kind"] == "knowledge":
                asset["knowledge_category_name"] = names.get(current.get(asset["id"]))
    return [{**target, "completed": counts[target["id"]]} for target in targets]
