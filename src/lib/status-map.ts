import type { MessageStatus } from "./types";

export function mapStatus(
  state: string,
  externalCallState: string
): MessageStatus {
  if (externalCallState === "Failed") return "Failed";
  if (
    state === "OrderCancelled" ||
    state === "SentOrderCancel" ||
    state === "ClaimedOrderCancel"
  )
    return "Cancelled";
  if (
    externalCallState === "Cancelled" ||
    externalCallState === "OrderCancelled"
  )
    return "Cancelled";
  if (
    state === "Created" &&
    externalCallState === "AwaitingOrderFulfillment"
  )
    return "Awaiting Confirmation";
  if (state === "Created" && externalCallState === "AwaitingExecution")
    return "Awaiting Execution";
  if (
    ["Fulfilled", "SentUnlock", "ClaimedUnlock"].includes(state) &&
    ["Completed", "NoExtCall"].includes(externalCallState)
  )
    return "Executed";
  if (state === "Fulfilled" && externalCallState === "Executing")
    return "Executing";
  if (["Fulfilled", "SentUnlock", "ClaimedUnlock"].includes(state))
    return "Executed";
  return "Executing";
}
