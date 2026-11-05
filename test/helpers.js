// test/helpers.js — 假的 qodercli 和 mcode-tools，不花额度也不碰真实账号

import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 把收到的参数和工作目录记下来，再按第一个可识别的场景回应
const FAKE_QODER = `#!/bin/sh
printf '%s\\n' "$@" > "$FAKE_LOG/qoder-args"
pwd -P > "$FAKE_LOG/qoder-cwd"
if [ "$1" = "status" ]; then
  echo "Version: 1.1.31"
  echo "Account: \${FAKE_ACCOUNT:-someone@example.com}"
  exit 0
fi
last=""
for a in "$@"; do last="$a"; done
sid="fixed-session-0001"
prev=""
for a in "$@"; do
  if [ "$prev" = "--session-id" ] || [ "$prev" = "-r" ]; then sid="$a"; fi
  prev="$a"
done
case "$last" in
  *NOTLOGGED*) echo '{"type":"result","subtype":"success","is_error":true,"result":"Not logged in · Please run /login","session_id":"'"$sid"'"}'; exit 1 ;;
  *CRASH*) echo 'boom on stderr' >&2; exit 42 ;;
  *SLOW*) sleep 30; echo '{"is_error":false,"result":"late","session_id":"'"$sid"'"}'; exit 0 ;;
  *MAKEFILE*) echo hello > made.txt ;;
  *HUGE*) python3 -c "import json;print(json.dumps({'is_error':False,'result':'H'*50000,'session_id':'$sid'}))"; exit 0 ;;
esac
echo '{"type":"result","subtype":"success","is_error":false,"result":"PONG","session_id":"'"$sid"'","total_credits":0.25,"permission_denials":[]}'
`

const FAKE_MCODE = `#!/bin/sh
printf '%s\\n' "$@" > "$FAKE_LOG/mcode-args"
case "$1 $2" in
  "auth status") echo '{"status":"'"\${FAKE_AUTH:-authenticated}"'"}'; exit 0 ;;
  "connector tools") echo '{"tools":[{"tool_name":"connector__matrix__submit_video_generation"}]}'; exit 0 ;;
  "connector tool") echo '{"tool_name":"'"$3"'","input_schema":{}}'; exit 0 ;;
  "connector call")
    cp "$5" "$FAKE_LOG/mcode-call-args"
    case "$3" in
      *FAIL*) echo '{"code":1001,"message":"bad"}'; exit 0 ;;
      *) echo '{"code":0,"task_id":"t1","status":"submitted"}'; exit 0 ;;
    esac ;;
esac
case "$1" in
  get-asset-url) echo '{"node_id":"'"$2"'","download_url":"https://example.test/x.mp4"}'; exit 0 ;;
  upload-temp-url) echo '{"temp_url":"https://example.test/tmp"}'; exit 0 ;;
esac
echo unknown >&2
exit 2
`

export async function writeExecutable(path, content) {
  await writeFile(path, content)
  await chmod(path, 0o755)
}

/** 一个隔离的环境：临时 HOME、DSH_HOME 和只有假命令的 PATH */
export async function makeEnv({ qoder = true, minimax = true, account, auth } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-cli-test-'))
  const home = join(root, 'home')
  const bin = join(root, 'bin')
  const log = join(root, 'log')
  await mkdir(home, { recursive: true })
  await mkdir(bin, { recursive: true })
  await mkdir(log, { recursive: true })
  if (qoder) await writeExecutable(join(bin, 'qodercli'), FAKE_QODER)
  const launcher = join(home, '.minimax', 'bin', 'mcode-tools')
  if (minimax) await installMinimax(home)
  return {
    root,
    home,
    log,
    launcher,
    env: {
      HOME: home,
      DSH_HOME: join(home, '.dsh'),
      PATH: `${bin}:/usr/bin:/bin`,
      FAKE_LOG: log,
      ...(account ? { FAKE_ACCOUNT: account } : {}),
      ...(auth ? { FAKE_AUTH: auth } : {}),
    },
  }
}

export async function installMinimax(home) {
  const dir = join(home, '.minimax', 'bin')
  await mkdir(dir, { recursive: true })
  await writeExecutable(join(dir, 'mcode-tools'), FAKE_MCODE)
}

/** 记录问过什么，并按指定结果回答 */
export function fakeCtx(outcome = 'allowed-once') {
  const asked = []
  return {
    asked,
    get: (key) => (key === 'approval'
      ? { request: async (req) => { asked.push(req); return outcome } }
      : undefined),
  }
}
