import { App, TFile, normalizePath } from 'obsidian'
import type { Project, Task } from '../types'
import { appendYaml, FRONTMATTER_KEY, parseFrontmatter, TASK_FRONTMATTER_KEY } from './YamlParser'
import { hydrateTaskFromFile } from './YamlHydrator'
import { ensureFolder } from './vaultFs'

interface ProjectCandidate {
  path: string
  body: string
  frontmatter: Record<string, unknown>
  updatedAt: string
}

export interface TaskCandidate {
  path: string
  body: string
  task: Task
  projectId: string | null
  subtaskIds: string[]
  parentId: string | null
  updatedAt: string
}

export interface TaskMergeResult {
  canonicalPath: string
  mergedTask: Task
  mergedProjectId: string | null
  mergedSubtaskIds: string[]
  mergedParentId: string | null
}

const CONFLICT_PATH_RE = /(conflict|conflicted|duplicat|copy\b)/i

export function isConflictLikePath(path: string): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1)
  return CONFLICT_PATH_RE.test(name)
}

export function chooseCanonicalPath(paths: string[]): string {
  return [...paths].sort((a, b) => {
    const aConflict = isConflictLikePath(a)
    const bConflict = isConflictLikePath(b)
    if (aConflict !== bConflict) return aConflict ? 1 : -1
    return a.localeCompare(b)
  })[0]
}

function toMs(iso: string): number {
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? ms : 0
}

function uniqueNewestFirst(values: string[][]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const list of values) {
    for (const v of list) {
      if (!v || seen.has(v)) continue
      seen.add(v)
      out.push(v)
    }
  }
  return out
}

function rankByLww<T extends { path: string; updatedAt: string }>(
  entries: T[],
  canonicalPath: string,
  preferPath?: string
): T[] {
  return [...entries].sort((a, b) => {
    const d = toMs(b.updatedAt) - toMs(a.updatedAt)
    if (d !== 0) return d
    if (a.path === canonicalPath && b.path !== canonicalPath) return -1
    if (b.path === canonicalPath && a.path !== canonicalPath) return 1
    if (preferPath) {
      if (a.path === preferPath && b.path !== preferPath) return -1
      if (b.path === preferPath && a.path !== preferPath) return 1
    }
    return a.path.localeCompare(b.path)
  })
}

export function mergeTaskCandidates(candidates: TaskCandidate[], canonicalPath: string): TaskMergeResult {
  const ranked = rankByLww(candidates, canonicalPath)
  const winner = ranked[0]
  const merged = JSON.parse(JSON.stringify(winner.task)) as Task

  merged.assignees = uniqueNewestFirst(ranked.map((c) => c.task.assignees))
  merged.tags = uniqueNewestFirst(ranked.map((c) => c.task.tags))
  merged.dependencies = uniqueNewestFirst(ranked.map((c) => c.task.dependencies))
  const mergedSubtaskIds = uniqueNewestFirst(ranked.map((c) => c.subtaskIds))

  return {
    canonicalPath,
    mergedTask: merged,
    mergedProjectId: winner.projectId,
    mergedSubtaskIds,
    mergedParentId: winner.parentId
  }
}

function buildTaskFrontmatter(
  task: Task,
  projectId: string | null,
  parentId: string | null,
  subtaskIds: string[]
): Record<string, unknown> {
  const fm: Record<string, unknown> = {
    [TASK_FRONTMATTER_KEY]: true,
    projectId,
    parentId,
    id: task.id,
    title: task.title,
    type: task.type,
    status: task.status,
    priority: task.priority,
    start: task.start,
    due: task.due,
    progress: task.progress,
    assignees: task.assignees,
    tags: task.tags,
    subtaskIds,
    dependencies: task.dependencies,
    collapsed: task.collapsed,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt
  }

  if (task.recurrence) fm.recurrence = task.recurrence
  if (task.timeEstimate !== undefined) fm.timeEstimate = task.timeEstimate
  if (task.timeLogs?.length) fm.timeLogs = task.timeLogs
  if (Object.keys(task.customFields).length) fm.customFields = task.customFields

  return fm
}

function renderFrontmatter(frontmatter: Record<string, unknown>, body: string): string {
  const yamlLines: string[] = ['---']
  appendYaml(yamlLines, frontmatter, 0)
  yamlLines.push('---')
  yamlLines.push('')
  if (body.trim()) yamlLines.push(body.trim())
  return yamlLines.join('\n')
}

function isProjectFilePath(filePath: string): boolean {
  return !/_tasks\//.test(filePath) && !/\/_merged_conflicts\//.test(filePath)
}

async function moveToMergeArchive(app: App, file: TFile, archiveFolder: string): Promise<void> {
  await ensureFolder(app, archiveFolder)
  const fileName = file.path.slice(file.path.lastIndexOf('/') + 1)
  const target = await nextAvailablePath(app, normalizePath(`${archiveFolder}/${fileName}`))
  await app.vault.rename(file, target)
}

async function nextAvailablePath(app: App, desiredPath: string): Promise<string> {
  if (!app.vault.getAbstractFileByPath(desiredPath)) return desiredPath
  const dot = desiredPath.lastIndexOf('.')
  const stem = dot >= 0 ? desiredPath.slice(0, dot) : desiredPath
  const ext = dot >= 0 ? desiredPath.slice(dot) : ''
  for (let i = 1; i < 10000; i++) {
    const candidate = `${stem}-${i}${ext}`
    if (!app.vault.getAbstractFileByPath(candidate)) return candidate
  }
  return `${stem}-${Date.now()}${ext}`
}

async function parseProjectCandidate(app: App, file: TFile): Promise<ProjectCandidate | null> {
  const content = await app.vault.read(file)
  const { frontmatter, body } = parseFrontmatter(content)
  if (!frontmatter || frontmatter[FRONTMATTER_KEY] !== true || typeof frontmatter.id !== 'string') return null
  return {
    path: file.path,
    body,
    frontmatter,
    updatedAt: typeof frontmatter.updatedAt === 'string' ? frontmatter.updatedAt : ''
  }
}

async function parseTaskCandidate(app: App, file: TFile): Promise<TaskCandidate | null> {
  const content = await app.vault.read(file)
  const { frontmatter, body } = parseFrontmatter(content)
  if (!frontmatter || frontmatter[TASK_FRONTMATTER_KEY] !== true || typeof frontmatter.id !== 'string') return null
  const { task, subtaskIds, parentId } = hydrateTaskFromFile(frontmatter, body, file.path)
  return {
    path: file.path,
    body,
    task,
    projectId: typeof frontmatter.projectId === 'string' ? frontmatter.projectId : null,
    subtaskIds,
    parentId,
    updatedAt: task.updatedAt
  }
}

async function mergeProjectGroup(app: App, group: ProjectCandidate[]): Promise<string> {
  const canonicalPath = chooseCanonicalPath(group.map((g) => g.path))
  if (group.length === 1) return canonicalPath

  const ranked = rankByLww(group, canonicalPath)
  const winner = ranked[0]
  const mergedFrontmatter: Record<string, unknown> = { ...winner.frontmatter }
  const taskIds = uniqueNewestFirst(
    ranked.map((g) => (Array.isArray(g.frontmatter.taskIds) ? (g.frontmatter.taskIds as string[]) : []))
  )
  mergedFrontmatter.taskIds = taskIds

  const canonical = app.vault.getAbstractFileByPath(canonicalPath)
  const content = renderFrontmatter(mergedFrontmatter, winner.body)
  if (canonical instanceof TFile) {
    const current = await app.vault.read(canonical)
    if (current !== content) await app.vault.modify(canonical, content)
  }

  const folder = canonicalPath.slice(0, canonicalPath.lastIndexOf('/'))
  const archiveFolder = normalizePath(`${folder}/_merged_conflicts`)
  for (const entry of group) {
    if (entry.path === canonicalPath) continue
    const file = app.vault.getAbstractFileByPath(entry.path)
    if (file instanceof TFile) {
      await moveToMergeArchive(app, file, archiveFolder)
    }
  }

  return canonicalPath
}

export async function mergeProjectConflictsInFolder(app: App, folder: string): Promise<Map<string, string>> {
  const files = app.vault
    .getMarkdownFiles()
    .filter((f) => f.path.startsWith(folder + '/') && isProjectFilePath(f.path))

  const byProjectId = new Map<string, ProjectCandidate[]>()
  for (const file of files) {
    const candidate = await parseProjectCandidate(app, file)
    if (!candidate) continue
    const id = candidate.frontmatter.id as string
    const list = byProjectId.get(id) ?? []
    list.push(candidate)
    byProjectId.set(id, list)
  }

  const canonicalById = new Map<string, string>()
  for (const [id, group] of byProjectId) {
    const canonical = await mergeProjectGroup(app, group)
    canonicalById.set(id, canonical)
  }
  return canonicalById
}

export async function mergeProjectConflictsForPath(app: App, projectPath: string): Promise<string> {
  const folder = projectPath.slice(0, projectPath.lastIndexOf('/'))
  const canonicalById = await mergeProjectConflictsInFolder(app, folder)
  const allPaths = [...canonicalById.values()]
  if (allPaths.includes(projectPath)) return projectPath

  const file = app.vault.getAbstractFileByPath(projectPath)
  if (file instanceof TFile) {
    const candidate = await parseProjectCandidate(app, file)
    if (candidate) return canonicalById.get(candidate.frontmatter.id as string) ?? projectPath
  }
  return projectPath
}

export async function mergeTaskConflictsForProject(app: App, project: Project): Promise<void> {
  const taskFolder = project.filePath.replace(/\.md$/, '_tasks')
  const files = app.vault
    .getMarkdownFiles()
    .filter((f) => f.path.startsWith(taskFolder + '/') && !f.path.includes('/_merged_conflicts/'))

  const byTaskId = new Map<string, TaskCandidate[]>()
  for (const file of files) {
    const candidate = await parseTaskCandidate(app, file)
    if (!candidate) continue
    const list = byTaskId.get(candidate.task.id) ?? []
    list.push(candidate)
    byTaskId.set(candidate.task.id, list)
  }

  const archiveFolder = normalizePath(`${taskFolder}/_merged_conflicts`)
  for (const group of byTaskId.values()) {
    if (group.length <= 1) continue
    const canonicalPath = chooseCanonicalPath(group.map((g) => g.path))
    const merged = mergeTaskCandidates(group, canonicalPath)
    const fm = buildTaskFrontmatter(
      merged.mergedTask,
      merged.mergedProjectId,
      merged.mergedParentId,
      merged.mergedSubtaskIds
    )
    const ranked = rankByLww(group, canonicalPath)
    const winnerBody = ranked[0].body
    const content = renderFrontmatter(fm, winnerBody)

    const canonical = app.vault.getAbstractFileByPath(canonicalPath)
    if (canonical instanceof TFile) {
      const current = await app.vault.read(canonical)
      if (current !== content) await app.vault.modify(canonical, content)
    }

    for (const entry of group) {
      if (entry.path === canonicalPath) continue
      const file = app.vault.getAbstractFileByPath(entry.path)
      if (file instanceof TFile) {
        await moveToMergeArchive(app, file, archiveFolder)
      }
    }
  }
}
