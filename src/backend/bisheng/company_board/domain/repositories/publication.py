"""Capture a catalog asset's first confirmed publication in its source transaction."""

from contextlib import contextmanager
from datetime import datetime
from uuid import NAMESPACE_URL, uuid5
from zoneinfo import ZoneInfo

from loguru import logger
from sqlalchemy import and_, event, func, inspect, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from bisheng.company_board.domain.models.ledger import BoardLedger
from bisheng.company_board.domain.models.supplement import BoardSupplement
from bisheng.core.database.dialect_helpers import json_object_field_equals
from bisheng.database.models.app import APP_STATE_ONLINE, App
from bisheng.database.models.assistant import Assistant, AssistantStatus
from bisheng.database.models.audit_log import AuditLog
from bisheng.database.models.department import Department, UserDepartment
from bisheng.database.models.flow import Flow, FlowStatus, FlowType
from bisheng.knowledge.domain.models.knowledge import AuthTypeEnum, Knowledge, KnowledgeState, KnowledgeTypeEnum
from bisheng.linsight.domain.models.linsight_skill import LinsightSkill
from bisheng.tool.domain.models.gpts_tools import GptsTools, GptsToolsType


def record_first(connection, tenant, key, name, owner, day):
    ledger = BoardLedger.__table__
    latest = (
        select(ledger.c.id, func.max(ledger.c.revision).label("rev"))
        .where(ledger.c.tenant_id == tenant, ledger.c.asset_key == key, ledger.c.kind == "release")
        .group_by(ledger.c.id)
        .subquery()
    )
    records = (
        connection.execute(
            select(
                ledger.c.id,
                ledger.c.revision,
                ledger.c.effective_date,
                ledger.c.parent_id,
                ledger.c.department_id,
                ledger.c.year,
            )
            .join(latest, and_(ledger.c.id == latest.c.id, ledger.c.revision == latest.c.rev))
            .where(ledger.c.tenant_id == tenant)
            .order_by(ledger.c.id)
        )
        .mappings()
        .all()
    )
    if any(record["effective_date"] is not None for record in records):
        return
    plan = next((record for record in records if record["year"] == day.year), None)
    department = plan["department_id"] if plan else None
    if department is None and owner:
        department = connection.execute(
            select(UserDepartment.department_id)
            .join(Department, Department.id == UserDepartment.department_id)
            .where(
                Department.tenant_id == tenant,
                Department.is_deleted == 0,
                UserDepartment.user_id == owner,
                UserDepartment.is_primary == 1,
            )
            .order_by(UserDepartment.department_id)
            .limit(1)
        ).scalar()
    ident = plan["id"] if plan else str(uuid5(NAMESPACE_URL, f"bisheng:board:{tenant}:observed:{key}"))
    connection.execute(
        ledger.insert().values(
            tenant_id=tenant,
            id=ident,
            revision=plan["revision"] + 1 if plan else 1,
            kind="release",
            year=day.year,
            name=str(name or key)[:160],
            parent_id=plan["parent_id"] if plan else None,
            department_id=department,
            asset_key=key,
            effective_date=day,
            operator_id=owner or 0,
        )
    )


_STATUS_FIELDS = {
    Assistant: ("assistant", ("status", "is_delete")),
    Flow: ("flow", ("status", "flow_type")),
    Knowledge: ("knowledge", ("state", "auth_type", "type")),
    LinsightSkill: ("skill", ("enabled", "owner_user_id")),
    GptsTools: ("tool", ("type", "is_delete")),
    App: ("app", ("state",)),
}


def shanghai_today():
    return datetime.now(ZoneInfo("Asia/Shanghai")).date()


@contextmanager
def reporting_savepoint(connection, identity):
    # This includes the catalog/owner lookups. A missing reporting table during
    # an upgrade must leave the application's original write and result intact.
    try:
        with connection.begin_nested():
            yield
    except SQLAlchemyError as exc:
        logger.warning("Could not capture company board publication for {} ({})", identity, type(exc).__name__)


def marker_id(tenant, key):
    return str(uuid5(NAMESPACE_URL, f"bisheng:board:{tenant}:publication-history:{key}"))


def source_marker(connection, tenant, key):
    return connection.execute(
        select(BoardSupplement.kind, BoardSupplement.business_date).where(
            BoardSupplement.tenant_id == tenant,
            BoardSupplement.id == marker_id(tenant, key),
            BoardSupplement.revision == 1,
        )
    ).one_or_none()


def mark_source(connection, tenant, key, kind, day=None):
    now = datetime.now(ZoneInfo("Asia/Shanghai")).replace(tzinfo=None)
    connection.execute(
        BoardSupplement.__table__.insert().values(
            tenant_id=tenant,
            id=marker_id(tenant, key),
            revision=1,
            kind=kind,
            year=now.year,
            parent_id=key,
            name=key,
            business_date=day,
            payload="{}",
            recorded_at=now,
            operator_id=0,
        )
    )


def visible_entry(connection, row):
    if isinstance(row, Assistant) and row.status == AssistantStatus.ONLINE.value and not row.is_delete:
        return row.name, row.user_id
    if isinstance(row, Flow) and row.flow_type == FlowType.WORKFLOW.value and row.status == FlowStatus.ONLINE.value:
        return row.name, row.user_id
    if isinstance(row, App) and row.state == APP_STATE_ONLINE:
        return row.name, row.owner_user_id
    if (
        isinstance(row, Knowledge)
        and row.type != KnowledgeTypeEnum.PRIVATE.value
        and row.state == KnowledgeState.PUBLISHED.value
        and row.auth_type == AuthTypeEnum.PUBLIC
    ):
        return row.name, row.user_id
    if isinstance(row, LinsightSkill) and row.owner_user_id == 0 and row.enabled:
        return row.display_name or row.name, row.created_by
    if isinstance(row, GptsTools) and not row.is_delete:
        active = connection.execute(
            select(GptsToolsType.id).where(
                GptsToolsType.id == row.type,
                GptsToolsType.tenant_id == row.tenant_id,
                GptsToolsType.is_delete == 0,
            )
        ).scalar()
        if active is not None:
            return row.name, row.user_id
    return None


def capture_visibility(connection, row, *, created=False):
    if row.tenant_id is None:
        return
    key = f"{_STATUS_FIELDS[type(row)][0]}:{row.id}"
    first_day = None
    if created:
        # A draft created during observation can later supply a genuine first
        # publication. Its creation date is never used as a release date.
        mark_source(connection, row.tenant_id, key, "publication-watch")
    else:
        marker = source_marker(connection, row.tenant_id, key)
        if marker is None or marker.kind != "publication-watch":
            return
        first_day = marker.business_date
    entry = visible_entry(connection, row)
    if entry:
        name, owner = entry
        today = shanghai_today()
        if first_day is None:
            first_day = today
            table = BoardSupplement.__table__
            connection.execute(
                table.update()
                .where(
                    table.c.tenant_id == row.tenant_id,
                    table.c.id == marker_id(row.tenant_id, key),
                    table.c.revision == 1,
                )
                .values(business_date=first_day)
            )
        # If the ledger is unavailable, a later successful retry retains the
        # actual first date. Do not infer a historical department from a new owner.
        with reporting_savepoint(connection, key):
            record_first(connection, row.tenant_id, key, name, owner if first_day == today else None, first_day)


def inserted(mapper, connection, row):
    with reporting_savepoint(connection, row.id):
        capture_visibility(connection, row, created=True)


def changed(mapper, connection, row):
    if any(inspect(row).attrs[field].history.has_changes() for field in _STATUS_FIELDS[type(row)][1]):
        with reporting_savepoint(connection, row.id):
            capture_visibility(connection, row)


def legacy_audit_inserted(mapper, connection, row):
    # An app predating collection may already have run. Freeze the earliest
    # pre-existing audit evidence before a *new* republish can enter reports.
    if row.tenant_id is None or row.action != "app.release.online":
        return
    meta = row.audit_metadata or {}
    app_id = meta.get("app_id") if isinstance(meta, dict) else None
    if not isinstance(app_id, str) or not app_id:
        return
    key = f"app:{app_id}"
    with reporting_savepoint(connection, key):
        if source_marker(connection, row.tenant_id, key):
            return
        first = connection.execute(
            select(func.min(AuditLog.create_time)).where(
                AuditLog.tenant_id == row.tenant_id,
                AuditLog.action == row.action,
                AuditLog.id != row.id,
                json_object_field_equals(AuditLog.audit_metadata, "app_id", app_id, connection.dialect.name),
            )
        ).scalar()
        mark_source(connection, row.tenant_id, key, "publication-legacy", first.date() if first else None)


def after_catalog_update(state):
    marker = state.execution_options.get("catalog_publication")
    if marker is None:
        return None
    result = state.invoke_statement()
    if result.rowcount:
        conn = state.session.connection()
        with reporting_savepoint(conn, marker):
            if marker[0] == "knowledge":
                query = select(Knowledge).where(Knowledge.id == marker[1])
            elif marker[0] == "app":
                query = select(App).where(App.id == marker[1])
            else:
                query = select(LinsightSkill).where(
                    LinsightSkill.tenant_id == marker[1],
                    LinsightSkill.name == marker[2],
                    LinsightSkill.owner_user_id == 0,
                )
            row = state.session.execute(query.execution_options(populate_existing=True)).scalar_one_or_none()
            if row is not None:
                capture_visibility(conn, row)
    return result


def install_publication_tracking():
    if not event.contains(Session, "do_orm_execute", after_catalog_update):
        event.listen(Session, "do_orm_execute", after_catalog_update, retval=True)
    if not event.contains(AuditLog, "after_insert", legacy_audit_inserted):
        event.listen(AuditLog, "after_insert", legacy_audit_inserted)
    for model in _STATUS_FIELDS:
        if not event.contains(model, "after_insert", inserted):
            event.listen(model, "after_insert", inserted)
            event.listen(model, "after_update", changed)
