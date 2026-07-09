import type { Hex } from "viem";

// The Tron base58 ↔ EVM-hex codecs live in deport/address-codec (the codec home); re-exported here so
// callers that think "Tron client" still find them.
export { evmHexFromTronBase58, tronBase58FromEvmHex } from "../deport/address-codec";

/**
 * Minimal Tron client for READ-ONLY gate calls.
 *
 * Tron's TVM runs the same Solidity `DeBridgeGate` bytecode as EVM, and TronGrid exposes an
 * Ethereum-compatible JSON-RPC `eth_call` (https://api.trongrid.io/jsonrpc). So we can call the exact
 * same `getDebridge(debridgeId)` view we use on EVM — viem just can't *drive* Tron (its addresses are
 * base58 and `gas`/`gasPrice` must be 0x0), hence this tiny hand-rolled transport.
 */

const TRON_RPC_URL = process.env.TRON_RPC_URL || "https://api.trongrid.io/jsonrpc";
/** deBridgeGate (DMP) on Tron — same contract, base58 address (per deBridge deployed-contracts). */
export const TRON_GATE_BASE58 = "TTGA4XQ419jodtFSMFiwYqfgG2uSLRBsnn";

interface JsonRpcResult {
  id: number;
  result?: string;
  error?: { message?: string };
}

/**
 * Batch `eth_call` (block "latest") against the Tron JSON-RPC. One HTTP request carries an array of calls;
 * `gas`/`gasPrice` are forced to `0x0` (Tron rejects non-zero). Returns the raw return-data hex per call,
 * or null for a call that errored. Throws only on a transport/HTTP failure (caller treats as best-effort).
 */
export async function tronEthCallBatch(to: Hex, dataList: Hex[]): Promise<(string | null)[]> {
  if (dataList.length === 0) return [];
  const body = dataList.map((data, i) => ({
    jsonrpc: "2.0",
    id: i,
    method: "eth_call",
    params: [{ to, data, gas: "0x0", gasPrice: "0x0" }, "latest"],
  }));
  const res = await fetch(TRON_RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`tron eth_call HTTP ${res.status}`);
  const json = (await res.json()) as JsonRpcResult[] | JsonRpcResult;
  const arr = Array.isArray(json) ? json : [json];
  const byId = new Map<number, JsonRpcResult>(arr.map((r) => [r.id, r]));
  return dataList.map((_, i) => {
    const r = byId.get(i);
    return r && !r.error && r.result ? r.result : null;
  });
}
