#!/usr/bin/env node
/**
 * 身份校验式进程操作（P2-B-LOCAL-2）
 *   node gateway/proc-kill.mjs --capture --pid 1234
 *       → 输出身份 JSON { pid, creation, exe, fp }
 *   node gateway/proc-kill.mjs --pid 1234 --creation '2026/10/19 10:09:48' --fp <sha256> [--exe <path>]
 *       → 仅当身份完全一致才 taskkill /T /F；否则拒绝并 exit 2
 */
import { captureIdentity, killVerified } from './procguard.mjs'

const argv = process.argv.slice(2)
const flag = (n) => argv.includes(`--${n}`)
const val = (n, d = '') => { const i = argv.indexOf(`--${n}`); return i > -1 && argv[i + 1] ? argv[i + 1] : d }

const pid = Number(val('pid', '0'))
if (!pid) { console.error('missing --pid'); process.exit(3) }

if (flag('capture')) {
  const id = captureIdentity(pid)
  if (!id) { console.log(JSON.stringify({ captured: false, pid })); process.exit(2) }
  console.log(JSON.stringify({ captured: true, pid: id.pid, creation: id.creation, exe: id.exe, fp: id.fp }))
  process.exit(0)
}

const verdict = killVerified({ pid, creation: val('creation'), fp: val('fp'), exe: val('exe') })
console.log(JSON.stringify(verdict))
process.exit(verdict.killed ? 0 : 2)
