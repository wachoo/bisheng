from collections import Counter
from datetime import UTC, datetime, timedelta, timezone
from hashlib import sha256

from loguru import logger
from sqlalchemy.exc import SQLAlchemyError

from bisheng.common.board_observation import BoardObservation
from bisheng.company_board.domain.models.runtime_event import BoardRuntimeEvent
from bisheng.company_board.domain.repositories.runtime import insert_events, primary_department, runtime_rows
from bisheng.core.context.tenant import DEFAULT_TENANT_ID, get_current_tenant_id

BEIJING = timezone(timedelta(hours=8))


class WebAssistantObservation(BoardObservation):
    @classmethod
    async def begin(cls, asset_id, user_id):
        observation = cls(asset_id, user_id)
        try:
            observation.department_id = await primary_department(user_id)
        except SQLAlchemyError:
            # An unknown reporting dimension cannot prevent an authorized user from chatting.
            logger.exception("Company board could not determine request department")
        return observation

    async def persist(self, outcome, message_id):
        await save_observation(self, outcome, message_id)


async def save_observation(observation, outcome, message_id):
    seconds = observation.finish()
    common = {"user_id": observation.user_id, "department_id": observation.department_id, "run_id": observation.id}
    events = [
        BoardRuntimeEvent(
            id=observation.id,
            kind="employee",
            asset_id=observation.asset_id,
            status=outcome,
            terminal_message_id=message_id,
            active_seconds=seconds,
            occurred_at=datetime.now(UTC).replace(tzinfo=None),
            **common,
        )
    ]
    tenant = get_current_tenant_id() or DEFAULT_TENANT_ID
    for (kind, asset_id, operation), (status, at) in observation.facts.copy().items():
        # A storage key identifies a file across replays. Tool operation IDs are local to each root request.
        if kind in {"file", "version"}:
            key = f"{tenant}:{kind}:{operation}"
        elif kind == "version_member":
            key = f"{tenant}:{kind}:{asset_id}:{operation}"
        else:
            key = f"{observation.id}:{kind}:{asset_id}:{operation}"
        events.append(
            BoardRuntimeEvent(
                id=sha256(key.encode()).hexdigest(),
                member_file_id=sha256(f"{tenant}:file:{operation}".encode()).hexdigest()
                if kind == "version_member"
                else None,
                member_version_id=sha256(f"{tenant}:version:{asset_id}".encode()).hexdigest()
                if kind == "version_member"
                else None,
                kind=kind,
                asset_id=asset_id,
                status=status,
                occurred_at=at,
                **common,
            )
        )
    try:
        await insert_events(events)
    except SQLAlchemyError:
        # An unavailable analytics table must not interrupt a completed user conversation.
        logger.exception("Company board could not store assistant run {}", observation.id)


def summarize(counts, recent):
    by_status = Counter()
    usage = Counter()
    departments = Counter()
    timed = 0
    active = 0.0
    for kind, asset_id, status, department, number, timed_count, seconds in counts:
        by_status[kind, status] += number
        if kind == "employee" and status in {"success", "failed"}:
            timed += timed_count
            active += float(seconds or 0)
        if (kind in {"employee", "knowledge", "tool"} and status == "success") or (
            kind == "skill" and status == "entered"
        ):
            prefix = "assistant" if kind == "employee" else kind
            usage[kind, f"{prefix}:{asset_id}"] += number
            departments[department] += number

    eligible = by_status["employee", "success"] + by_status["employee", "failed"]

    def measured(kind, status):
        return by_status[kind, status] if counts else None

    return {
        "scope": "已采集的 Web 助手对话",
        "observed_runs": eligible + by_status["employee", "cancelled"],
        "successful_tasks": measured("employee", "success"),
        "failed_tasks": measured("employee", "failed"),
        "active_seconds": round(active, 3) if timed else None,
        "timed_tasks": timed,
        "timing_coverage": None,
        "observed_timing_coverage": timed / eligible if eligible else None,
        "tool_success": measured("tool", "success"),
        "tool_failure": measured("tool", "failed"),
        "skill_calls": measured("skill", "entered"),
        "knowledge_success": measured("knowledge", "success"),
        "file_outputs": measured("file", "success"),
        "code_versions": measured("version", "success"),
        "deliverables": by_status["file", "success"] + by_status["version", "success"] if counts else None,
        "coverage_note": "统计正式 Web 助手对话中已采集的样本。普通文件取已登记文件和文档技能的输出。"
        "代码版本取已登记项目版本及其文件清单。其他入口、未归集的文件及全范围计时分母尚未采全。",
        "recent_runs": [
            {
                "id": row.run_id,
                "asset_id": f"assistant:{row.asset_id}",
                "status": row.status,
                "ended_at": row.occurred_at.replace(tzinfo=UTC).astimezone(BEIJING).isoformat(),
                "active_seconds": row.active_seconds,
            }
            for row in recent
        ],
        "usage": [
            {"kind": kind, "asset_id": asset, "count": number} for (kind, asset), number in sorted(usage.items())
        ],
        "department_usage": [
            {"department_id": department, "count": number} for department, number in departments.most_common()
        ],
    }


async def read_runtime(tenant_id, start, end):
    if int(tenant_id) != (get_current_tenant_id() or DEFAULT_TENANT_ID):
        raise ValueError("Board tenant must match the request context")
    start_utc, end_utc = [
        (value if value.tzinfo else value.replace(tzinfo=BEIJING)).astimezone(UTC).replace(tzinfo=None)
        for value in (start, end)
    ]
    counts, recent, unresolved = await runtime_rows(start_utc, end_utc)
    result = summarize(counts, recent)
    if unresolved and result["file_outputs"]:
        result["file_outputs"] = None
        result["deliverables"] = None
        result["coverage_note"] += "早期版本清单缺少文件关联。文件件数及成果总数暂不可核对。"
    return result
