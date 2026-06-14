import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { LoadingSpinner } from "../loading-spinner";
import { ErrorState } from "../error-state";
import { EmptyState } from "../empty-state";

describe("LoadingSpinner", () => {
  it("renders", () => {
    const { container } = render(<LoadingSpinner />);
    expect(container.querySelector(".animate-spin")).toBeTruthy();
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
