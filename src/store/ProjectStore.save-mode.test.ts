import { describe, expect, it, vi } from 'vitest'
import { ProjectStore } from './ProjectStore'
import { makeProject, makeTask } from '../types'

describe('ProjectStore save mode routing', () => {
  it('defaults saveProject to projectAndTasks', async () => {
    const store = new ProjectStore({} as never) as ProjectStore & {
      doSaveProject: ReturnType<typeof vi.fn>
    }
    store.doSaveProject = vi.fn().mockResolvedValue(undefined)

    const project = makeProject('P', 'Projects/P.md')
    await store.saveProject(project)

    expect(store.doSaveProject).toHaveBeenCalledWith(project, 'projectAndTasks')
  })

  it('routes updateTask through taskOnly mode', async () => {
    const store = new ProjectStore({} as never)
    const saveSpy = vi.spyOn(store, 'saveProject').mockResolvedValue(undefined)

    const task = makeTask({ id: 't-1', title: 'Before' })
    const project = makeProject('P', 'Projects/P.md')
    project.tasks = [task]

    await store.updateTask(project, 't-1', { title: 'After' })

    expect(saveSpy).toHaveBeenCalledWith(project, 'taskOnly')
    expect(project.tasks[0].title).toBe('After')
  })

  it('routes updateTasks through taskOnly mode', async () => {
    const store = new ProjectStore({} as never)
    const saveSpy = vi.spyOn(store, 'saveProject').mockResolvedValue(undefined)

    const project = makeProject('P', 'Projects/P.md')
    project.tasks = [makeTask({ id: 'a' }), makeTask({ id: 'b' })]

    await store.updateTasks(project, ['a', 'b'], { status: 'done' })

    expect(saveSpy).toHaveBeenCalledWith(project, 'taskOnly')
    expect(project.tasks.map((t) => t.status)).toEqual(['done', 'done'])
  })
})
