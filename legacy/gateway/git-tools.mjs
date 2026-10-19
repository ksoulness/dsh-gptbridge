/** 只读 Git 审计接口：status / diff / log / branch / test_result。全部限定在白名单 cwd 内，禁止任何写操作。 */
import { execFileSync } from 'node:child_process'
import { CFG } from './config.mjs'
import { ToolError, assertCwdAllowed, truncate, scrub } from './policy.mjs'

const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' }

function git(cwd, args) {
  try {
    return execFileSync('git', ['--no-pager', ...args], { cwd, encoding: 'utf8', timeout: CFG.gitTimeoutMs, env: GIT_ENV, windowsHide: true, maxBuffer: 8 * 1024 * 1024 })
  } catch (e) {
    const stderr = scrub(String(e.stderr ?? e.message ?? e)).slice(0, 500)
    throw new ToolError('GIT_ERROR', `git ${args[0]} failed: ${stderr}`)
  }
}
function requireRepo(cwdRaw) {
  const d = assertCwdAllowed(cwdRaw)
  let inside = 'false'
  try { inside = git(d.real, ['rev-parse', '--is-inside-work-tree']).trim() } catch { inside = 'false' }
  if (inside !== 'true') throw new ToolError('NOT_A_REPO', `cwd is not inside a git work tree: ${cwdRaw}`)
  return d
}
function headSha(real) { return git(real, ['rev-parse', 'HEAD']).trim() }

export const gitTools = {
  dsh_git_status(params) {
    const d = requireRepo(params?.cwd)
    const porcelain = git(d.real, ['status', '--porcelain=v1', '--branch'])
    const lines = porcelain.split('\n').filter(Boolean)
    const branchLine = lines.find((l) => l.startsWith('##')) ?? ''
    const entries = lines.filter((l) => !l.startsWith('##')).map((l) => ({ code: l.slice(0, 2), path: scrub(l.slice(3)).slice(0, 400) }))
    return {
      cwd: d.real, branch: branchLine.replace(/^##\s*/, '') || null,
      head: (() => { try { return headSha(d.real) } catch { return null } })(),
      dirty: entries.length > 0, changed: entries.length, entries: entries.slice(0, 500),
      truncated: entries.length > 500, reparse_points: d.reparse_points,
    }
  },

  dsh_git_diff(params) {
    const d = requireRepo(params?.cwd)
    const baseArgs = ['--no-color']
    if (params?.staged === true) baseArgs.push('--cached')
    if (typeof params?.base === 'string' && params.base.trim() !== '') {
      if (!/^[A-Za-z0-9._~^@\/{}-]{1,120}$/.test(params.base)) throw new ToolError('INVALID_PARAMS', 'base must be a revision expression (no shell metacharacters)')
      baseArgs.push(params.base)
    }
    const pathspec = []
    if (typeof params?.path === 'string' && params.path.trim() !== '') {
      if (params.path.includes('\0')) throw new ToolError('INVALID_PARAMS', 'path contains NUL')
      pathspec.push('--', params.path)
    }
    // 计数用 --numstat（稳定、可解析），补丁用完整 diff（截断）
    const numstat = git(d.real, ['diff', ...baseArgs, '--numstat', ...pathspec])
    const files = numstat.split('\n').filter(Boolean).map((l) => {
      const [added, deleted, ...rest] = l.split('\t')
      return { path: scrub(rest.join('\t')).slice(0, 400), added: added === '-' ? null : Number(added), deleted: deleted === '-' ? null : Number(deleted) }
    })
    const patchRaw = git(d.real, ['diff', ...baseArgs, ...pathspec])
    const patch = truncate(patchRaw, CFG.gitMaxBytes)
    return {
      cwd: d.real, base: params?.base ?? 'WORKTREE', staged: params?.staged === true,
      head: (() => { try { return headSha(d.real) } catch { return null } })(),
      changed_files: files.slice(0, 300), changed_count: files.length,
      patch: patch.text, patch_truncated: patch.truncated, patch_bytes: patch.bytes, patch_total_bytes: patch.total_bytes,
    }
  },

  dsh_git_log(params) {
    const d = requireRepo(params?.cwd)
    const limit = Math.min(Math.max(Number(params?.limit ?? 20), 1), 200)
    const raw = git(d.real, ['log', `-${limit}`, '--date=iso-strict', '--pretty=format:%H%x1f%ad%x1f%an%x1f%s'])
    const commits = raw.split('\n').filter(Boolean).map((l) => { const [sha, date, author, subject] = l.split('\x1f'); return { sha, date, author: scrub(author), subject: scrub(subject) } })
    return { cwd: d.real, limit, commits }
  },

  dsh_git_branch(params) {
    const d = requireRepo(params?.cwd)
    const current = git(d.real, ['branch', '--show-current']).trim() || null
    let head = null
    try { head = headSha(d.real) } catch { head = null }
    return { cwd: d.real, current_branch: current, head, detached: current === null }
  },

  /** 测试结果来自网关记录（P2-B 才会产生真实执行结果），本轮只读。 */
  dsh_git_test_result(params, registry) {
    const d = requireRepo(params?.cwd)
    const limit = Math.min(Math.max(Number(params?.limit ?? 20), 1), 100)
    const rows = params?.task_id
      ? registry.stmt.testsByTask.all(String(params.task_id), limit)
      : registry.stmt.testsByCwd.all(d.real, limit)
    return {
      cwd: d.real, source: 'gateway_registry',
      recorded: rows.length > 0,
      results: rows.map((r) => ({ task_id: r.task_id, command: scrub(r.command ?? ''), status: r.status, exit_code: r.exit_code, summary: truncate(scrub(r.summary ?? ''), 2000).text, at: r.at })),
      note: rows.length === 0 ? 'no test result recorded for this cwd yet (execution belongs to P2-B)' : null,
    }
  },
}
