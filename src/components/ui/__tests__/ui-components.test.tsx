import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { LoadingSpinner } from "../loading-spinner";
import { ErrorState } from "../error-state";
import { EmptyState } from "../empty-state";
import { Skeleton, TableSkeleton, CardGridSkeleton } from "../skeleton";

describe("LoadingSpinner", () => {
  it("renders", () => {
    const { container } = render(<LoadingSpinner />);
    expect(container.querySelector(".animate-spin")).toBeTruthy();
  });
});

describe("Skeleton", () => {
  it("renders a pulsing block with composed classes", () => {
    const { container } = render(<Skeleton className="h-4 w-12" />);
    const el = container.querySelector(".animate-pulse");
    expect(el).toBeTruthy();
    expect(el?.className).toContain("h-4");
    expect(el?.className).toContain("w-12");
  });
});

describe("TableSkeleton", () => {
  it("renders the real headers over the requested number of shimmer rows", () => {
    const { container } = render(<TableSkeleton columns={["#", "Token", "Net %"]} rows={5} />);
    expect(screen.getByText("Token")).toBeTruthy();
    expect(container.querySelectorAll("tbody tr")).toHaveLength(5);
    expect(container.querySelector("[aria-busy='true']")).toBeTruthy();
  });
});

describe("CardGridSkeleton", () => {
  it("renders the requested number of placeholder cards", () => {
    const { container } = render(<CardGridSkeleton count={4} />);
    expect(container.querySelector("[aria-busy='true']")?.children).toHaveLength(4);
    expect(container.querySelectorAll(".animate-pulse").length).toBeGreaterThan(0);
  });
});

describe("ErrorState", () => {
  it("renders with default message", () => {
    render(<ErrorState />);
    expect(screen.getByText("Error")).toBeTruthy();
  });

  it("renders custom message and retry button", () => {
    render(<ErrorState title="Oops" message="Try again" onRetry={() => {}} />);
    expect(screen.getByText("Oops")).toBeTruthy();
    expect(screen.getByText("Try again")).toBeTruthy();
    expect(screen.getByText("Retry")).toBeTruthy();
  });
});

describe("EmptyState", () => {
  it("renders with default title", () => {
    render(<EmptyState />);
    expect(screen.getByText("No data found")).toBeTruthy();
  });

  it("renders custom title and message", () => {
    render(<EmptyState title="No messages" message="Try different filters" />);
    expect(screen.getByText("No messages")).toBeTruthy();
    expect(screen.getByText("Try different filters")).toBeTruthy();
  });
});
