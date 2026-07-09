// Live verification for the tx-simulation subsystem (read-only; writes nothing).
//
//  1. deBridge /v1.0/chain/transaction — confirm it returns executable {to,data,value} (and WHICH host).
//  2. ERC20 storage-slot probe + state-override eth_call — confirm a known-good EVM swap simulates to PASS.
//  3. getDebridge read — confirm the claim-precheck inputs (balance/maxAmount/exist) are readable.
//
// Run: node scripts/probe-build-endpoints.mjs
import {
  createPublicClient,
  http,
  encodeFunctionData,
  keccak256,
  concat,
  pad,
  toHex,
} from "viem";

const ARB_RPC = process.env.RPC_URL_42161 || "https://arbitrum-one-rpc.publicnode.com";
const USDC = "0xaf88d065e77c8cc2239327c5edb3a432268e5831"; // Arbitrum native USDC (6dp)
const USDT = "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9"; // Arbitrum USDT (6dp)
const SENDER = "0x000000000000000000000000000000000000a11c"; // lowercase: viem rejects bad-checksum mixed case
const AMOUNT = "100000000"; // 100 USDC
const GATE = "0x43dE2d77BF8027e25dBD179B491e8d64f38398aA";

const BAL_ABI = [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] }];
const ALLOW_ABI = [{ type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "o", type: "address" }, { name: "s", type: "address" }], outputs: [{ type: "uint256" }] }];
const SPENDER_PROBE = "0x000000000000000000000000000000000000c0de";
// 2^128-1 with the top bit clear (USDC FiatTokenV2.2 packs the blacklist flag into bit 255 of the balance slot).
const BIG = pad(toHex((1n << 128n) - 1n), { size: 32 });
const GATE_ABI = [{
  type: "function", name: "getDebridge", stateMutability: "view",
  inputs: [{ name: "debridgeId", type: "bytes32" }],
  outputs: [
    { name: "chainId", type: "uint256" }, { name: "maxAmount", type: "uint256" }, { name: "balance", type: "uint256" },
    { name: "lockedInStrategies", type: "uint256" }, { name: "tokenAddress", type: "address" },
    { name: "minReservesBps", type: "uint16" }, { name: "exist", type: "bool" },
  ],
}];

const client = createPublicClient({ transport: http(ARB_RPC) });

async function tryBuild(host) {
  const url = `${host}/v1.0/chain/transaction?chainId=42161&tokenIn=${USDC}&tokenInAmount=${AMOUNT}&tokenOut=${USDT}&senderAddress=${SENDER}&tokenOutRecipient=${SENDER}&slippage=auto`;
  try {
    const r = await fetch(url, { headers: { Accept: "application/json" } });
    const j = await r.json().catch(() => ({}));
    return { host, status: r.status, ok: r.ok, tx: j.tx, out: j.estimation?.tokenOut?.amount };
  } catch (e) {
    return { host, error: String(e?.message ?? e) };
  }
}

function balKey(holder, slot, vyper) {
  const k = pad(holder, { size: 32 });
  const s = pad(toHex(slot), { size: 32 });
  return keccak256(vyper ? concat([s, k]) : concat([k, s]));
}
function allowKey(owner, spender, slot, vyper) {
  const inner = balKey(owner, slot, vyper);
  const sp = pad(spender, { size: 32 });
  return keccak256(vyper ? concat([inner, sp]) : concat([sp, inner]));
}

async function probeBalanceSlot(token) {
  const read = encodeFunctionData({ abi: BAL_ABI, functionName: "balanceOf", args: [SENDER] });
  const sentinel = pad(toHex(0x1234abcdn), { size: 32 });
  for (const slot of [0, 1, 2, 9, 3, 4, 5, 6, 7, 8, 10, 11, 51]) {
    for (const vyper of [false, true]) {
      const key = balKey(SENDER, slot, vyper);
      try {
        const { data } = await client.call({ to: token, data: read, stateOverride: [{ address: token, stateDiff: [{ slot: key, value: sentinel }] }] });
        if (data && BigInt(data) === 0x1234abcdn) return { slot, vyper };
      } catch {}
    }
  }
  return null;
}

async function probeAllowanceSlot(token) {
  const read = encodeFunctionData({ abi: ALLOW_ABI, functionName: "allowance", args: [SENDER, SPENDER_PROBE] });
  const sentinel = pad(toHex(0x1234abcdn), { size: 32 });
  for (const slot of [0, 1, 2, 9, 3, 4, 5, 6, 7, 8, 10, 11, 51]) {
    for (const vyper of [false, true]) {
      const key = allowKey(SENDER, SPENDER_PROBE, slot, vyper);
      try {
        const { data } = await client.call({ to: token, data: read, stateOverride: [{ address: token, stateDiff: [{ slot: key, value: sentinel }] }] });
        if (data && BigInt(data) === 0x1234abcdn) return { slot, vyper };
      } catch {}
    }
  }
  return null;
}

(async () => {
  console.log("== 1. deBridge /v1.0/chain/transaction (host probe) ==");
  for (const host of ["https://dln.debridge.finance", "https://dln-api.debridge.finance"]) {
    const b = await tryBuild(host);
    console.log(`  ${host} → status=${b.status ?? b.error} hasTx=${!!b.tx} to=${b.tx?.to?.slice(0, 12) ?? "—"} out=${b.out ?? "—"}`);
  }

  console.log("\n== 2. EVM swap sim (slot probe + state-override eth_call) ==");
  const built = await tryBuild("https://dln.debridge.finance");
  if (!built.tx?.to) {
    console.log("  no tx from primary host; retry dln-api…");
  }
  const tx = built.tx?.to ? built.tx : (await tryBuild("https://dln-api.debridge.finance")).tx;
  if (!tx?.to) {
    console.log("  ✗ could not build a tx on either host — cannot sim");
  } else {
    const balSlot = await probeBalanceSlot(USDC);
    const allowSlot = await probeAllowanceSlot(USDC);
    console.log(`  USDC balance slot: ${balSlot ? `${balSlot.slot} (${balSlot.vyper ? "vyper" : "solidity"})` : "UNRESOLVED"}`);
    console.log(`  USDC allowance slot: ${allowSlot ? `${allowSlot.slot} (${allowSlot.vyper ? "vyper" : "solidity"})` : "UNRESOLVED"}`);
    if (balSlot && allowSlot) {
      const overrides = [
        { address: SENDER, balance: 10n ** 24n },
        {
          address: USDC,
          stateDiff: [
            { slot: balKey(SENDER, balSlot.slot, balSlot.vyper), value: BIG },
            { slot: allowKey(SENDER, tx.to, allowSlot.slot, allowSlot.vyper), value: BIG },
          ],
        },
      ];
      try {
        await client.call({ account: SENDER, to: tx.to, data: tx.data, value: tx.value ? BigInt(tx.value) : undefined, stateOverride: overrides });
        console.log("  ✓ eth_call PASSED — balance + direct allowance override is sufficient for DeBridgeRouter");
      } catch (e) {
        const msg = (e?.shortMessage ?? e?.message ?? String(e)).slice(0, 200);
        console.log(`  eth_call reverted: ${msg}`);
        if (/allowance|permit|transfer.*amount|st[a]?f/i.test(msg)) {
          console.log("    ⚠ looks allowance-related → DeBridgeRouter may pull via Permit2 (direct allowance");
          console.log("      override insufficient). The in-app sim would need a Permit2 storage override too.");
        }
      }
    }
  }

  console.log("\n== 3. getDebridge read (claim-precheck inputs) ==");
  // USDC-on-Arbitrum debridgeId = keccak256(abi.encodePacked(uint256 nativeChainId, bytes nativeAddress)).
  const dbId = keccak256(concat([pad(toHex(42161n), { size: 32 }), USDC]));
  try {
    const res = await client.readContract({ address: GATE, abi: GATE_ABI, functionName: "getDebridge", args: [dbId] });
    console.log(`  exist=${res[6]} maxAmount=${res[1]} balance=${res[2]} locked=${res[3]} minReservesBps=${res[5]}`);
  } catch (e) {
    console.log(`  read failed: ${(e?.shortMessage ?? e?.message ?? String(e)).slice(0, 160)}`);
  }
  console.log("\nDone.");
})().catch((e) => { console.error(e?.stack ?? e); process.exit(1); });
