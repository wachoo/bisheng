import json
from datetime import timedelta

from sqlalchemy import case, func
from sqlmodel import select

from bisheng.company_board.domain.models.runtime_event import BoardRuntimeEvent as Event
from bisheng.core.database import get_async_db_session
from bisheng.database.models.message import ChatMessage


async def monthly_terminals(tenant_id, start, end):
    """Aggregate actual terminals into Beijing days using portable SQL expressions."""
    predicate = (
        Event.tenant_id == tenant_id,
        Event.kind.in_(["employee", "knowledge", "tool"]),
        Event.occurred_at < end,
    )
    thresholds = []
    day = start
    while day < end:
        day += timedelta(days=1)
        thresholds.append((Event.occurred_at < day, len(thresholds) + 1))
    if not thresholds:
        return [], []
    bucket = case(*thresholds)
    async with get_async_db_session() as db:
        known = (
            await db.exec(
                select(Event.kind, Event.asset_id)
                .where(*predicate, Event.status.in_(["success", "failed", "cancelled"]))
                .distinct()
            )
        ).all()
        series = (
            await db.exec(
                select(
                    Event.kind,
                    Event.asset_id,
                    Event.status,
                    bucket.label("day"),
                    func.count(Event.id),
                    func.max(Event.occurred_at),
                )
                .where(*predicate, Event.status.in_(["success", "failed"]), Event.occurred_at >= start)
                .group_by(Event.kind, Event.asset_id, Event.status, bucket)
            )
        ).all()
    return known, series


async def run_receipt(tenant_id, run_id, end):
    async with get_async_db_session() as db:
        return (
            await db.exec(
                select(Event).where(
                    Event.tenant_id == tenant_id,
                    Event.kind == "employee",
                    Event.run_id == run_id,
                    Event.occurred_at < end,
                )
            )
        ).first()


def visible_text(message, is_bot):
    if not message:
        return None
    try:
        parsed = json.loads(message)
    except (ValueError, TypeError):
        return message[:500]
    if isinstance(parsed, str):
        return parsed[:500]
    if not isinstance(parsed, dict):
        return None
    keys = ("content", "text") if is_bot else ("query", "text", "content")
    return next((parsed[key][:500] for key in keys if isinstance(parsed.get(key), str) and parsed[key]), None)


async def own_excerpts(tenant_id, user_id, row):
    if row.user_id != user_id:
        return None, None
    requested = {False: getattr(row, "input_message_id", None), True: row.terminal_message_id}
    ids = [i for i in requested.values() if i is not None]
    if not ids:
        return None, None
    query = select(ChatMessage.id, ChatMessage.is_bot, ChatMessage.message).where(
        ChatMessage.tenant_id == tenant_id,
        ChatMessage.user_id == user_id,
        ChatMessage.id.in_(ids),
        ChatMessage.flow_id == row.asset_id,
    )
    async with get_async_db_session() as db:
        texts = {
            is_bot: visible_text(message, is_bot)
            for ident, is_bot, message in (await db.exec(query)).all()
            if requested.get(is_bot) == ident
        }
    return texts.get(False), texts.get(True)
