/** 持久化：SQLite(WAL) —— runtime 单实例锁、sessions 归属、tasks 状态机、events 日志、processes、approvals、cwd 串行锁。 */
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { CFG, BOOT_ID } from './config.mjs'
import { ToolError, truncate } from './policy.mjs'

export const STATES = ['queued', 'running', 'completed', 'failed', 'cancelled', 'timeout', 'orphaned', 'recovery_pending', 'unknown']
export const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'timeout', 'orphaned'])
/** 状态来源：acp = ACP 结算直接给出；gw = 网关推断；both = 由 ACP 事实 + 网关判定共同决定 */
export const STATE_ORIGIN = {
  queued: 'gw', running: 'gw', completed: 'both', failed: 'both', cancelled: 'both',
  timeout: 'gw', orphaned: 'gw', recovery_pending: 'gw', unknown: 'gw',
}

export function openRegistry(stateDir) {
  mkdirSync(stateDir, { recursive: true })
  const db = new DatabaseSync(join(stateDir, 'gateway.db'))
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec('PRAGMA synchronous = NORMAL;')
  db.exec('PRAGMA foreign_keys = ON;')
  db.exec(`
  CREATE TABLE IF NOT EXISTS runtime (
    id INTEGER PRIMARY KEY CHECK (id = 1), boot_id TEXT NOT NULL, pid INTEGER NOT NULL,
    started_at INTEGER NOT NULL, heartbeat_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY, cwd TEXT NOT NULL, created_at INTEGER NOT NULL, closed_at INTEGER,
    origin TEXT NOT NULL, owner TEXT NOT NULL, owner_basis TEXT NOT NULL,
    lock_state TEXT NOT NULL DEFAULT 'unknown', lock_at INTEGER, lock_detail TEXT
  );
  CREATE TABLE IF NOT EXISTS tasks (
    task_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, idempotency_key TEXT UNIQUE,
    state TEXT NOT NULL, prompt_len INTEGER NOT NULL, prompt_sha256 TEXT NOT NULL,
    created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER,
    stop_reason TEXT, error_code TEXT, error_message TEXT,
    output_text TEXT, output_truncated INTEGER NOT NULL DEFAULT 0,
    can_retry INTEGER NOT NULL DEFAULT 0, requires_human INTEGER NOT NULL DEFAULT 0,
    state_origin TEXT NOT NULL, cwd TEXT
  );
  CREATE TABLE IF NOT EXISTS events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT, session_id TEXT, kind TEXT NOT NULL,
    payload TEXT, payload_truncated INTEGER NOT NULL DEFAULT 0, at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_events_task ON events(task_id, seq);
  CREATE TABLE IF NOT EXISTS processes (
    id INTEGER PRIMARY KEY AUTOINCREMENT, pid INTEGER NOT NULL, ppid INTEGER NOT NULL, role TEXT NOT NULL,
    dsh_home TEXT, overlay_path TEXT, started_at INTEGER NOT NULL, exited_at INTEGER,
    exit_code INTEGER, exit_signal TEXT, stop_reason TEXT,
    creation_time TEXT, exe_path TEXT, cmdline_fingerprint TEXT, parent_identity TEXT
  );
  CREATE TABLE IF NOT EXISTS approvals (
    id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT, session_id TEXT, tool TEXT,
    decision TEXT NOT NULL, reason TEXT NOT NULL, at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS cwd_locks (cwd TEXT PRIMARY KEY, task_id TEXT NOT NULL, pid INTEGER NOT NULL, at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS test_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT, cwd TEXT NOT NULL, command TEXT,
    status TEXT NOT NULL, exit_code INTEGER, summary TEXT, at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS budget (k TEXT PRIMARY KEY, used INTEGER NOT NULL DEFAULT 0, limit_ INTEGER, at INTEGER NOT NULL);
  `)
  // 旧库升级：幂等补列（SQLite 不支持 ADD COLUMN IF NOT EXISTS）
  for (const col of [['creation_time', 'TEXT'], ['exe_path', 'TEXT'], ['cmdline_fingerprint', 'TEXT'], ['parent_identity', 'TEXT']]) {
    try { db.exec(`ALTER TABLE processes ADD COLUMN ${col[0]} ${col[1]}`) } catch { /* 已存在 */ }
  }
  const stmt = {
    getRuntime: db.prepare('SELECT * FROM runtime WHERE id = 1'),
    putRuntime: db.prepare(`INSERT INTO runtime(id,boot_id,pid,started_at,heartbeat_at) VALUES(1,?,?,?,?)
                            ON CONFLICT(id) DO UPDATE SET boot_id=excluded.boot_id, pid=excluded.pid,
                            started_at=excluded.started_at, heartbeat_at=excluded.heartbeat_at`),
    beat: db.prepare('UPDATE runtime SET heartbeat_at=? WHERE id=1 AND boot_id=?'),
    delRuntime: db.prepare('DELETE FROM runtime WHERE id=1 AND boot_id=?'),

    upSession: db.prepare(`INSERT INTO sessions(session_id,cwd,created_at,closed_at,origin,owner,owner_basis,lock_state,lock_at,lock_detail)
      VALUES(?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(session_id) DO UPDATE SET cwd=excluded.cwd, closed_at=excluded.closed_at,
        owner=excluded.owner, owner_basis=excluded.owner_basis, lock_state=excluded.lock_state,
        lock_at=excluded.lock_at, lock_detail=excluded.lock_detail`),
    getSession: db.prepare('SELECT * FROM sessions WHERE session_id=?'),
    setClosed: db.prepare('UPDATE sessions SET closed_at=? WHERE session_id=?'),
    setLock: db.prepare('UPDATE sessions SET lock_state=?, lock_at=?, lock_detail=? WHERE session_id=?'),
    allSessions: db.prepare('SELECT * FROM sessions ORDER BY created_at DESC'),

    insTask: db.prepare(`INSERT INTO tasks(task_id,session_id,idempotency_key,state,prompt_len,prompt_sha256,created_at,state_origin,cwd,can_retry,requires_human)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`),
    getTask: db.prepare('SELECT * FROM tasks WHERE task_id=?'),
    byIdem: db.prepare('SELECT * FROM tasks WHERE idempotency_key=?'),
    listUnsettled: db.prepare(`SELECT task_id,state,session_id FROM tasks WHERE state IN ('queued','running')`),
    listActive: db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE state IN ('queued','running')`),
    setState: db.prepare(`UPDATE tasks SET state=?, state_origin=?, started_at=COALESCE(?,started_at), finished_at=COALESCE(?,finished_at),
      stop_reason=?, error_code=?, error_message=?, can_retry=?, requires_human=? WHERE task_id=?`),
    setOutput: db.prepare('UPDATE tasks SET output_text=?, output_truncated=? WHERE task_id=?'),
    finish: db.prepare(`UPDATE tasks SET state=?, state_origin=?, finished_at=?, stop_reason=?, error_code=?, error_message=?,
      can_retry=?, requires_human=? WHERE task_id=?`),

    insEvent: db.prepare('INSERT INTO events(task_id,session_id,kind,payload,payload_truncated,at) VALUES(?,?,?,?,?,?)'),
    lastSeq: db.prepare('SELECT last_insert_rowid() AS seq'),
    eventsSince: db.prepare('SELECT seq,task_id,session_id,kind,payload,payload_truncated,at FROM events WHERE task_id=? AND seq>? ORDER BY seq LIMIT ?'),
    eventsTaskCount: db.prepare('SELECT COUNT(*) AS n FROM events WHERE task_id=?'),
    eventsAfterSeqGlobal: db.prepare('SELECT seq,kind,at FROM events WHERE task_id=? AND seq>? ORDER BY seq'),

    insProc: db.prepare(`INSERT INTO processes(pid,ppid,role,dsh_home,overlay_path,started_at,creation_time,exe_path,cmdline_fingerprint,parent_identity) VALUES(?,?,?,?,?,?,?,?,?,?)`),
    setProcIdentity: db.prepare('UPDATE processes SET creation_time=?, exe_path=?, cmdline_fingerprint=? WHERE id=?'),
    delProc: db.prepare('DELETE FROM processes WHERE id=?'),
    lastProcId: db.prepare('SELECT last_insert_rowid() AS id'),
    procByPid: db.prepare('SELECT * FROM processes WHERE pid=? ORDER BY id DESC LIMIT 1'),
    markProcExit: db.prepare('UPDATE processes SET exited_at=?, exit_code=?, exit_signal=?, stop_reason=? WHERE id=?'),
    openProcs: db.prepare('SELECT * FROM processes WHERE exited_at IS NULL'),
    allProcs: db.prepare('SELECT * FROM processes ORDER BY id DESC LIMIT ?'),

    insApproval: db.prepare('INSERT INTO approvals(task_id,session_id,tool,decision,reason,at) VALUES(?,?,?,?,?,?)'),
    approvalsByTask: db.prepare('SELECT tool,decision,reason,at FROM approvals WHERE task_id=? ORDER BY id'),

    tryCwdLock: db.prepare('INSERT INTO cwd_locks(cwd,task_id,pid,at) VALUES(?,?,?,?)'),
    getCwdLock: db.prepare('SELECT * FROM cwd_locks WHERE cwd=?'),
    delCwdLock: db.prepare('DELETE FROM cwd_locks WHERE cwd=? AND task_id=?'),

    insTest: db.prepare('INSERT INTO test_results(task_id,cwd,command,status,exit_code,summary,at) VALUES(?,?,?,?,?,?,?)'),
    testsByCwd: db.prepare('SELECT task_id,command,status,exit_code,summary,at FROM test_results WHERE cwd=? ORDER BY id DESC LIMIT ?'),
    testsByTask: db.prepare('SELECT task_id,command,status,exit_code,summary,at FROM test_results WHERE task_id=? ORDER BY id DESC LIMIT ?'),

    // 一次性预算：原子自增，超过 limit 时不生效（changes=0）
    tryIncBudget: db.prepare(`INSERT INTO budget(k,used,limit_,at) VALUES(?,1,?,?)
      ON CONFLICT(k) DO UPDATE SET used=budget.used+1, at=excluded.at WHERE budget.used < ?`),
    getBudget: db.prepare('SELECT * FROM budget WHERE k=?'),
  }

  function appendEvent(taskId, sessionId, kind, payload) {
    let raw = payload === undefined ? null : JSON.stringify(payload)
    let truncated = 0
    if (raw !== null && Buffer.byteLength(raw, 'utf8') > CFG.maxEventBytes) {
      // 必须保持 payload 是合法 JSON：截断的是内容预览，不是序列化文本本身
      const originalBytes = Buffer.byteLength(raw, 'utf8')
      const preview = truncate(raw, Math.max(256, CFG.maxEventBytes - 200))
      raw = JSON.stringify({ truncated: true, original_bytes: originalBytes, preview: preview.text })
      truncated = 1
    }
    stmt.insEvent.run(taskId ?? null, sessionId ?? null, kind, raw, truncated, Date.now())
    return stmt.lastSeq.get().seq
  }
  /** 安全解析历史 payload（兼容旧坏行，不抛异常）。 */
  function parsePayload(p) {
    if (p === null || p === undefined) return null
    try { return JSON.parse(p) } catch { return { unparsable: true, raw_prefix: String(p).slice(0, 200) } }
  }

  /** 启动恢复：绝不自动重发 prompt。 */
  function recover() {
    const out = { integrity: null, orphaned: [], recovery_pending: [], stale_processes: [] }
    try { out.integrity = db.prepare('PRAGMA quick_check').get()?.quick_check ?? 'unknown' } catch (e) { out.integrity = `error:${e.message}` }
    const unsettled = stmt.listUnsettled.all()
    for (const t of unsettled) {
      if (t.state === 'running') {
        stmt.finish.run('orphaned', 'gw', Date.now(), null, 'ORPHANED_AFTER_RESTART',
          'gateway restarted while the prompt was in flight; the ACP result is unknown and will NOT be resubmitted',
          0, 1, t.task_id)
        appendEvent(t.task_id, t.session_id, 'task.orphaned', { reason: 'gateway_restart', result: 'unknown', auto_resubmit: false })
        out.orphaned.push(t.task_id)
      } else {
        stmt.finish.run('recovery_pending', 'gw', Date.now(), null, 'RECOVERY_PENDING',
          'task was queued but never submitted; requires an explicit human decision before any resubmit',
          1, 1, t.task_id)
        appendEvent(t.task_id, t.session_id, 'task.recovery_pending', { submitted: false, auto_resubmit: false })
        out.recovery_pending.push(t.task_id)
      }
    }
    for (const p of stmt.openProcs.all()) {
      let alive = false
      try { process.kill(p.pid, 0); alive = true } catch { alive = false }
      if (!alive) {
        stmt.markProcExit.run(Date.now(), null, null, 'stale_record_pid_gone', p.id)
      } else {
        out.stale_processes.push(p)
      }
    }
    return out
  }

  /** 一次性预算自增：返回是否允许本次消耗（并发安全由 SQLite 事务保证）。 */
  function incBudget(k, limit) {
    const r = stmt.tryIncBudget.run(k, limit, Date.now(), limit)
    const row = stmt.getBudget.get(k)
    return { ok: r.changes === 1, used: row?.used ?? 0, limit }
  }
  function readBudget(k) { return stmt.getBudget.get(k) ?? null }

  return {
    db, stmt, appendEvent, parsePayload, recover, incBudget, readBudget,
    bootId: BOOT_ID,
    acquireRuntime() {
      const cur = stmt.getRuntime.get()
      if (cur) {
        let alive = false
        try { process.kill(cur.pid, 0); alive = true } catch { alive = false }
        if (alive && cur.boot_id !== BOOT_ID) {
          throw new ToolError('RUNTIME_LOCKED', 'another gateway instance holds this state directory', { holder_pid: cur.pid, holder_boot: cur.boot_id, started_at: cur.started_at })
        }
      }
      stmt.putRuntime.run(BOOT_ID, process.pid, Date.now(), Date.now())
      return stmt.getRuntime.get()
    },
    heartbeat() { stmt.beat.run(Date.now(), BOOT_ID) },
    releaseRuntime() { try { stmt.delRuntime.run(BOOT_ID) } catch { /* ignore */ } },
  }
}