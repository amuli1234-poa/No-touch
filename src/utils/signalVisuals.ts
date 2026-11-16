/**
 * Shared presentation helpers for signal score/tone colouring, so every AI view renders the
 * same score and tone semantics instead of re-implementing the thresholds.
 */

export function scoreColor(score: number): string {
  if (score >= 92) return 'text-emerald-400';
  if (score >= 85) return 'text-accent';
  if (score >= 70) return 'text-warn';
  return 'text-muted';
}

export function toneClass(tone: 'bull' | 'bear' | 'warn' | 'neutral'): string {
  if (tone === 'bull') return 'text-emerald-400';
  if (tone === 'bear') return 'text-bear';
  if (tone === 'warn') return 'text-warn';
  return 'text-muted';
}
