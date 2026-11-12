/**
 * PathTouchProbability Engine
 * Calculates continuous path excursion touch risk using first-passage Brownian motion.
 * Unlike terminal closing price options, No Touch options lose instantly if price
 * touches the barrier at ANY point during duration T.
 */
export class PathTouchProbability {
  /**
   * High-accuracy approximation of Standard Normal Cumulative Distribution Function (CDF)
   * Formula by Abramowitz and Stegun (Handbook of Mathematical Functions)
   */
  public static standardNormalCDF(x: number): number {
    const isNegative = x < 0;
    const absX = Math.abs(x);

    const b1 = 0.319381530;
    const b2 = -0.356563782;
    const b3 = 1.781477937;
    const b4 = -1.821255978;
    const b5 = 1.330274429;
    const p = 0.2316419;
    const c2 = 0.3989422804014327; // 1 / sqrt(2 * PI)

    const t = 1.0 / (1.0 + p * absX);
    const pdf = c2 * Math.exp(-0.5 * absX * absX);
    const poly = ((((b5 * t + b4) * t + b3) * t + b2) * t + b1) * t;
    const cdf = 1.0 - pdf * poly;

    return isNegative ? 1.0 - cdf : cdf;
  }

  /**
   * First-passage touch probability estimation for a continuous Brownian excursion over duration T (seconds).
   * Formula:
   *   Survival probability = 2 * Phi(B / (sigma * sqrt(T))) - 1
   *   Touch probability = 1 - Survival = 2 * [1 - Phi(B / (sigma * sqrt(T)))]
   *
   * @param distance Absolute distance between current price and barrier level
   * @param perSecondVolatility Realized volatility in price units per sqrt(second)
   * @param durationSeconds Total contract duration in seconds
   * @returns Touch probability between 0.0 and 1.0
   */
  public static calculateTouchRisk(
    distance: number,
    perSecondVolatility: number,
    durationSeconds: number
  ): number {
    if (distance <= 0 || durationSeconds <= 0) return 1.0;
    if (perSecondVolatility <= 0) return 0.0;

    const diffusion = perSecondVolatility * Math.sqrt(durationSeconds);
    if (diffusion <= 0) return 0.0;

    const z = distance / diffusion;
    const phi = this.standardNormalCDF(z);

    // Reflection principle for Brownian motion maximum excursion
    const survivalProb = Math.max(0, Math.min(1.0, 2 * phi - 1));
    const touchProb = Math.max(0, Math.min(1.0, 1.0 - survivalProb));

    return touchProb;
  }
}
