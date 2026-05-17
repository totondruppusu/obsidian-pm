import { App, Notice, TFile, TFolder, normalizePath } from 'obsidian'
import type { Project, Task, StatusConfig } from '../types'
import { makeProject, makeTask } from '../types'
import {
  updateTaskInTree,
  deleteTaskFromTree,
  addTaskToTree,
  findTask,
  flattenTasks,
  moveTaskInTree,
  cloneTaskSubtree
} from './TaskTreeOps'
import { computeSchedule } from './Scheduler'
import { archiveTask as doArchiveTask, unarchiveTask as doUnarchiveTask } from './ArchiveOps'
import { parseFrontmatter, FRONTMATTER_KEY, TASK_FRONTMATTER_KEY } from './YamlParser'
import { hydrateProjectFromFrontmatter, hydrateTaskFromFile, hydrateTasks } from './YamlHydrator'
import { serializeProject, serializeTask, taskFilePath } from './YamlSerializer'
import { ensureFolder } from './vaultFs'

interface TaskSnapshot {
  id: string
  title: string
  description: string
  type: Task['type']
  status: Task['status']
  priority: Task['priority']
  start: string
  due: string
  progress: number
  assignees: string[]
  tags: string[]
  dependencies: string[]
  collapsed: boolean
  createdAt: string
  updatedAt: string
  parentId: null | string
  subtaskIds: string[]
  recurrence?: Task['recurrence']
  timeEstimate?: number
  timeLogs?: Task['timeLogs']
  customFields: Record<string, unknown>
}

interface ProjectSnapshot {
  id: string
  title: string
  description: string
  color: string
  icon: string
  createdAt: string
  updatedAt: string
  customFields: Project['customFields']
  teamMembers: string[]
  savedViews: Project['savedViews']
  taskIds: string[]
}

/**
 * Handles all read/write operations against the Obsidian vault.
 *
 * Storage layout:
 *   Projects/<ProjectName>.md         — project metadata (no task data)
 *   Projects/<ProjectName>/<slug>.md  — one .md per task
 *
 * The in-memory Project.tasks tree is assembled on load from individual
 * task files and remains unchanged for views.
 */
export class ProjectStore {
  /** Per-project promise chains to serialize concurrent saves */
  private saveQueues = new Map<string, Promise<void>>()
  /** Last-seen baseline per task (project-scoped key) for optimistic concurrency */
  private taskBases = new Map<string, { hash: string; snapshot: TaskSnapshot }>()
  /** Last-seen baseline per project file for optimistic concurrency */
  private projectBases = new Map<string, { hash: string; snapshot: ProjectSnapshot }>()

  constructor(
    private app: App,
    private getStatuses: () => StatusConfig[] = () => []
  ) {}

  // ─── Folder helpers ────────────────────────────────────────────────────────

  async ensureFolder(folderPath: string): Promise<void> {
    await ensureFolder(this.app, folderPath)
  }

  /** Get the task subfolder path for a project */
  private projectTaskFolder(project: Project): string {
    return project.filePath.replace(/\.md$/, '_tasks')
  }

  // ─── Load ──────────────────────────────────────────────────────────────────

  async loadAllProjects(folder: string): Promise<Project[]> {
    await this.ensureFolder(folder)
    const projects: Project[] = []
    const files = this.app.vault
      .getMarkdownFiles()
      .filter((f) => f.path.startsWith(folder + '/') && !this.isTaskFile(f))
    for (const file of files) {
      const project = await this.loadProject(file)
      if (project) projects.push(project)
    }
    return projects.sort((a, b) => a.title.localeCompare(b.title))
  }

  private isTaskFile(file: TFile): boolean {
    return /_tasks\//.test(file.path)
  }

  async loadProject(file: TFile): Promise<Project | null> {
    try {
      const content = await this.app.vault.read(file)
      const { frontmatter, body } = parseFrontmatter(content)
      if (!frontmatter || frontmatter[FRONTMATTER_KEY] !== true) return null

      const hasEmbeddedTasks = Array.isArray(frontmatter.tasks) && frontmatter.tasks.length > 0

      const project = hydrateProjectFromFrontmatter(frontmatter, body, file.path, file.basename)

      if (hasEmbeddedTasks) {
        project.tasks = hydrateTasks((frontmatter.tasks as unknown[]) ?? [])
      } else {
        const taskFolder = this.projectTaskFolder(project)
        const taskIds = Array.isArray(frontmatter.taskIds) ? (frontmatter.taskIds as string[]) : []
        project.tasks = await this.loadTasksFromFolder(taskFolder, taskIds, file.path)
      }

      this.recordProjectBase(project, content)

      return project
    } catch (e) {
      console.error(`[PM] Failed to load project ${file.path}:`, e)
      new Notice(`Project Manager: Failed to load "${file.basename}". Check console for details.`)
      return null
    }
  }

  private async loadTasksFromFolder(folderPath: string, topLevelIds: string[], projectFilePath: string): Promise<Task[]> {
    const folder = this.app.vault.getAbstractFileByPath(folderPath)
    if (!(folder instanceof TFolder)) return []

    const taskMap = new Map<string, Task>()
    const subtaskIdsMap = new Map<string, string[]>()
    const parentIdMap = new Map<string, string>()
    const archivePrefix = normalizePath(folderPath + '/Archive') + '/'

    const files = this.app.vault.getMarkdownFiles().filter((f) => f.path.startsWith(folderPath + '/'))
    for (const file of files) {
      const { task, subtaskIds, parentId, rawContent } = await this.loadTaskFile(file)
      if (task) {
        if (file.path.startsWith(archivePrefix)) {
          task.archived = true
        }
        taskMap.set(task.id, task)
        if (subtaskIds.length) subtaskIdsMap.set(task.id, subtaskIds)
        if (parentId) parentIdMap.set(task.id, parentId)
        if (rawContent !== null) {
          this.recordTaskBase(projectFilePath, this.toTaskSnapshot(task, parentId, subtaskIds), rawContent)
        }
      }
    }

    for (const [taskId, sids] of subtaskIdsMap) {
      const task = taskMap.get(taskId)
      if (!task) continue
      task.subtasks = []
      for (const sid of sids) {
        const sub = taskMap.get(sid)
        if (sub) task.subtasks.push(sub)
      }
    }

    // Self-healing: re-parent orphaned tasks using parentId from their files
    const childIds = new Set<string>()
    for (const t of taskMap.values()) {
      for (const s of t.subtasks) childIds.add(s.id)
    }
    for (const [taskId, pid] of parentIdMap) {
      if (childIds.has(taskId)) continue // already parented
      const parent = taskMap.get(pid)
      if (!parent) continue
      const task = taskMap.get(taskId)
      if (!task) continue
      parent.subtasks.push(task)
      childIds.add(taskId)
      // Ensure parent's subtaskIds stay in sync
      if (!subtaskIdsMap.has(pid)) subtaskIdsMap.set(pid, [])
      const sids = subtaskIdsMap.get(pid)
      if (sids && !sids.includes(taskId)) sids.push(taskId)
      console.warn(
        `[PM] Self-healed orphan: re-parented task "${task.title}" (${taskId}) under "${parent.title}" (${pid})`
      )
    }

    const result: Task[] = []
    const pushed = new Set<string>()
    for (const id of topLevelIds) {
      if (pushed.has(id)) continue
      const task = taskMap.get(id)
      if (task) {
        result.push(task)
        pushed.add(id)
      }
    }
    for (const task of taskMap.values()) {
      if (pushed.has(task.id)) continue
      const isChild = [...taskMap.values()].some((t) => t.subtasks.some((s) => s.id === task.id))
      if (!isChild) result.push(task)
    }

    return result
  }

  async loadTaskFile(
    file: TFile
  ): Promise<{ task: Task | null; subtaskIds: string[]; parentId: string | null; rawContent: null | string }> {
    try {
      const content = await this.app.vault.read(file)
      const { frontmatter, body } = parseFrontmatter(content)
      if (!frontmatter || frontmatter[TASK_FRONTMATTER_KEY] !== true) {
        return { task: null, subtaskIds: [], parentId: null, rawContent: null }
      }

      return { ...hydrateTaskFromFile(frontmatter, body, file.path), rawContent: content }
    } catch (e) {
      if (e instanceof Error && e.message.includes('ENOENT')) {
        console.warn(`[PM] Task file no longer exists, skipping: ${file.path}`)
      } else {
        console.error(`[PM] Failed to load task ${file.path}:`, e)
        new Notice(`Project Manager: Failed to load task "${file.basename}". Check console for details.`)
      }
      return { task: null, subtaskIds: [], parentId: null, rawContent: null }
    }
  }

  // ─── Save ──────────────────────────────────────────────────────────────────

  async saveProject(project: Project): Promise<void> {
    const key = project.filePath
    const prev = this.saveQueues.get(key) ?? Promise.resolve()
    const next = prev.then(() => this.doSaveProject(project))
    this.saveQueues.set(
      key,
      next.catch(() => {})
    )
    return next
  }

  private async doSaveProject(project: Project): Promise<void> {
    try {
      project.updatedAt = new Date().toISOString()

      const taskFolder = this.projectTaskFolder(project)
      await this.ensureFolder(taskFolder)

      await this.saveAllTasks(project.tasks, project, null, taskFolder)

      const content = serializeProject(project, this.getStatuses())
      const file = this.app.vault.getAbstractFileByPath(project.filePath)
      if (file instanceof TFile) {
        await this.app.vault.modify(file, content)
      } else {
        await this.app.vault.create(project.filePath, content)
      }
      this.recordProjectBase(project, content)
    } catch (e) {
      console.error(`[PM] Failed to save project "${project.title}":`, e)
      new Notice(`Project Manager: Failed to save "${project.title}". Check console for details.`)
      throw e
    }
  }

  private async saveAllTasks(tasks: Task[], project: Project, parentTask: Task | null, folder: string): Promise<void> {
    const errors: Error[] = []
    for (const task of tasks) {
      try {
        let targetFolder = folder
        if (task.archived) {
          targetFolder = normalizePath(folder + '/Archive')
          await this.ensureFolder(targetFolder)
        }
        await this.saveTaskFile(task, project, parentTask, targetFolder)
        if (task.subtasks.length) {
          await this.saveAllTasks(task.subtasks, project, task, folder)
        }
      } catch (e) {
        errors.push(e instanceof Error ? e : new Error(String(e)))
      }
    }
    if (errors.length) {
      throw new Error(`Failed to save ${errors.length} task(s): ${errors.map((e) => e.message).join('; ')}`)
    }
  }

  private async saveTaskFile(task: Task, project: Project, parentTask: Task | null, folder: string): Promise<void> {
    const filePath = normalizePath(taskFilePath(task.title, task.id, folder))
    const oldFilePath = task.filePath && task.filePath !== filePath ? task.filePath : null
    task.filePath = filePath

    try {
      // Write new file first, then delete old — prevents data loss if interrupted
      const content = serializeTask(task, project, parentTask, this.getStatuses())
      const existing = this.app.vault.getAbstractFileByPath(filePath)
      if (existing instanceof TFile) {
        await this.app.vault.modify(existing, content)
      } else {
        await this.app.vault.create(filePath, content)
      }

      if (oldFilePath) {
        const oldFile = this.app.vault.getAbstractFileByPath(oldFilePath)
        if (oldFile instanceof TFile) {
          await this.app.fileManager.trashFile(oldFile)
        }
      }
      const parentId = parentTask?.id ?? null
      this.recordTaskBase(project.filePath, this.toTaskSnapshot(task, parentId, task.subtasks.map((s) => s.id)), content)
    } catch (e) {
      console.error(`[PM] Failed to save task "${task.title}" (${task.id}):`, e)
      throw e
    }
  }

  // ─── CRUD shortcuts ────────────────────────────────────────────────────────

  async createProject(title: string, folder: string): Promise<Project> {
    const safeName = title.replace(/[\\/:*?"<>|]/g, '-')
    const filePath = normalizePath(`${folder}/${safeName}.md`)
    const project = makeProject(title, filePath)
    await this.ensureFolder(this.projectTaskFolder(project))
    await this.saveProject(project)
    return project
  }

  async addTask(project: Project, parentId: string | null = null): Promise<Task> {
    const task = makeTask()
    addTaskToTree(project.tasks, task, parentId)
    await this.saveProject(project)
    return task
  }

  async insertTask(project: Project, task: Task, parentId: string | null = null): Promise<void> {
    addTaskToTree(project.tasks, task, parentId)
    await this.saveProject(project)
  }

  async duplicateTask(project: Project, sourceId: string, includeSubtasks: boolean): Promise<Task | null> {
    const source = findTask(project.tasks, sourceId)
    if (!source) return null
    const copy = cloneTaskSubtree(source, includeSubtasks)
    copy.title = `${source.title} (copy)`
    const parentId = flattenTasks(project.tasks).find((f) => f.task.id === sourceId)?.parentId ?? null
    addTaskToTree(project.tasks, copy, parentId)
    moveTaskInTree(project.tasks, copy.id, sourceId, 'after')
    await this.saveProject(project)
    return copy
  }

  async moveTask(project: Project, taskId: string, newParentId: string | null): Promise<void> {
    const task = findTask(project.tasks, taskId)
    if (!task) return
    deleteTaskFromTree(project.tasks, taskId)
    addTaskToTree(project.tasks, task, newParentId)
    await this.saveProject(project)
  }

  async moveTasks(project: Project, taskIds: string[], newParentId: string | null): Promise<void> {
    for (const id of taskIds) {
      const task = findTask(project.tasks, id)
      if (!task) continue
      deleteTaskFromTree(project.tasks, id)
      addTaskToTree(project.tasks, task, newParentId)
    }
    await this.saveProject(project)
  }

  async updateTask(project: Project, taskId: string, patch: Partial<Task>): Promise<void> {
    const changed = new Set<keyof Task>()
    for (const key of Object.keys(patch) as Array<keyof Task>) changed.add(key)
    updateTaskInTree(project.tasks, taskId, patch)
    await this.persistTaskEdits(project, taskId, changed)
  }

  async updateTasks(project: Project, taskIds: string[], patch: Partial<Task>): Promise<void> {
    const changed = new Set<keyof Task>()
    for (const key of Object.keys(patch) as Array<keyof Task>) changed.add(key)
    for (const id of taskIds) {
      updateTaskInTree(project.tasks, id, patch)
      await this.persistTaskEdits(project, id, changed)
    }
  }

  async deleteTasks(project: Project, taskIds: string[]): Promise<void> {
    const folder = this.projectTaskFolder(project)
    for (const id of taskIds) {
      const task = findTask(project.tasks, id)
      if (task) await this.deleteTaskFiles(task, folder)
      deleteTaskFromTree(project.tasks, id)
    }
    await this.saveProject(project)
  }

  async archiveTask(project: Project, taskId: string): Promise<void> {
    await doArchiveTask(this.app, project, taskId)
  }

  async unarchiveTask(project: Project, taskId: string): Promise<void> {
    await doUnarchiveTask(this.app, project, taskId)
  }

  async deleteTask(project: Project, taskId: string): Promise<void> {
    const task = findTask(project.tasks, taskId)
    if (task) {
      await this.deleteTaskFiles(task, this.projectTaskFolder(project))
    }
    deleteTaskFromTree(project.tasks, taskId)
    await this.saveProject(project)
  }

  private async deleteTaskFiles(task: Task, folder: string): Promise<void> {
    for (const sub of task.subtasks) {
      await this.deleteTaskFiles(sub, folder)
    }
    if (task.filePath) {
      const file = this.app.vault.getAbstractFileByPath(task.filePath)
      if (file instanceof TFile) await this.app.fileManager.trashFile(file)
    }
  }

  async deleteProject(project: Project): Promise<void> {
    const taskFolder = this.projectTaskFolder(project)
    const folder = this.app.vault.getAbstractFileByPath(taskFolder)
    if (folder instanceof TFolder) {
      await this.deleteFolderRecursive(folder)
    }
    const file = this.app.vault.getAbstractFileByPath(project.filePath)
    if (file instanceof TFile) await this.app.fileManager.trashFile(file)
  }

  private async deleteFolderRecursive(folder: TFolder): Promise<void> {
    for (const child of [...folder.children]) {
      if (child instanceof TFile) {
        await this.app.fileManager.trashFile(child)
      } else if (child instanceof TFolder) {
        await this.deleteFolderRecursive(child)
      }
    }
    await this.app.fileManager.trashFile(folder)
  }

  // ─── Scheduling ──────────────────────────────────────────────────────────

  /**
   * Run dependency-based scheduling on the project.
   * Applies computed date patches and saves.
   * Returns the number of tasks that were adjusted.
   */
  async scheduleAfterChange(project: Project, changedTaskId?: string, statuses: StatusConfig[] = []): Promise<number> {
    const { patches } = computeSchedule(project.tasks, changedTaskId, statuses)
    if (patches.length === 0) return 0

    const touched = new Set<string>()
    const changed = new Set<keyof Task>(['start', 'due'])
    for (const p of patches) {
      updateTaskInTree(project.tasks, p.taskId, { start: p.start, due: p.due })
      touched.add(p.taskId)
    }
    for (const taskId of touched) {
      await this.persistTaskEdits(project, taskId, changed)
    }
    return patches.length
  }

  async saveTaskAndMove(
    project: Project,
    taskId: string,
    patch: Partial<Task>,
    nextParentId: null | string,
    runSchedule: boolean,
    statuses: StatusConfig[] = []
  ): Promise<void> {
    const flat = flattenTasks(project.tasks)
    const before = flat.find((f) => f.task.id === taskId)
    if (!before) return
    const previousParentId = before.parentId
    const moved = nextParentId !== previousParentId
    const changed = new Set<keyof Task>()
    for (const key of Object.keys(patch) as Array<keyof Task>) changed.add(key)

    if (Object.keys(patch).length > 0) {
      updateTaskInTree(project.tasks, taskId, patch)
    }
    if (moved) {
      const task = findTask(project.tasks, taskId)
      if (task) {
        deleteTaskFromTree(project.tasks, taskId)
        addTaskToTree(project.tasks, task, nextParentId)
        task.updatedAt = new Date().toISOString()
      }
    }

    await this.persistTaskEdits(project, taskId, changed, {
      oldParentId: previousParentId,
      newParentId: nextParentId,
      moved
    })

    if (runSchedule) {
      await this.scheduleAfterChange(project, taskId, statuses)
    }
  }

  async saveProjectMetadata(project: Project): Promise<void> {
    project.updatedAt = new Date().toISOString()
    await this.persistProjectFile(project)
  }

  private toTaskSnapshot(task: Task, parentId: null | string, subtaskIds: string[]): TaskSnapshot {
    return {
      id: task.id,
      title: task.title,
      description: task.description,
      type: task.type,
      status: task.status,
      priority: task.priority,
      start: task.start,
      due: task.due,
      progress: task.progress,
      assignees: [...task.assignees],
      tags: [...task.tags],
      dependencies: [...task.dependencies],
      collapsed: task.collapsed,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      recurrence: task.recurrence ? { ...task.recurrence } : undefined,
      timeEstimate: task.timeEstimate,
      timeLogs: task.timeLogs ? task.timeLogs.map((l) => ({ ...l })) : undefined,
      customFields: { ...task.customFields },
      parentId,
      subtaskIds: [...subtaskIds]
    }
  }

  private toProjectSnapshot(project: Project): ProjectSnapshot {
    return {
      id: project.id,
      title: project.title,
      description: project.description,
      color: project.color,
      icon: project.icon,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      customFields: project.customFields.map((f) => ({ ...f })),
      teamMembers: [...project.teamMembers],
      savedViews: project.savedViews.map((v) => ({ ...v, filter: { ...v.filter } })),
      taskIds: project.tasks.map((t) => t.id)
    }
  }

  private baseKey(projectFilePath: string, taskId: string): string {
    return `${projectFilePath}::${taskId}`
  }

  private hashText(input: string): string {
    let h = 2166136261
    for (let i = 0; i < input.length; i++) {
      h ^= input.charCodeAt(i)
      h = Math.imul(h, 16777619)
    }
    return (h >>> 0).toString(16)
  }

  private recordTaskBase(projectFilePath: string, snapshot: TaskSnapshot, rawContent: string): void {
    this.taskBases.set(this.baseKey(projectFilePath, snapshot.id), {
      hash: this.hashText(rawContent),
      snapshot: JSON.parse(JSON.stringify(snapshot)) as TaskSnapshot
    })
  }

  private recordProjectBase(project: Project, rawContent: string): void {
    this.projectBases.set(project.filePath, {
      hash: this.hashText(rawContent),
      snapshot: this.toProjectSnapshot(project)
    })
  }

  private valuesEqual(a: unknown, b: unknown): boolean {
    return JSON.stringify(a) === JSON.stringify(b)
  }

  private async persistTaskEdits(
    project: Project,
    taskId: string,
    changedFields: Set<keyof Task>,
    moveCtx?: { moved: boolean; oldParentId: null | string; newParentId: null | string }
  ): Promise<void> {
    const task = findTask(project.tasks, taskId)
    if (!task) return
    const previousPath = task.filePath ?? null
    const flat = flattenTasks(project.tasks)
    const info = flat.find((f) => f.task.id === taskId)
    const parentId = info?.parentId ?? null
    const parentTask = parentId ? findTask(project.tasks, parentId) : null
    const folder = task.archived ? normalizePath(this.projectTaskFolder(project) + '/Archive') : this.projectTaskFolder(project)
    if (task.archived) await this.ensureFolder(folder)

    await this.saveTaskFileScoped(task, project, parentTask, folder, changedFields, parentId)
    const renamed = previousPath !== null && task.filePath !== previousPath

    if (moveCtx?.moved) {
      const oldParent = moveCtx.oldParentId ? findTask(project.tasks, moveCtx.oldParentId) : null
      const newParent = moveCtx.newParentId ? findTask(project.tasks, moveCtx.newParentId) : null
      if (oldParent && oldParent.id !== task.id) {
        const oldParentParent = flat.find((f) => f.task.id === oldParent.id)?.parentId ?? null
        await this.saveTaskFileScoped(
          oldParent,
          project,
          oldParentParent ? findTask(project.tasks, oldParentParent) : null,
          oldParent.archived ? normalizePath(this.projectTaskFolder(project) + '/Archive') : this.projectTaskFolder(project),
          new Set<keyof Task>(),
          oldParentParent
        )
      }
      if (newParent && newParent.id !== task.id) {
        const newFlat = flattenTasks(project.tasks)
        const newParentParent = newFlat.find((f) => f.task.id === newParent.id)?.parentId ?? null
        await this.saveTaskFileScoped(
          newParent,
          project,
          newParentParent ? findTask(project.tasks, newParentParent) : null,
          newParent.archived ? normalizePath(this.projectTaskFolder(project) + '/Archive') : this.projectTaskFolder(project),
          new Set<keyof Task>(),
          newParentParent
        )
      }
      project.updatedAt = new Date().toISOString()
      await this.persistProjectFile(project)
    } else if (renamed) {
      if (parentTask) {
        const latest = flattenTasks(project.tasks)
        const parentParentId = latest.find((f) => f.task.id === parentTask.id)?.parentId ?? null
        await this.saveTaskFileScoped(
          parentTask,
          project,
          parentParentId ? findTask(project.tasks, parentParentId) : null,
          parentTask.archived ? normalizePath(this.projectTaskFolder(project) + '/Archive') : this.projectTaskFolder(project),
          new Set<keyof Task>(),
          parentParentId
        )
      }
      // Keep project task wiki-links valid when a task file slug changes.
      project.updatedAt = new Date().toISOString()
      await this.persistProjectFile(project)
    }
  }

  private async saveTaskFileScoped(
    task: Task,
    project: Project,
    parentTask: Task | null,
    folder: string,
    changedFields: Set<keyof Task>,
    parentId: null | string
  ): Promise<void> {
    await this.ensureFolder(folder)
    const filePath = normalizePath(taskFilePath(task.title, task.id, folder))
    const oldFilePath = task.filePath && task.filePath !== filePath ? task.filePath : null
    task.filePath = filePath
    const subtaskIds = task.subtasks.map((s) => s.id)
    const localSnapshot = this.toTaskSnapshot(task, parentId, subtaskIds)
    const base = this.taskBases.get(this.baseKey(project.filePath, task.id))
    let content = serializeTask(task, project, parentTask, this.getStatuses())

    const existing = this.app.vault.getAbstractFileByPath(filePath)
    if (existing instanceof TFile) {
      const remoteContent = await this.app.vault.read(existing)
      if (base && this.hashText(remoteContent) !== base.hash) {
        const { frontmatter, body } = parseFrontmatter(remoteContent)
        if (!frontmatter || frontmatter[TASK_FRONTMATTER_KEY] !== true) {
          throw new Error(`Conflict: task file changed externally and cannot be parsed (${filePath})`)
        }
        const remoteParsed = hydrateTaskFromFile(frontmatter, body, filePath)
        const remoteSnapshot = this.toTaskSnapshot(remoteParsed.task, remoteParsed.parentId, remoteParsed.subtaskIds)
        const structuralKeys: Array<keyof TaskSnapshot> = ['parentId', 'subtaskIds']
        for (const k of structuralKeys) {
          if (!this.valuesEqual(remoteSnapshot[k], base.snapshot[k])) {
            throw new Error(`Conflict: task hierarchy changed externally for "${task.title}"`)
          }
        }
        for (const key of changedFields) {
          if (key === 'updatedAt') continue
          const k = key as keyof TaskSnapshot
          if (!this.valuesEqual(remoteSnapshot[k], base.snapshot[k]) && !this.valuesEqual(localSnapshot[k], base.snapshot[k])) {
            throw new Error(`Conflict: field "${String(key)}" changed externally for "${task.title}"`)
          }
        }
        const merged = { ...remoteSnapshot, ...localSnapshot, updatedAt: localSnapshot.updatedAt }
        Object.assign(task, {
          title: merged.title,
          description: merged.description,
          type: merged.type,
          status: merged.status,
          priority: merged.priority,
          start: merged.start,
          due: merged.due,
          progress: merged.progress,
          assignees: [...merged.assignees],
          tags: [...merged.tags],
          dependencies: [...merged.dependencies],
          collapsed: merged.collapsed,
          createdAt: merged.createdAt,
          updatedAt: merged.updatedAt,
          recurrence: merged.recurrence ? { ...merged.recurrence } : undefined,
          timeEstimate: merged.timeEstimate,
          timeLogs: merged.timeLogs ? merged.timeLogs.map((l) => ({ ...l })) : undefined,
          customFields: { ...merged.customFields }
        })
        content = serializeTask(task, project, parentTask, this.getStatuses())
      }
      await this.app.vault.modify(existing, content)
    } else {
      await this.app.vault.create(filePath, content)
    }

    if (oldFilePath) {
      const oldFile = this.app.vault.getAbstractFileByPath(oldFilePath)
      if (oldFile instanceof TFile) {
        await this.app.fileManager.trashFile(oldFile)
      }
    }
    this.recordTaskBase(project.filePath, this.toTaskSnapshot(task, parentId, subtaskIds), content)
  }

  private async persistProjectFile(project: Project): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(project.filePath)
    const content = serializeProject(project, this.getStatuses())
    const base = this.projectBases.get(project.filePath)
    if (file instanceof TFile) {
      if (base) {
        const remote = await this.app.vault.read(file)
        if (this.hashText(remote) !== base.hash) {
          const { frontmatter, body } = parseFrontmatter(remote)
          if (!frontmatter || frontmatter[FRONTMATTER_KEY] !== true) {
            throw new Error(`Conflict: project file changed externally and cannot be parsed (${project.filePath})`)
          }
          const remoteProject = hydrateProjectFromFrontmatter(frontmatter, body, file.path, file.basename)
          const remoteSnapshot = this.toProjectSnapshot(remoteProject)
          remoteSnapshot.taskIds = Array.isArray(frontmatter.taskIds) ? (frontmatter.taskIds as string[]) : []
          const localSnapshot = this.toProjectSnapshot(project)
          const keyFields: Array<keyof ProjectSnapshot> = [
            'title',
            'description',
            'color',
            'icon',
            'customFields',
            'teamMembers',
            'savedViews'
          ]
          for (const k of keyFields) {
            if (
              !this.valuesEqual(remoteSnapshot[k], base.snapshot[k]) &&
              !this.valuesEqual(localSnapshot[k], base.snapshot[k])
            ) {
              throw new Error(`Conflict: project field "${String(k)}" changed externally`)
            }
          }
          const baseIds = base.snapshot.taskIds
          const remoteIdsChanged = !this.valuesEqual(remoteSnapshot.taskIds, baseIds)
          const localIdsChanged = !this.valuesEqual(localSnapshot.taskIds, baseIds)
          if (remoteIdsChanged && !localIdsChanged) {
            throw new Error('Conflict: project task ordering changed externally')
          }
          if (remoteIdsChanged && localIdsChanged && !this.valuesEqual(remoteSnapshot.taskIds, localSnapshot.taskIds)) {
            throw new Error('Conflict: project task ordering changed concurrently')
          }
        }
      }
      await this.app.vault.modify(file, content)
    } else {
      await this.app.vault.create(project.filePath, content)
    }
    this.recordProjectBase(project, content)
  }
}
