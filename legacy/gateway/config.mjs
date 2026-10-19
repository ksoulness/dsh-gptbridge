/** 配置与常量：参数解析、路径、限额。所有值都可被 CLI 覆盖，默认保守。 */
import { resolve, join } from 'node:path'

function flag(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i > -1 && process.argv[i + 1] !== undefined && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback
}
function flagList(name) {
  const out = []
  process.argv.forEach((v, i) => { if (v === `--${name}` && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) out.push(process.argv[i + 1]) })
  return out
}
export function hasFlag(name) { return process.argv.includes(`--${name}`) }

const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d)

export const T0 = Date.now()
export const BOOT_ID = `${T0.toString(36)}-${process.pid}`

export const CFG = {
  mode: flag('acp-mode', 'mock'),                       // mock | real
  stateDir: resolve(flag('state', join(process.cwd(), 'state'))),
  port: num(flag('port', '0'), 0),
  host: '127.0.0.1',                                    // 固定回环，禁止改绑

  dshBin: flag('acp-bin', null),
  acpHome: flag('acp-home', null),                      // real 模式：隔离 DSH_HOME
  acpPatch: flag('acp-patch', null),                    // 额外补丁层（锁定 provider/model、关闭重试）
  acpExtraEnv: flagList('acp-env'),
  promptPrefix: flag('prompt-prefix', 'gpt指派｜'),   // 派发任务时给 prompt 加前缀 → DSH 会话标题以它开头，便于在 Web 列表识别
  mockDelay: num(flag('mock-delay', '1200'), 1200),
  mockAnswerBytes: num(flag('mock-answer-bytes', '0'), 0),
  mockToolKind: flag('mock-tool-kind', 'other'),
  mockToolTitle: flag('mock-tool-title', 'mock.write'),
  mockToolPath: flag('mock-tool-path', ''),
  mockToolRawInput: flag('mock-tool-rawinput', ''),

  cwdAllow: flagList('cwd-allow').map((p) => resolve(p)),

  requestTimeoutMs: num(flag('request-timeout-ms', '8000'), 8000),
  taskTimeoutMs: num(flag('task-timeout-ms', '60000'), 60000),
  shutdownGraceMs: num(flag('shutdown-grace-ms', '4000'), 4000),

  maxPromptBytes: num(flag('max-prompt-bytes', String(64 * 1024)), 64 * 1024),
  maxEventBytes: num(flag('max-event-bytes', String(8 * 1024)), 8 * 1024),
  maxResultBytes: num(flag('max-result-bytes', String(32 * 1024)), 32 * 1024),
  maxBodyBytes: num(flag('max-body-bytes', String(1024 * 1024)), 1024 * 1024),
  maxConcurrentTasks: num(flag('max-concurrent-tasks', '4'), 4),
  maxWorkspaces: num(flag('max-workspaces', '2'), 2),

  allowPermissionPrefixes: flagList('allow-permission').map((s) => s.toLowerCase()),
  permissionPolicy: flag('permission-policy', null),   // 任务级/路径级授权策略（JSON）
  readonlyMode: hasFlag('readonly'),                    // 只读 MCP 模式：服务端只暴露 klass=read 的工具
  allowHosts: String(flag('allow-host', '127.0.0.1,localhost')).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  // P2-B 一次性闸门：默认关闭真实提交；开启后仍受持久化预算约束
  allowRealSubmit: hasFlag('allow-real-submit'),
  maxRealPrompts: num(flag('max-real-prompts', '0'), 0),
  maxAssistantTurns: num(flag('max-assistant-turns', '0'), 0),
  gitTimeoutMs: num(flag('git-timeout-ms', '10000'), 10000),
  gitMaxBytes: num(flag('git-max-bytes', String(256 * 1024)), 256 * 1024),
}

export const ACP_OVERLAY = join(CFG.stateDir, 'acp-overlay.yml')
export const ACP_MARKER = `p2a-marker:${BOOT_ID}`
export const DB_PATH = join(CFG.stateDir, 'gateway.db')
export const VERSION = '0.2.0-p2a'

export const LIMITS = {
  maxPromptBytes: CFG.maxPromptBytes,
  maxEventBytes: CFG.maxEventBytes,
  maxResultBytes: CFG.maxResultBytes,
  maxBodyBytes: CFG.maxBodyBytes,
  maxConcurrentTasks: CFG.maxConcurrentTasks,
  maxWorkspaces: CFG.maxWorkspaces,
  maxRealPrompts: CFG.maxRealPrompts,
  maxAssistantTurns: CFG.maxAssistantTurns,
  requestTimeoutMs: CFG.requestTimeoutMs,
  taskTimeoutMs: CFG.taskTimeoutMs,
}
