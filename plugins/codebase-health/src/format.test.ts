import { describe, expect, it } from 'vitest'
import { deviationBadge, formatDecimal } from './format'

describe('deviationBadge', () => {
  it('marks a figure that is lower than all teams as better when lower is better', () => {
    expect(deviationBadge(1, 1.5, 'lower', formatDecimal)).toEqual({ text: '-0.5 vs all (1.5)', tone: 'better', arrow: '▼' })
    expect(deviationBadge(3, 1.5, 'lower', formatDecimal)).toEqual({ text: '+1.5 vs all (1.5)', tone: 'worse', arrow: '▲' })
  })

  it('marks a figure that is higher than all teams as better when higher is better', () => {
    expect(deviationBadge(3, 1.5, 'higher', formatDecimal)?.tone).toBe('better')
    expect(deviationBadge(1, 1.5, 'higher', formatDecimal)?.tone).toBe('worse')
  })

  it('is neutral when the gap rounds to nothing', () => {
    expect(deviationBadge(1.51, 1.5, 'lower', formatDecimal)).toEqual({ text: '+0.0 vs all (1.5)', tone: 'neutral', arrow: null })
  })

  it('gives nothing when either figure is missing', () => {
    expect(deviationBadge(null, 1.5, 'lower', formatDecimal)).toBeNull()
    expect(deviationBadge(3, null, 'lower', formatDecimal)).toBeNull()
  })
})
