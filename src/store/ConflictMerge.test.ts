import { describe, expect, it } from 'vitest'
import { makeTask } from '../types'
import {
  chooseCanonicalPath,
  isConflictLikePath,
  mergeTaskCandidates,
  type TaskCandidate
} from './ConflictMerge'

function candidate(input: {
  path: string
  updatedAt: string
  title?: string
  assignees?: string[]
  tags?: string[]
  dependencies?: string[]
  subtaskIds?: string[]
  parentId?: string | null
}): TaskCandidate {
  const task = makeTask({
    id: 'task-1',
    title: input.title ?? 'Task',
    assignees: input.assignees ?? [],
    tags: input.tags ?? [],
    dependencies: input.dependencies ?? [],
    updatedAt: input.updatedAt
  })
  return {
    path: input.path,
    body: 'Body',
    task,
    projectId: 'project-1',
    subtaskIds: input.subtaskIds ?? [],
    parentId: input.parentId ?? null,
    updatedAt: input.updatedAt
  }
}

describe('conflict path detection', () => {
  it('detects common conflict naming patterns', () => {
    expect(isConflictLikePath('Projects/Build (conflicted copy).md')).toBe(true)
    expect(isConflictLikePath('Projects/Build copy.md')).toBe(true)
    expect(isConflictLikePath('Projects/Build.md')).toBe(false)
  })

  it('chooses canonical path preferring non-conflict names', () => {
    const canonical = chooseCanonicalPath([
      'Projects/Build (conflicted copy).md',
      'Projects/Build.md',
      'Projects/Build (copy).md'
    ])
    expect(canonical).toBe('Projects/Build.md')
  })
})

describe('task merge policy', () => {
  it('uses field-level LWW and unions array fields newest-first', () => {
    const older = candidate({
      path: 'Projects/P_tasks/task (conflicted copy).md',
      updatedAt: '2026-05-25T10:00:00.000Z',
      title: 'Old title',
      assignees: ['alice'],
      tags: ['backend'],
      dependencies: ['dep-a'],
      subtaskIds: ['child-a']
    })
    const newer = candidate({
      path: 'Projects/P_tasks/task.md',
      updatedAt: '2026-05-25T11:00:00.000Z',
      title: 'New title',
      assignees: ['bob', 'alice'],
      tags: ['frontend'],
      dependencies: ['dep-b', 'dep-a'],
      subtaskIds: ['child-b'],
      parentId: 'parent-1'
    })

    const merged = mergeTaskCandidates([older, newer], 'Projects/P_tasks/task.md')
    expect(merged.mergedTask.title).toBe('New title')
    expect(merged.mergedTask.assignees).toEqual(['bob', 'alice'])
    expect(merged.mergedTask.tags).toEqual(['frontend', 'backend'])
    expect(merged.mergedTask.dependencies).toEqual(['dep-b', 'dep-a'])
    expect(merged.mergedSubtaskIds).toEqual(['child-b', 'child-a'])
    expect(merged.mergedParentId).toBe('parent-1')
  })

  it('breaks equal-timestamp ties by preferring canonical path', () => {
    const a = candidate({
      path: 'Projects/P_tasks/task (conflicted copy).md',
      updatedAt: '2026-05-25T11:00:00.000Z',
      title: 'Conflict title'
    })
    const b = candidate({
      path: 'Projects/P_tasks/task.md',
      updatedAt: '2026-05-25T11:00:00.000Z',
      title: 'Canonical title'
    })

    const merged = mergeTaskCandidates([a, b], 'Projects/P_tasks/task.md')
    expect(merged.mergedTask.title).toBe('Canonical title')
  })
})
