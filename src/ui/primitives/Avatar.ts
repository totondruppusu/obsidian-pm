import { setTooltip } from 'obsidian'
import type { AssigneeInitialsMode } from '../../types'
import { getAssigneeInitials, stringToColor } from '../../utils'

export class Avatar {
  el: HTMLSpanElement
  private initialsMode: AssigneeInitialsMode = 'firstTwoChars'

  constructor(parentEl: HTMLElement) {
    this.el = parentEl.createEl('span', { cls: 'pm-avatar' })
  }

  setName(name: string): this {
    this.el.setText(getAssigneeInitials(name, this.initialsMode))
    this.el.style.background = stringToColor(name)
    setTooltip(this.el, name)
    return this
  }

  setInitialsMode(mode: AssigneeInitialsMode): this {
    this.initialsMode = mode
    return this
  }

  setSize(size: 'md' | 'sm'): this {
    this.el.toggleClass('pm-avatar--sm', size === 'sm')
    return this
  }
}
