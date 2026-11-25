import { TableCell, TableRow } from "@/components/bs-ui/table";
import type { SkillBrief } from "@/controllers/API/linsight";
import { Button } from "@bisheng/ui";
import { Outlined } from "bisheng-icons";
import { Sparkles } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

export type SkillEntryAction = "upload" | "create";

export function SkillAuthoringActions({ onUpload, onCreate }: { onUpload: () => void; onCreate: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="ml-auto flex shrink-0 gap-2">
      <Button variant="outlined" color="default" onClick={onUpload}>
        <Outlined.Upload className="mr-1.5 size-4" />{t("skillManage.upload")}
      </Button>
      <Button onClick={onCreate}>
        <Outlined.Plus className="mr-1.5 size-4" />{t("skillManage.create")}
      </Button>
    </div>
  );
}

export function SkillTableRow({ skill, onDetail, children }: {
  skill: Pick<SkillBrief, "display_name" | "description">;
  onDetail: () => void;
  children: ReactNode;
}) {
  return (
    <TableRow className="group cursor-pointer hover:bg-primary/5" onClick={onDetail}>
      <TableCell className="font-medium">
        <button type="button" className="flex w-full min-w-0 items-center gap-2 text-left lg:gap-3" title={skill.display_name}
          onClick={event => { event.stopPropagation(); onDetail(); }}>
          <span className="grid size-[34px] shrink-0 place-items-center rounded-[9px] bg-gradient-to-br from-[#EEF2FF] to-[#E2EAFF] text-primary">
            <Sparkles className="size-[17px]" />
          </span>
          <span className="min-w-0 truncate">{skill.display_name}</span>
        </button>
      </TableCell>
      <TableCell className="truncate" title={skill.description}>{skill.description}</TableCell>
      {children}
      <TableCell className="text-[#C4C9D4] group-hover:text-primary">
        <Outlined.Right className="size-4 transition-transform group-hover:translate-x-0.5" />
      </TableCell>
    </TableRow>
  );
}
