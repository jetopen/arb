import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ScanStatus } from "../scan-status";
import type { ScanRunInfo } from "@/lib/hooks";

const GATE_MS = 3 * 60 * 60 * 1000; // mirror DEFAULT_OPP_MAX_AGE_MS

function run(finishedAt: number): ScanRunInfo {
  return { startedAt: finishedAt - 60_000, finishedAt, unitsProcessed: 48, quotesSpent: 96, opportunitiesFound: 3, partial: false };
}

describe("ScanStatus staleness alarm", () => {
  it("shows no stale pill while the last scan is inside the gate", () => {
    render(<ScanStatus lastScan={run(Date.now() - 5 * 60_000)} gateMs={GATE_MS} />);
    expect(screen.queryByText(/scanner stale/)).toBeNull();
  });

  it("shows the amber stale pill + amber Last-scan stat once the gate is exceeded", () => {
    const { container } = render(<ScanStatus lastScan={run(Date.now() - GATE_MS - 60_000)} gateMs={GATE_MS} />);
    const pill = screen.getByText(/scanner stale — last scan/);
    expect(pill.className).toContain("bg-amber-100");
    // the Last-scan stat value flips to the amber alarm style
    expect(container.querySelector(".text-amber-600")).toBeTruthy();
  });

  it("never alarms when the gate is disabled (gateMs <= 0) or absent", () => {
    const old = run(Date.now() - 24 * 60 * 60 * 1000);
    const { rerender } = render(<ScanStatus lastScan={old} gateMs={0} />);
    expect(screen.queryByText(/scanner stale/)).toBeNull();
    rerender(<ScanStatus lastScan={old} />);
    expect(screen.queryByText(/scanner stale/)).toBeNull();
  });

  it("no alarm when lastScan is absent (fresh in-memory store shows the em dash)", () => {
    render(<ScanStatus lastScan={null} gateMs={GATE_MS} />);
    expect(screen.queryByText(/scanner stale/)).toBeNull();
    // both the RPM-free and Last-scan stats render the em dash when their data is absent
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });
});
