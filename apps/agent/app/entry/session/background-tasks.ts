import type { BackgroundKind } from "memory-agent";
import { t } from "@lingui/core/macro";

/** What kind of background job a task is, in the UI's words. */
export const backgroundKindLabel = (kind: BackgroundKind) =>
  kind === "external_agent"
    ? t({
        message: "외부 에이전트",
        comment: "Kind of background job: a turn of an external coding agent",
      })
    : t({ message: "스킬", comment: "Kind of background job: a run of a project code skill" });
