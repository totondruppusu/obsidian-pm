import { describe, expect, it } from 'vitest'
import { getAssigneeInitials } from './utils'

describe('getAssigneeInitials', () => {
  it('keeps current behavior in firstTwoChars mode', () => {
    expect(getAssigneeInitials('Michael Jordan', 'firstTwoChars')).toBe('MI')
    expect(getAssigneeInitials('alice', 'firstTwoChars')).toBe('AL')
  })

  it('uses first + second word initials in firstAndSecondWord mode', () => {
    expect(getAssigneeInitials('Michael Jordan', 'firstAndSecondWord')).toBe('MJ')
    expect(getAssigneeInitials('michael   jordan', 'firstAndSecondWord')).toBe('MJ')
  })

  it('falls back to firstTwoChars when only one word is present', () => {
    expect(getAssigneeInitials('Michael', 'firstAndSecondWord')).toBe('MI')
  })
})
