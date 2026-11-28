import { describe, expect, it } from "vitest"

import { normalizeRoleMenuSelection } from "@/pages/SystemPage/components/roleMenuSelection"

describe("normalizeRoleMenuSelection", () => {
  it("retains independent company pages while requiring monitoring for its write permissions", () => {
    expect(normalizeRoleMenuSelection(["company_leadboard", "company_board_ledger", "company_board_feedback"]))
      .toEqual(["company_leadboard"])
    expect(normalizeRoleMenuSelection(["company_monitorboard", "company_board_ledger", "company_board_feedback"]))
      .toEqual(["company_monitorboard", "company_board_ledger", "company_board_feedback"])
  })

  it("maps legacy area aliases to the menu options shown by the editor", () => {
    expect(
      normalizeRoleMenuSelection([
        "frontend",
        "home",
        "apps",
        "backend",
        "build",
        "knowledge",
      ]),
    ).toEqual(["workstation", "home", "apps", "admin", "build", "knowledge"])
  })

  it("drops legacy and unknown API values from the saved UI selection", () => {
    expect(
      normalizeRoleMenuSelection([
        "workstation",
        "home",
        "backend_only_permission",
        "system_config",
        "frontend",
      ]),
    ).toEqual(["workstation", "home"])
  })

  it("removes admin permissions when the admin parent is switched off", () => {
    expect(
      normalizeRoleMenuSelection([
        "workstation",
        "home",
        "build",
        "create_app",
        "knowledge",
        "create_knowledge",
      ]),
    ).toEqual(["workstation", "home"])
  })

  it("removes nested permissions when their visible parent option is off", () => {
    expect(
      normalizeRoleMenuSelection([
        "workstation",
        "linsight_task_mode",
        "admin",
        "create_app",
        "create_knowledge",
      ]),
    ).toEqual(["workstation", "admin"])
  })
})
