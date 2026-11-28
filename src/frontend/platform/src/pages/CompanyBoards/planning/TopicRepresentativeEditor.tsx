import { Button, Select } from "@bisheng/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useContext, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSelectLabels } from "@/components/bs-comp/formFields/useSelectLabels";
import { userContext } from "@/contexts/userContext";
import request, { showApiError } from "@/controllers/request";

interface Selection { asset: string | null; revision: number; unavailable?: boolean }
interface Options {
  employees: { id: string; name: string; topic: string }[];
  selections: Record<string, Selection>;
}

export function TopicRepresentativeEditor({ year, topicId }: { year: number; topicId: string }) {
  const { t } = useTranslation("topicExample");
  const { user } = useContext(userContext);
  const cache = useQueryClient();
  const labels = useSelectLabels();
  const id = useId();
  const path = "/api/v1/company-boards/planning/" + year + "/representatives";
  const query = useQuery({
    queryKey: ["company-boards", "representatives", user?.tenant_id, user?.user_id, year],
    queryFn: () => request.get<unknown, Options>(path),
  });
  const [draft, setDraft] = useState<Selection | null>(null);
  const mutation = useMutation({
    mutationFn: (change: Selection) => request.put(path + "/" + encodeURIComponent(topicId), change),
    onSuccess: async () => {
      await cache.invalidateQueries({ queryKey: ["company-boards"] });
      setDraft(null);
    },
    onError: (error: unknown) => {
      showApiError(error);
      void query.refetch();
      setDraft(null);
    },
  });
  if (query.isError) return <p role="alert">{t("loadFailed")} <Button size="small" onClick={() => query.refetch()}>{t("retry")}</Button></p>;
  if (!query.data) return <p role="status">{t("loading")}</p>;
  const current = query.data.selections[topicId] || { asset: null, revision: 0 };
  const employees = query.data.employees.filter(employee => employee.topic === topicId);
  return <div className="my-3 flex flex-wrap items-center gap-2">
    <label htmlFor={id}>{t("label")}</label>
    <Select {...labels} id={id} className="min-w-48" allowClear showSearch
      disabled={!employees.length || mutation.isLoading}
      placeholder={t(current.unavailable ? "unavailable" : employees.length ? "choose" : "noEmployees")}
      value={(draft || current).asset || undefined}
      options={employees.map(({ id, name }) => ({ value: id, label: name }))}
      onChange={value => setDraft({ asset: value ? String(value) : null, revision: current.revision })} />
    {((draft && draft.asset !== current.asset) || current.unavailable) && <Button size="small"
      disabled={mutation.isLoading} onClick={() => mutation.mutate(draft || { asset: null, revision: current.revision })}>
      {t(current.unavailable && !draft?.asset ? "clear" : "save")}
    </Button>}
  </div>;
}
