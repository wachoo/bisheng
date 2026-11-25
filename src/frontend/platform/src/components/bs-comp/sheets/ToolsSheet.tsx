// @ts-strict-ignore
import { Button, SearchInput } from '@bisheng/ui';
import { Outlined } from "bisheng-icons";

import { SkillTableRow, SkillAuthoringActions, type SkillEntryAction } from "@/components/LinSight/skill/SkillListControls";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/bs-ui/table";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/bs-ui/dialog";
import { userContext } from "@/contexts/userContext";
import { canManageWorkbenchConfig } from "@/pages/ModelPage/manage/permissions";
import { Accordion } from "@/components/bs-ui/accordion";


import { Sheet,SheetContent,SheetTitle,SheetTrigger } from "@/components/bs-ui/sheet";
import { getToolsApi } from "@/controllers/API/tools";
import { useMcpRefrensh } from "@/pages/BuildPage/tools";
import ToolItem from "@/pages/BuildPage/tools/ToolItem";
import { CpuIcon, Sparkles, Star } from "lucide-react";
import { useContext, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

export default function ToolsSheet({ select, onSelect, children, skills = [], skillIds = [], onAddSkill = undefined, skillsLoading = false, skillsError = false }) {
    const { t } = useTranslation()
    const [type, setType] = useState('default') // default custom

    const { user } = useContext(userContext)
    const [detail, setDetail] = useState(null)
    const [keyword, setKeyword] = useState('')
    const [allData, setAllData] = useState([])


    const loadMData = () => {
        if (type === "skills") return
        getToolsApi(type).then(res => {
            setAllData(res)
            setKeyword('')
        })
    }
    useEffect(() => {
        loadMData()
    }, [type])

    const options = useMemo(() => {
        return allData.filter((el) => {
            // 搜索范围：工具名称、工具描述、工具api名称、工具api描述
            const targetStr = `${el.name}-${el.description}-${el.children?.map((el) => el.name + el.desc).join("-") || ''}`
            return targetStr.toLowerCase().includes(keyword.toLowerCase());
        });
    }, [keyword, allData])

    const search = keyword.trim().toLowerCase()
    const matchingSkills = skills.filter(skill =>
        [skill.display_name, skill.name, skill.description].some(value => value?.toLowerCase().includes(search))
    )
    const openSkillBuilder = (action: SkillEntryAction) => window.open(__APP_ENV__.BASE_URL + "/build/tools?c=skill&action=" + action, "_blank", "noopener");
    const { loading, refresh } = useMcpRefrensh()
    return (
        <Sheet onOpenChange={open => !open && setKeyword('')}>
            <SheetTrigger asChild>
                {children}
            </SheetTrigger>
            <SheetContent className="w-screen max-w-[1000px] sm:max-w-[min(100vw,1000px)]">
                <div className="flex h-full" onClick={e => e.stopPropagation()}>
                    <div className="w-40 shrink-0 p-3 sm:w-44 sm:p-4 lg:w-52 lg:p-5">
                        <SheetTitle>{t(onAddSkill ? 'build.tools' : 'build.addTool')}</SheetTitle>
                        <SearchInput value={keyword} placeholder={t('build.search')} onChange={(e) => setKeyword(e.target.value)} className={"mt-6"} />
                        <div className="mt-4">
                            <div
                                className={`flex items-center gap-2 px-4 py-2 rounded-md cursor-pointer hover:bg-muted-foreground/10 transition-all duration-200 ${type === 'default' && 'bg-muted-foreground/10'}`}
                                onClick={() => setType('default')}
                            >
                                <Outlined.PeopleRound />
                                <span>{t('tools.builtinTools')}</span>
                            </div>
                            <div
                                className={`flex items-center gap-2 px-4 py-2 rounded-md cursor-pointer hover:bg-muted-foreground/10 transition-all duration-200 mt-1 ${type === 'custom' && 'bg-muted-foreground/10'}`}
                                onClick={() => setType('custom')}
                            >
                                <Star />
                                <span>{t('tools.customTools')}</span>
                            </div>
                            <div
                                className={`mt-1 flex cursor-pointer items-center gap-2 rounded-md px-4 py-2 transition-all duration-200 hover:bg-muted-foreground/10 ${type === "mcp" && "bg-muted-foreground/10"
                                    }`}
                                onClick={() => setType("mcp")}
                            >
                                <CpuIcon />
                                <span>{t('tools.mcpTools')}</span>
                            </div>
                            {onAddSkill && <button type="button" className={`mt-1 flex w-full items-center gap-2 rounded-md px-4 py-2 hover:bg-muted-foreground/10 ${type === "skills" ? "bg-muted-foreground/10" : ""}`} onClick={() => setType("skills")}>
                                <Sparkles />{t("build.skill")}
                            </button>}
                        </div>
                    </div>
                    <div className={`min-w-0 flex-1 p-4 pt-10 h-full overflow-auto scrollbar-hide ${type === "skills" ? "bg-background-login" : "bg-background-main"}`}>
                        <div className="mb-4">
                            {type === 'custom' && <Button className="mt-4" onClick={() => window.open(__APP_ENV__.BASE_URL + "/build/tools?c=api")}>
                                {t('create')}{t("tools.createCustomTool")}
                            </Button>}
                            {type === 'mcp' && <Button className="mt-4" onClick={() => window.open(__APP_ENV__.BASE_URL + "/build/tools?c=mcp")}>
                                {t("tools.addMcpServer")}
                            </Button>}
                            {type === 'mcp' && <Button variant="outlined" disabled={loading} className="mt-4 ml-4" onClick={async () => {
                                    await refresh()
                                    loadMData()
                                }} color="default">
                                {loading && <Outlined.Loading className="animate-spin text-gray-800" />}
                                {t("tools.refresh")}
                            </Button>}
                        </div>
                        {type === "skills" ? <section>
                            <div className="mb-3 flex flex-wrap items-center gap-2">
                                <h3 className="text-base font-semibold">{t("build.skill")}</h3>
                                {canManageWorkbenchConfig(user) && <SkillAuthoringActions onUpload={() => openSkillBuilder("upload")} onCreate={() => openSkillBuilder("create")} />}
                            </div>
                            <div className="rounded-md border bg-background">
                                <Table className="table-fixed">
                                    <TableHeader><TableRow>
                                        <TableHead className="w-[39%]">{t("skillManage.columns.displayName")}</TableHead>
                                        <TableHead>{t("skillManage.columns.description")}</TableHead>
                                        <TableHead className="w-16">{t("build.operation")}</TableHead>
                                        <TableHead className="w-7" />
                                    </TableRow></TableHeader>
                                    <TableBody>
                                        {skillsLoading || skillsError || !matchingSkills.length ? (
                                            <TableRow><TableCell colSpan={4} className="py-10 text-center text-muted-foreground">
                                                {skillsLoading ? t("loading") : skillsError ? t("build.skillLoadFailed") : t("build.empty")}
                                            </TableCell></TableRow>
                                        ) : matchingSkills.map(skill => (
                                            <SkillTableRow key={skill.id} skill={skill} onDetail={() => setDetail(skill)}>
                                                <TableCell onClick={event => event.stopPropagation()}>
                                                    <Button size="small" variant="text" disabled={skillIds.includes(skill.id)} onClick={() => onAddSkill(skill.id)}>
                                                        {t(skillIds.includes(skill.id) ? "build.added" : "build.add")}
                                                    </Button>
                                                </TableCell>
                                            </SkillTableRow>
                                        ))}
                                    </TableBody>
                                </Table>
                            </div>
                        </section> : <Accordion type="single" collapsible className="w-full">
                            {
                                options.length ? options.map(el => (
                                    <ToolItem
                                        key={el.id}
                                        type={type === 'default' ? '' : type}
                                        select={select}
                                        data={el}
                                        onSelect={onSelect}
                                    ></ToolItem>
                                )) : <div className="pt-40 text-center text-sm text-muted-foreground mt-2">
                                    {t('build.empty')}
                                </div>
                            }
                        </Accordion>}
                    </div>
                </div>
                <Dialog open={Boolean(detail)} onOpenChange={open => !open && setDetail(null)}>
                    <DialogContent className="max-h-[80vh] overflow-y-auto" onClick={event => event.stopPropagation()}>
                        <DialogHeader>
                            <DialogTitle>{detail?.display_name}</DialogTitle>
                            <DialogDescription className="whitespace-pre-wrap break-words pt-3 text-left leading-relaxed">
                                {detail?.description}
                            </DialogDescription>
                        </DialogHeader>
                    </DialogContent>
                </Dialog>
            </SheetContent>
        </Sheet>
    );

};
