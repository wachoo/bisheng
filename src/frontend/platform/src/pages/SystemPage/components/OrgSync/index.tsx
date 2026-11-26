import { Alert, Button, Pagination, Switch, Tag, toast, Tooltip } from '@bisheng/ui';
import { Outlined } from 'bisheng-icons';


import {
Table,
TableBody,
TableCell,
TableHead,
TableHeader,
TableRow,
} from "@/components/bs-ui/table";
import { bsConfirm } from "@/components/bs-ui/alertDialog/useConfirm";
import {
  executeOrgSyncApi,
  listGatewayOrgSyncLogsApi,
  listOrgSyncConfigsApi,
  updateOrgSyncConfigApi,
} from "@/controllers/API/orgSync";
import { showApiError } from "@/controllers/request";
import { OrgSyncConfig, OrgSyncLog } from "@/types/api/orgSync";
import { formatIsoDateTime } from "@/util/utils";
import { usePaginationLocale } from "@/hooks/usePaginationLocale";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { GatewayLogDetailDialog } from "./GatewayLogDetailDialog";
import { WecomConfigDialog } from "./WecomConfigDialog";

const PAGE_SIZE = 20
/** Poll while a manual sync runs in the background: 5s × 24 = 2 minutes. */
const POLL_INTERVAL_MS = 5000
const MAX_POLL_TICKS = 24

function RunStatusBadge({ status }: { status: string | null | undefined }) {
  const { t } = useTranslation("orgSync")
  if (!status) return <span className="text-muted-foreground">-</span>
  const variantMap: Record<string, "success" | "warning" | "danger" | "brand"> = {
    success: "success",
    partial: "warning",
    failed: "danger",
    running: "brand",
  }
  const label = t(`runStatus.${status}`, status)
  return <Tag size="small" dot color={variantMap[status] || "default"}>{label}</Tag>
}

function hasErrorDetails(log: OrgSyncLog): boolean {
  return Array.isArray(log.error_details) && log.error_details.length > 0
}

export default function OrgSync() {
  const { t } = useTranslation("orgSync")
  const paginationLocale = usePaginationLocale()

  // Page-local server data — fetched here per C7 (stores must not call HTTP).
  const [gatewayLogs, setGatewayLogs] = useState<OrgSyncLog[]>([])
  const [gatewayTotal, setGatewayTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [page, setPage] = useState(1)

  const [detailLog, setDetailLog] = useState<OrgSyncLog | null>(null)

  // The tenant's WeCom configs: the single active one backs the manual sync
  // button and the login entry; the list also feeds the config table above.
  const [configs, setConfigs] = useState<OrgSyncConfig[]>([])
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingConfig, setEditingConfig] = useState<OrgSyncConfig | null>(null)
  // Row whose enable switch is waiting on the server; the switch stays where the
  // user put it and flips back only if the request fails (§4 失败要回弹).
  const [togglingId, setTogglingId] = useState<OrgSyncConfig["id"] | null>(null)
  const wecomConfigs = useMemo(
    () => configs.filter((item) => item.provider === "wecom"),
    [configs],
  )
  const activeConfig = wecomConfigs.find((item) => item.status === "active") ?? null
  // Distinguishes "no config" from "could not load" — the latter must not be
  // shown as 未配置, or the operator edits settings that are already correct.
  const [configLoadFailed, setConfigLoadFailed] = useState(false)
  const [polling, setPolling] = useState(false)
  // Blocks a second click while the POST is in flight; once it lands, the
  // backend Redis gate rejects duplicates and sync_status drives the button.
  const [submitting, setSubmitting] = useState(false)
  const isRunning = activeConfig?.sync_status === "running"

  const fetchGatewayLogs = useCallback(async (nextPage: number) => {
    setLoading(true)
    setPage(nextPage)
    await listGatewayOrgSyncLogsApi({ page: nextPage, limit: PAGE_SIZE }).then(({ data, total }) => {
        setGatewayLogs(data)
        setGatewayTotal(total)
      }).catch(showApiError).finally(() => setLoading(false))
  }, [])

  const fetchConfigs = useCallback(async () => {
    await listOrgSyncConfigsApi()
      .then((list) => {
        setConfigs(list || [])
        setConfigLoadFailed(false)
      })
      .catch(() => setConfigLoadFailed(true)) // polling: no toast on every tick
  }, [])

  useEffect(() => {
    fetchGatewayLogs(1)
    void fetchConfigs()
  }, [fetchGatewayLogs, fetchConfigs])

  // A manual run finishes in the worker; poll the log until it shows up.
  useEffect(() => {
    if (!polling) return
    let ticks = 0
    const timer = setInterval(() => {
      ticks += 1
      void fetchGatewayLogs(1)
      void fetchConfigs()
      if (ticks >= MAX_POLL_TICKS) setPolling(false)
    }, POLL_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [polling, fetchGatewayLogs, fetchConfigs])

  const handleExecute = useCallback(() => {
    if (!activeConfig || isRunning || submitting) return
    bsConfirm({
      title: t("confirmExecute.title"),
      desc: t("confirmExecute.desc", { name: activeConfig.config_name }),
      okTxt: t("actions.execute"),
      canelTxt: t("actions.cancel"),
      onOk(next) {
        setSubmitting(true)
        return executeOrgSyncApi(activeConfig.id)
          .then(() => {
            toast.show({ type: "success", message: t("executeSuccess.title") })
            setPolling(true)
            void fetchConfigs()
            next()
          })
          .finally(() => setSubmitting(false))
      },
    })
  }, [activeConfig, isRunning, submitting, t, fetchConfigs])

  // Keep at most one active WeCom config: the login entry is hidden when two
  // are active (19331), so activating one retires the others first. The switch
  // flips optimistically and restores the previous list if the request fails.
  const handleToggleStatus = useCallback(
    async (config: OrgSyncConfig) => {
      const enabling = config.status !== "active"
      const snapshot = configs
      setTogglingId(config.id)
      setConfigs((prev) =>
        prev.map((item) => {
          if (item.id === config.id) {
            return { ...item, status: enabling ? "active" : "disabled" }
          }
          if (enabling && item.status === "active") {
            return { ...item, status: "disabled" }
          }
          return item
        }),
      )
      try {
        if (enabling) {
          const others = wecomConfigs.filter(
            (item) => item.status === "active" && item.id !== config.id,
          )
          for (const other of others) {
            await updateOrgSyncConfigApi(other.id, { status: "disabled" })
          }
        }
        await updateOrgSyncConfigApi(config.id, {
          status: enabling ? "active" : "disabled",
        })
        toast.show({ type: "success", message: t("configs.statusUpdated") })
        void fetchConfigs()
      } catch (error) {
        setConfigs(snapshot)
        showApiError(error)
      } finally {
        setTogglingId(null)
      }
    },
    [configs, fetchConfigs, t, wecomConfigs],
  )

  const openCreateDialog = useCallback(() => {
    setEditingConfig(null)
    setDialogOpen(true)
  }, [])

  const openEditDialog = useCallback((config: OrgSyncConfig) => {
    setEditingConfig(config)
    setDialogOpen(true)
  }, [])

  const activeCount = wecomConfigs.filter((item) => item.status === "active").length

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-4">
      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="text-body font-medium text-text-1">{t("configs.title")}</span>
          <Button size="small" onClick={openCreateDialog}>
            {t("actions.create")}
          </Button>
        </div>

        {activeCount > 1 && (
          <Alert type="warning" description={t("configs.multipleActiveWarning")} />
        )}

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("configs.columnName")}</TableHead>
              <TableHead>{t("configs.columnStatus")}</TableHead>
              <TableHead>{t("configs.columnUpdated")}</TableHead>
              <TableHead className="text-right">{t("configs.columnActions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {wecomConfigs.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4} className="text-center text-muted-foreground">
                  {t("configs.empty")}
                </TableCell>
              </TableRow>
            ) : (
              wecomConfigs.map((config) => (
                <TableRow key={config.id}>
                  <TableCell>{config.config_name}</TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Switch
                        size="small"
                        checked={config.status === "active"}
                        loading={togglingId === config.id}
                        disabled={togglingId !== null && togglingId !== config.id}
                        aria-label={config.config_name}
                        onCheckedChange={() => void handleToggleStatus(config)}
                      />
                      <span className="text-body-sm text-text-2">
                        {config.status === "active"
                          ? t("configs.statusActive")
                          : t("configs.statusDisabled")}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell className="whitespace-nowrap font-mono text-xs">
                    {formatIsoDateTime(config.update_time)}
                  </TableCell>
                  <TableCell className="text-right">
                    <Tooltip content={t("actions.edit")}>
                      <Button
                        size="small"
                        variant="text"
                        color="default"
                        iconOnly
                        aria-label={t("actions.edit")}
                        onClick={() => openEditDialog(config)}
                      >
                        <Outlined.Edit size={14} />
                      </Button>
                    </Tooltip>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </section>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-body-sm text-text-3">
          {isRunning
            ? t("runningHint")
            : configLoadFailed
              ? t("configLoadFailed")
              : activeConfig
                ? t("runNowHint", { name: activeConfig.config_name })
                : t("noActiveConfig")}
        </span>
        <Button
          size="small"
          disabled={!activeConfig || isRunning || submitting}
          loading={submitting}
          onClick={handleExecute}
        >
          {t("actions.execute")}
        </Button>
      </div>

      <div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("columns.time")}</TableHead>
              <TableHead>{t("columns.trigger")}</TableHead>
              <TableHead>{t("columns.status")}</TableHead>
              <TableHead>{t("columns.deptSummary")}</TableHead>
              <TableHead>{t("columns.memberSummary")}</TableHead>
              <TableHead>{t("columns.hasErrors")}</TableHead>
              <TableHead className="text-right">{t("columns.actions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && gatewayLogs.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="text-center text-muted-foreground">
                  {t("loading")}
                </TableCell>
              </TableRow>
            ) : gatewayLogs.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="text-center text-muted-foreground">
                  {t("emptyHint")}
                </TableCell>
              </TableRow>
            ) : (
              gatewayLogs.map((log) => (
                <TableRow key={log.id}>
                  <TableCell className="whitespace-nowrap font-mono text-xs">
                    {formatIsoDateTime(log.end_time || log.start_time)}
                  </TableCell>
                  <TableCell>
                    <span className="text-xs text-muted-foreground">
                      {t(`triggerType.${log.trigger_type}`, log.trigger_type)}
                    </span>
                  </TableCell>
                  <TableCell>
                    <RunStatusBadge status={log.status} />
                  </TableCell>
                  <TableCell>
                    <span className="text-xs text-muted-foreground">
                      +{log.dept_created} / ~{log.dept_updated} / ×{log.dept_archived}
                    </span>
                  </TableCell>
                  <TableCell>
                    <span className="text-xs text-muted-foreground">
                      +{log.member_created} / ~{log.member_updated} / 🚫
                      {log.member_disabled} / ↻{log.member_reactivated}
                    </span>
                  </TableCell>
                  <TableCell>
                    {hasErrorDetails(log) ? (
                      <Tag size="small" dot color="danger">{t("columns.yes")}</Tag>
                    ) : (
                      <span className="text-muted-foreground">{t("columns.no")}</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button size="small" variant="outlined" onClick={() => setDetailLog(log)} color="default">
                      {t("actions.viewDetail")}
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <Pagination
        locale={paginationLocale}
        current={page}
        pageSize={PAGE_SIZE}
        total={gatewayTotal}
        showTotal
        disabled={loading}
        onChange={(nextPage) => void fetchGatewayLogs(nextPage)}
      />

      <GatewayLogDetailDialog log={detailLog} onClose={() => setDetailLog(null)} />
      <WecomConfigDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        editing={editingConfig}
        siblings={wecomConfigs}
        onSaved={() => void fetchConfigs()}
      />
    </div>
  )
}
