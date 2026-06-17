// One-off investigation: why do MegaETH (100000031) / Tron (100000026) reps never enqueue, and what state
// are the Tron addresses in? Read-only. Prints, writes nothing.
import nextEnv from "@next/env";
try { nextEnv?.loadEnvConfig?.(process.cwd(), true); } catch {}
import { createClient } from "@supabase/supabase-js";

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const QUOTABLE = new Set([1, 10, 56, 137, 8453, 42161, 43114, 59144, 100000019, 100000023, 100000022, 100000026, 100000027, 100000009, 100000030, 100000031, 7565164]);
const TARGETS = { 100000031: "MegaETH", 100000026: "Tron", 100000027: "Sei", 100000009: "Flow", 100000030: "Monad" };

(async () => {
  const { data: fams, error } = await db.from("arb_families").select("debridge_id,native_chain_id,decimals,reps");
  if (error) { console.error(error.message); process.exit(1); }
  console.log(`arb_families total: ${fams.length}`);

  for (const [idStr, name] of Object.entries(TARGETS)) {
    const id = Number(idStr);
    const withRep = fams.filter((f) => (f.reps || []).some((r) => Number(r.internalChainId) === id));
    console.log(`\n=== ${name} (${id}): ${withRep.length} families have a rep here ===`);
    let nativeNotQuotable = 0, famDecUndef = 0, repDecUndef = 0, shouldEnqueue = 0;
    for (const f of withRep) {
      const rep = (f.reps || []).find((r) => Number(r.internalChainId) === id);
      const nativeQuotable = QUOTABLE.has(Number(f.native_chain_id));
      const famDec = f.decimals != null;
      const repDec = rep && Number.isInteger(rep.decimals);
      if (!nativeQuotable) nativeNotQuotable++;
      if (!famDec) famDecUndef++;
      if (!repDec) repDecUndef++;
      if (nativeQuotable && famDec && repDec) shouldEnqueue++;
    }
    console.log(`  native NOT quotable: ${nativeNotQuotable} | family.decimals undef: ${famDecUndef} | rep.decimals undef: ${repDecUndef} | SHOULD enqueue: ${shouldEnqueue}`);
    // show up to 4 examples
    for (const f of withRep.slice(0, 4)) {
      const rep = (f.reps || []).find((r) => Number(r.internalChainId) === id);
      console.log(`  - dbId=${String(f.debridge_id).slice(0, 12)}… native=${f.native_chain_id}(quotable=${QUOTABLE.has(Number(f.native_chain_id))}) famDec=${f.decimals} rep={addr=${String(rep?.address).slice(0, 18)}…, dec=${rep?.decimals}, sym=${rep?.symbol}}`);
    }
  }

  // Tron address corruption check: are stored Tron reps lowercased base58 (start with lowercase t)?
  const tronReps = [];
  for (const f of fams) for (const r of f.reps || []) if (Number(r.internalChainId) === 100000026) tronReps.push(r.address);
  const lowered = tronReps.filter((a) => typeof a === "string" && /^t[a-z0-9]/.test(a)); // lowercase 't' => corrupted
  const proper = tronReps.filter((a) => typeof a === "string" && /^T[A-Za-z0-9]/.test(a)); // proper 'T…'
  console.log(`\n=== Tron address case ===\n  reps: ${tronReps.length} | proper T…: ${proper.length} | lowercased (corrupted): ${lowered.length}`);
  console.log(`  samples: ${tronReps.slice(0, 5).join(", ")}`);

  // Work queue: any rows touching MegaETH/Tron?
  const { count: mega } = await db.from("arb_work_queue").select("id", { count: "exact", head: true }).or("buy_chain_id.eq.100000031,sell_chain_id.eq.100000031");
  const { count: tron } = await db.from("arb_work_queue").select("id", { count: "exact", head: true }).or("buy_chain_id.eq.100000026,sell_chain_id.eq.100000026");
  console.log(`\n=== work queue ===\n  rows touching MegaETH: ${mega} | Tron: ${tron}`);
  process.exit(0);
})().catch((e) => { console.error(e?.stack ?? e); process.exit(1); });
