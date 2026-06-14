import { NextRequest, NextResponse } from "next/server";
import { fetchMessages, fetchChains, fetchStatistics } from "@/lib/api-client";
import type { OrderFilterRequest } from "@/lib/types";

const cache = new Map<string, { data: unknown; expiry: number }>();
const CACHE_TTL = 10_000;

function getCached<T>(key: string): T | null {
  const entry = cache.get(key);
  if (entry && Date.now() < entry.expiry) return entry.data as T;
  cache.delete(key);
  return null;
}

function setCache(key: string, data: unknown) {
  cache.set(key, { data, expiry: Date.now() + CACHE_TTL });
}

const STATUS_TO_STATES: Record<string, { orderStates: string[]; externalCallStates: string[] }> = {
  "Awaiting Confirmation": {
    orderStates: ["Created"],
    externalCallStates: ["AwaitingOrderFulfillment"],
  },
  "Awaiting Execution": {
    orderStates: ["Created"],
    externalCallStates: ["AwaitingExecution"],
  },
  Executing: {
    orderStates: ["Fulfilled"],
    externalCallStates: ["Executing"],
  },
  Executed: {
    orderStates: ["Fulfilled", "SentUnlock", "ClaimedUnlock"],
    externalCallStates: ["Completed", "NoExtCall"],
  },
  Cancelled: {
    orderStates: ["OrderCancelled", "SentOrderCancel", "ClaimedOrderCancel"],
    externalCallStates: ["Cancelled", "OrderCancelled"],
  },
  Failed: {
    orderStates: [],
    externalCallStates: ["Failed"],
  },
};

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const page = parseInt(searchParams.get("page") ?? "1", 10);
    const take = Math.min(parseInt(searchParams.get("take") ?? "50", 10), 100);
    const skip = (page - 1) * take;
    const chainFrom = searchParams.get("chainFrom");
    const chainTo = searchParams.get("chainTo");
    const status = searchParams.get("status");
    const dateFrom = searchParams.get("dateFrom");
    const dateTo = searchParams.get("dateTo");

    const filter: OrderFilterRequest = {
      skip,
      take,
      filterMode: "CrossChain",
    };

    if (chainFrom) {
      filter.giveChainIds = chainFrom.split(",").map(Number).filter(Boolean);
    }
    if (chainTo) {
      filter.takeChainIds = chainTo.split(",").map(Number).filter(Boolean);
    }
    if (dateFrom) {
      filter.blockTimestampFrom = Math.floor(new Date(dateFrom).getTime() / 1000);
    }
    if (dateTo) {
      filter.blockTimestampTo = Math.floor(new Date(dateTo).getTime() / 1000);
    }
    if (status && STATUS_TO_STATES[status]) {
      const mapping = STATUS_TO_STATES[status];
      if (mapping.orderStates.length > 0) filter.orderStates = mapping.orderStates;
      if (mapping.externalCallStates.length > 0) filter.externalCallStates = mapping.externalCallStates;
    }

    const cacheKey = `messages:${JSON.stringify(filter)}`;
    const cached = getCached<{ messages: unknown[]; total: number }>(cacheKey);
    if (cached) {
      return NextResponse.json(cached);
    }

    const result = await fetchMessages(filter);
    setCache(cacheKey, result);

    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
