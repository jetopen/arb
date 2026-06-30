"use client";

import { useState, useEffect } from "react";
import { timeAgo } from "@/lib/time";

interface LastUpdatedProps {
  lastFetched?: number;
}

export function LastUpdated({ lastFetched }: LastUpdatedProps) {
  const [ago, setAgo] = useState("");

  useEffect(() => {
    if (!lastFetched) {
      setAgo("—");
      return;
    }
    const update = () => setAgo(timeAgo(lastFetched));
    update();
    const timer = setInterval(update, 1000); // tick the relative label every second
    return () => clearInterval(timer);
  }, [lastFetched]);

  if (!lastFetched) return null;

  return (
    <span className="text-xs text-muted">
      Updated {ago}
    </span>
  );
}
