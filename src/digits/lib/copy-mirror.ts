/**
 * Copy-trading bridge for the Digits app.
 *
 * After a Digits buy is confirmed by Deriv, the master's contract is reported to
 * the WickSentinel copy engine so connected followers mirror it. This is
 * best-effort and never blocks or fails the trade: the buy has already happened
 * on the master's account, and the server re-verifies the contract before
 * mirroring (see POST /api/copy-trading/mirror-on-buy).
 */

export interface CopyMirrorInput {
  accountId: string;
  symbol: string;
  contractType: string;
  contractFamily: string;
  direction?: string;
  duration: number;
  durationUnit: 's' | 'm' | 'h' | 'd' | 't';
  stake: number;
  basis: 'stake' | 'payout';
  currency: string;
  masterContractId: number;
  digit?: number;
  barrier?: string;
}

export async function reportCopyOnBuy(input: CopyMirrorInput): Promise<void> {
  try {
    await fetch('/api/copy-trading/mirror-on-buy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(input),
    });
  } catch {
    /* Copy is best-effort; a failed mirror must never affect the trade. */
  }
}