import { describe, it, expect } from "vitest";
import { mapStatus } from "../status-map";

describe("mapStatus", () => {
  it("maps Created + AwaitingOrderFulfillment to Awaiting Confirmation", () => {
    expect(mapStatus("Created", "AwaitingOrderFulfillment")).toBe(
      "Awaiting Confirmation"
    );
  });

  it("maps Created + AwaitingExecution to Awaiting Execution", () => {
    expect(mapStatus("Created", "AwaitingExecution")).toBe(
      "Awaiting Execution"
    );
  });

  it("maps Fulfilled + Completed to Executed", () => {
    expect(mapStatus("Fulfilled", "Completed")).toBe("Executed");
  });

  it("maps SentUnlock + NoExtCall to Executed", () => {
    expect(mapStatus("SentUnlock", "NoExtCall")).toBe("Executed");
  });

  it("maps ClaimedUnlock + Completed to Executed", () => {
    expect(mapStatus("ClaimedUnlock", "Completed")).toBe("Executed");
  });

  it("maps Fulfilled + Executing to Executing", () => {
    expect(mapStatus("Fulfilled", "Executing")).toBe("Executing");
  });

  it("maps OrderCancelled + Cancelled to Cancelled", () => {
    expect(mapStatus("OrderCancelled", "Cancelled")).toBe("Cancelled");
  });

  it("maps SentOrderCancel + OrderCancelled to Cancelled", () => {
    expect(mapStatus("SentOrderCancel", "OrderCancelled")).toBe("Cancelled");
  });

  it("maps any state + Failed to Failed", () => {
    expect(mapStatus("Created", "Failed")).toBe("Failed");
    expect(mapStatus("Fulfilled", "Failed")).toBe("Failed");
  });

  it("defaults to Executing for unknown combos", () => {
    expect(mapStatus("Created", "NoExtCall")).toBe("Executing");
  });
});
