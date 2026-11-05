export const money = (usd: number) => `$${usd.toFixed(2)}`

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB'] as const

export function bytes(size: number): string {
  let value = size
  let unit = 0
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${BYTE_UNITS[unit]}`
}
