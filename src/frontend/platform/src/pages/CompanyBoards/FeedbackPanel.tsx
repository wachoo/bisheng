import { Button, Input } from "@bisheng/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useContext, useState } from "react";
import { useTranslation } from "react-i18next";
import { userContext } from "@/contexts/userContext";
import { getBoardFeedback, resolveBoardIssue } from "@/controllers/API/boardFeedback";

type Props = { year: number; month: number; manage: boolean };

export function FeedbackPanel(props: Props) {
  return <FeedbackPeriod key={[props.year, props.month, props.manage].join("-")} {...props} />;
}

function FeedbackPeriod({ year, month, manage }: Props) {
  const { t } = useTranslation("boardFeedback");
  const [offset, setOffset] = useState(0);
  const [editing, setEditing] = useState<string | null>(null);
  const [measure, setMeasure] = useState("");
  const { user } = useContext(userContext);
  const client = useQueryClient();
  const feedback = useQuery({
    queryKey: ["company-board-feedback", user?.tenant_id, user?.user_id, year, month, offset, manage],
    queryFn: () => getBoardFeedback(year, month, offset),
  });
  const resolve = useMutation({
    mutationFn: (runId: string) => resolveBoardIssue(runId, measure.trim()),
    onSuccess: async () => {
      setEditing(null);
      setMeasure("");
      await client.invalidateQueries({ queryKey: ["company-board-feedback"] });
    },
  });
  const data = feedback.data;
  return <section aria-label={t("title")} className="rounded-xl border bg-background p-5">
    <h2 className="text-lg font-semibold">{t("title")}</h2>
    <p className="mt-1 text-sm text-muted-foreground">{t("scope")}</p>
    {feedback.isError && <Button variant="outlined" onClick={() => feedback.refetch()}>{t("retry")}</Button>}
    {feedback.isLoading && <p role="status">{t("loading")}</p>}
    {data && <>
      <div className="my-3 flex gap-8 text-sm">
        <span>{t("pending")} <strong>{data.pending}</strong></span>
        <span>{t("closed")} <strong>{data.closed}</strong></span>
      </div>
      {manage && data.rows.map(row => <div key={row.run_id} className="flex flex-wrap items-center gap-3 border-t py-3 text-sm">
        <span className="font-mono">{row.run_id}</span>
        <span>{t(row.resolved_at ? "closed" : "pending")}</span>
        {row.resolved_at && <span className="break-all">{row.measure}</span>}
        {!row.resolved_at && (editing === row.run_id
          ? <form className="flex items-center gap-2" onSubmit={e => { e.preventDefault(); if (measure.trim()) resolve.mutate(row.run_id); }}>
              <Input aria-label={t("measure")} placeholder={t("measure")} value={measure} maxLength={500}
                onChange={event => setMeasure(event.target.value)} />
              <Button type="submit" disabled={resolve.isLoading || !measure.trim()}>{t("close")}</Button>
              <Button type="button" variant="text" onClick={() => setEditing(null)}>{t("cancel")}</Button>
            </form>
          : <Button variant="outlined" onClick={() => { setEditing(row.run_id); setMeasure(""); }}>{t("process")}</Button>)}
      </div>)}
      {resolve.isError && <p role="alert">{t("error")}</p>}
      {manage && data.total > 10 && <div className="flex gap-2">
        <Button variant="outlined" disabled={!offset} onClick={() => setOffset(offset - 10)}>{t("previous")}</Button>
        <Button variant="outlined" disabled={offset + 10 >= data.total} onClick={() => setOffset(offset + 10)}>{t("next")}</Button>
      </div>}
    </>}
  </section>;
}
