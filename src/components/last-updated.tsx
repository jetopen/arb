"use client";

import { useState, useEffect } from "react";

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

    function update() {
      const seconds = Math.floor((Date.now() - lastFetched!) / 1000);
      if (seconds < 5) setAgo("just now");
      else if (seconds < 60) setAgo(`${seconds}s ago`);
      else if (seconds < 3600) setAgo(`${Math.floor(seconds / 60)}m ago`);
      else setAgo(`${Math.floor(seconds / 3600)}h ago`);
    }

    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [lastFetched]);

  if (!lastFetched) return null;

  return (
    <span className="text-xs text-muted">
      Updated {ago}
    </span>
  );
}
