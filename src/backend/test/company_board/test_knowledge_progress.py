import json
import unittest
from contextlib import asynccontextmanager
from datetime import date, datetime
from unittest.mock import patch

from sqlalchemy.ext.asyncio import create_async_engine
from sqlmodel.ext.asyncio.session import AsyncSession

from bisheng.company_board.domain.models.ledger import BoardLedger
from bisheng.company_board.domain.models.supplement import BoardSupplement
from bisheng.company_board.domain.repositories.planning import category_key
from bisheng.company_board.domain.services import knowledge_progress as progress
from bisheng.knowledge.domain.models.knowledge import Knowledge


class KnowledgeProgressTest(unittest.IsolatedAsyncioTestCase):
    async def test_first_connection_year_reclassification_and_legacy_evidence(self):
        engine = create_async_engine("sqlite+aiosqlite://")
        self.addAsyncCleanup(engine.dispose)
        async with engine.begin() as conn:
            for model in (BoardLedger, BoardSupplement, Knowledge):
                await conn.run_sync(model.__table__.create)

        @asynccontextmanager
        async def session():
            async with AsyncSession(engine) as db:
                yield db

        first, second = category_key(1, "采购"), category_key(1, "设计")
        targets = [{"id": group, "target": 1} for group in (first, second)]

        def binding(asset, rev, day, category):
            return BoardSupplement(tenant_id=1, id=f"binding-{asset}", revision=rev, kind="asset-binding",
                year=day.year, name="", parent_id=f"knowledge:{asset}", business_date=day,
                payload=json.dumps({"knowledge_category_id":category}), operator_id=1, recorded_at=datetime.now())

        async with session() as db:
            for ident, tenant, kind in [(1,1,0),(2,1,1),(3,2,0),(4,1,2),(5,1,0)]:
                db.add(Knowledge(id=ident, tenant_id=tenant, name=str(ident), type=kind))
            db.add(BoardLedger(id="old", tenant_id=1, revision=1, kind="collection", year=2025, name="Old",
                asset_key="knowledge:1", effective_date=date(2025,8,1), operator_id=1))
            db.add(BoardSupplement(tenant_id=1, id="old-meta", revision=1, kind="collection-meta", year=2025,
                name="", parent_id="old", business_date=date(2025,1,1), operator_id=1,
                payload=json.dumps({"category":"采购"}), recorded_at=datetime.now()))
            for asset in (1,2,3,4):
                db.add(binding(asset, 1, date(2026,1,2), first))
            db.add(binding(5, 1, date(2026,1,5), first))
            db.add(binding(2, 2, date(2026,2,1), second))
            db.add(binding(2, 3, date(2026,3,1), None))
            await db.commit()
        with patch.object(progress, "get_async_db_session", session), patch.object(progress, "knowledge_targets", return_value=targets):
            for cutoff, expected in [(date(2025,12,31), [1,0]), (date(2026,1,31), [2,0]),
                                     (date(2026,2,28), [1,1]), (date(2026,3,31), [1,0])]:
                result = await progress.knowledge_progress(1, cutoff.year, cutoff)
                self.assertEqual([r["completed"] for r in result], expected, cutoff)
