import type { Db } from "@mkt/db";
import { release, reserve, settle, type ReserveInput, type SettleInput } from "./ledger.ts";

export interface PaidResult<T> extends SettleInput {
  result: T;
}

/** Thrown by `execute` when the provider billed something before failing (partial output is billed). */
export class BilledFailure extends Error {
  constructor(
    readonly billed: SettleInput,
    readonly original: unknown,
  ) {
    super(original instanceof Error ? original.message : String(original));
    this.name = "BilledFailure";
  }
}

/**
 * Every paid call goes through here (§7.1): reserve the estimate, call, then settle the actual cost.
 * A plain throw releases the reservation. A BilledFailure settles what was billed and rethrows the original error.
 */
export async function runPaidCall<T>(
  db: Db,
  input: ReserveInput,
  execute: (callId: string) => Promise<PaidResult<T>>,
): Promise<T> {
  const callId = await reserve(db, input);
  let out: PaidResult<T>;
  try {
    out = await execute(callId);
  } catch (err) {
    if (err instanceof BilledFailure) {
      await settle(db, callId, err.billed);
      throw err.original;
    }
    await release(db, callId, err instanceof Error ? err.message : String(err));
    throw err;
  }
  const { result, ...billed } = out;
  await settle(db, callId, billed);
  return result;
}
