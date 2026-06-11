import { z } from "zod";
import type { Stagehand } from "@browserbasehq/stagehand";
import { PAGE_STATES, type PageState } from "../shared/types.js";
import type { Emit } from "./emit.js";

const classificationSchema = z.object({
  pageState: z.enum(PAGE_STATES),
});

// One cheap extract pass after every navigation / major action. Emits
// PageObserved always, plus ChallengeDetected / RestrictionDetected on signals.
export async function classifyPage(
  stagehand: Stagehand,
  emit: Emit,
  actionId?: string,
): Promise<PageState> {
  const { pageState } = await stagehand.extract(
    "Classify the current page state. normal: regular content page. login: a login wall or sign-in form blocks the content. captcha: a CAPTCHA or human-verification challenge is shown. checkpoint: a security checkpoint/verification step is shown. restriction_notice: an account restriction, suspension or ban notice is shown. error_page: an HTTP error or broken page. unknown: none of the above can be determined.",
    classificationSchema,
  );
  await emit("PageObserved", { pageState }, actionId);
  if (pageState === "captcha" || pageState === "checkpoint") {
    await emit("ChallengeDetected", { pageState }, actionId);
  } else if (pageState === "restriction_notice") {
    await emit("RestrictionDetected", { pageState }, actionId);
  }
  return pageState;
}
