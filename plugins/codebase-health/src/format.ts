export function formatHours(hours: number | null): string {
  if (hours === null) return '–'
  if (hours < 1) return `${Math.round(hours * 60)}m`
  if (hours < 48) return `${hours.toFixed(1)}h`
  return `${(hours / 24).toFixed(1)}d`
}

export function formatShare(share: number | null): string {
  return share === null ? '–' : `${Math.round(share * 100)}%`
}

export function formatDecimal(value: number | null): string {
  return value === null ? '–' : value.toFixed(1)
}

export function formatDayLabel(day: string): string {
  const [year, month, dayOfMonth] = day.split('-').map(Number)
  if (!year || !month || !dayOfMonth) return day
  return new Date(year, month - 1, dayOfMonth).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function formatWeekdayLabel(day: string): string {
  const [year, month, dayOfMonth] = day.split('-').map(Number)
  if (!year || !month || !dayOfMonth) return day
  const weekday = new Date(year, month - 1, dayOfMonth).toLocaleDateString(undefined, { weekday: 'short' })
  return `${weekday} ${formatDayLabel(day)}`
}

export type Tone = 'better' | 'worse' | 'neutral'

export interface Badge {
  text: string
  tone: Tone
  arrow: '▲' | '▼' | null
}

/** "+1.2 vs all (2.0)": how far a team's figure is from the figure of every team, and whether that is good. */
export function deviationBadge(
  value: number | null,
  base: number | null,
  better: 'lower' | 'higher',
  formatGap: (gap: number) => string,
  formatBase: (base: number) => string = formatGap,
): Badge | null {
  if (value === null || base === null) return null
  const gap = value - base
  const shownGap = formatGap(Math.abs(gap))
  const text = `${gap < 0 ? '-' : '+'}${shownGap} vs all (${formatBase(base)})`
  if (shownGap === formatGap(0)) return { text, tone: 'neutral', arrow: null }
  const improved = better === 'lower' ? gap < 0 : gap > 0
  return { text, tone: improved ? 'better' : 'worse', arrow: gap > 0 ? '▲' : '▼' }
}
