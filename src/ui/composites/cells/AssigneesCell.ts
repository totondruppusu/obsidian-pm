import { AvatarStack } from '../../primitives/AvatarStack'
import type { AssigneeInitialsMode } from '../../../types'

export class AssigneesCell {
  el: HTMLTableCellElement

  constructor(parentRow: HTMLElement, assignees: string[], initialsMode: AssigneeInitialsMode) {
    this.el = parentRow.createEl('td', { cls: 'pm-table-cell pm-table-cell-assignees' })
    new AvatarStack(this.el).setNames(assignees).setMax(3).setInitialsMode(initialsMode)
  }
}
