/**
 * Pays the homepage invoice from the demo agent's own wallet, with the Cookie Tab memo, exactly as
 * cookie-mcp's `transfer` would build it. Spends real money. Run by hand, never from CI.
 *
 *   npx tsx scripts/agent-pay.ts --dry-run
 *   npx tsx scripts/agent-pay.ts
 *
 * This exists because the Claude Code permission classifier blocks an outbound payment from any
 * session, so the tool call an agent would make cannot be completed inside that harness. The
 * transaction this builds is the same one: a TransferChecked of the invoice amount to the jar, an
 * idempotent create for its token account, and an SPL Memo carrying the reference.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

import { getConnection, signatureOutcome } from "../src/lib/chain";
import { MEMO_PROGRAM_ID, explorerTxUrl } from "../src/lib/config";
import { rawToUi } from "../src/lib/format";
import { fetchJarHistory } from "../src/lib/history";
import { paymentsForRef } from "../src/lib/reconcile";
import { buildMemo } from "../src/lib/request";
import {
  SHOWCASE_AMOUNT,
  SHOWCASE_DECIMALS,
  SHOWCASE_JAR,
  SHOWCASE_MINT,
  SHOWCASE_NOTE,
} from "../src/lib/showcase";

const DRY_RUN = process.argv.includes("--dry-run");
const REF = "AGENT-DEMO";
const MINT = new PublicKey(SHOWCASE_MINT);
const JAR = new PublicKey(SHOWCASE_JAR);
const RAW = BigInt(SHOWCASE_AMOUNT) * 10n ** BigInt(SHOWCASE_DECIMALS);

async function main(): Promise<void> {
  const keyPath = path.join(os.homedir(), ".config/superteam/agent-demo-wallet.json");
  const agent = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(keyPath, "utf8")) as number[]));
  const connection = getConnection();
  console.log(`paying as ${agent.publicKey.toBase58()}`);

  const from = getAssociatedTokenAddressSync(MINT, agent.publicKey);
  const to = getAssociatedTokenAddressSync(MINT, JAR, true);
  const memo = buildMemo({ to: SHOWCASE_JAR, ref: REF, note: SHOWCASE_NOTE });
  console.log(`memo ${memo}`);
  console.log(`amount ${rawToUi(RAW, SHOWCASE_DECIMALS)} to ${SHOWCASE_JAR}`);

  const tx = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(agent.publicKey, to, JAR, MINT),
    createTransferCheckedInstruction(from, MINT, to, agent.publicKey, RAW, SHOWCASE_DECIMALS),
    new TransactionInstruction({
      programId: MEMO_PROGRAM_ID,
      keys: [{ pubkey: agent.publicKey, isSigner: true, isWritable: false }],
      data: Buffer.from(memo, "utf8"),
    }),
  );
  tx.feePayer = agent.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;

  const simulated = await connection.simulateTransaction(tx);
  if (simulated.value.err) throw new Error(`would fail: ${JSON.stringify(simulated.value.err)}`);
  console.log(`simulates clean, ${tx.instructions.length} instructions, 1 signature`);

  if (DRY_RUN) {
    console.log("DRY-RUN: nothing sent");
    return;
  }

  const signature = await connection.sendTransaction(tx, [agent]);
  console.log(`sent ${signature}`);
  console.log(explorerTxUrl(signature));
  const landed = await signatureOutcome(connection, signature);
  if (landed.err) throw new Error(`landed and failed: ${JSON.stringify(landed.err)}`);

  const history = await fetchJarHistory(connection, JAR, 50);
  const rows = paymentsForRef(history.payments, REF);
  const mine = rows.find((p) => p.signature === signature);
  console.log(`jar reads ${REF}: ${rows.length} payment(s); this one ${mine ? "listed" : "NOT LISTED"}`);
  if (!mine) process.exit(1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
