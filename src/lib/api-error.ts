import { NextResponse } from "next/server";

/**
 * Standard 500 for API route catch blocks. Logs the REAL error server-side (platform logs) but returns a
 * GENERIC body to the client. The routes are unauthenticated on a public app, so echoing `error.message`
 * verbatim leaked internal detail — e.g. SupabaseStore prefixes failures with the RPC/table name, and the
 * DB client throws a config-hint message. `context` labels which handler failed in the logs.
 */
export function errorResponse(error: unknown, context: string): NextResponse {
  console.error(`[api:${context}]`, error instanceof Error ? (error.stack ?? error.message) : error);
  return NextResponse.json({ error: "internal server error" }, { status: 500 });
}
