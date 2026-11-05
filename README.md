# dsh-cli

**让 DeepSeek Harness 调用你本机已经安装并登录的 AI 工具，用上各家的订阅额度和独有能力。**

对 dsh 说"出一条 6 秒的产品视频"，它会通过 MiniMax Code 生成，再把文件交给你，全程不用切窗口。

名字里的 cli 指它调用各家的命令行。纯图形界面的 IDE 也在计划内，第一版还没有。

## 支持什么

| 目标 | 类型 | 能做什么 | 需要 |
|---|---|---|---|
| `minimax` | 调用工具 | 图片、视频、音频、音乐 | 安装并登录 MiniMax Code，没开时会自动在后台启动 |
| `qoder` | 委托 agent | 把代码任务交给它 | 安装 Qoder CLI，并运行 `qodercli login` |
| `opencode` | 委托 agent | 免费模型写文字（只读模式） | 安装 OpenCode。免费模型可能用输入改进模型，不要发敏感内容 |
| `ffmpeg`、`say`、`blender`、`chrome` | 普通程序 | 处理音视频、系统语音、3D 渲染、网页截图 | 安装对应程序；`say` 只有 macOS 有 |

插件只做桥梁：用哪家、怎么拆任务、结果好不好，都由 dsh 的模型判断。

## 安装

```bash
dsh plugin --profile desktop add dsh-cli
```

把 `desktop` 换成你用的 profile，然后重启 dsh。

## 怎么用

直接说就行：

- `用 MiniMax 出一条 6 秒的视频：日出时水面上的纸船`
- `把这个项目的 README 翻译成英文，交给 Qoder 去做`
- `看看我能调用哪些 AI 工具`

## 对话顶部的开关

每个对话顶部有一个 `CLI` 按钮：

| 按钮 | 意思 |
|---|---|
| `CLI` 灰 | 自动：dsh 自己判断要不要调用、调用哪家。这是默认状态 |
| `CLI · Qoder 12s` 黄并闪动 | 正在调用，多个时显示 `+2` |
| `Qoder 直通` 绿 | 这个对话指定交给 Qoder |
| `MiniMax` 绿 | 这个对话的图片、视频、音频、音乐指定用 MiniMax |
| 红 | 指定了但现在用不了，比如没登录 |

点开是面板：可以搜索名字或能力（比如"视频"），最近用过的排最前，其余按能力分组，没装的折叠。接几十家也放得下。

- **直通（比如 Qoder）：** 消息直接交给它，在这个对话的工作目录里干活。**不经过 dsh 的模型，不花 dsh 的 token**，但也没有人帮你检查结果。切回自动再指定，它还记得之前的内容。
- **经 dsh（比如 MiniMax）：** 工具要有模型来填参数，所以仍然走 dsh 的模型，会花 dsh 的 token。
- **自动：** 回到原来的模型。

直通目前只转交文字，附件不会传过去。取消时会终止对方，但已经写好的文件不会回滚。

只影响当前对话。有任务在跑时，输入框下方会多一行，后台任务可以直接停止。鼠标停在按钮上能看到这个对话调用了几次、用了多少。

## 费用和权限

**这个插件花的是你自己的额度。**

- **MiniMax：** 只有明确是只读的调用（查询、列表等）不问你，其余都先弹确认框，包括生成视频。根据官方工具说明，M Plan 周限额不够付整条视频时，**会扣账户积分**。
- **Qoder：** 默认用 `accept_edits`，只能改工作目录内的文件，不能执行命令，也不能写到目录外。工作目录不能是根目录或家目录。
- **模型不该给自己提权：** 工具里没有跳过权限的参数。模型用 bash 直接运行 `qodercli` 或 `mcode-tools` 也会被拦下，要改走 `cli_run`。这个拦截靠匹配命令文字，能防顺手绕过，但不是安全边界。想关掉就在配置里写 `"guard": false`。
- **不碰凭证：** 只调用官方命令行，用你自己的登录状态。不读取、不保存、不转发 token。登录要你自己完成。

Qoder 被权限拒绝时不算报错，原因只写在回复里，所以模型会被要求自己检查实际改动。

## 配置

一般不需要。想改默认值，或者自己加一家 agent，就编辑 `$DSH_HOME/dsh-cli/config.json`（默认 `~/.dsh/dsh-cli/config.json`）：

```json
{
  "targets": {
    "qoder": { "permission": "default" },
    "minimax": { "confirm": false, "env": { "MCODE_REGION": "cn" } },
    "my-cli": { "kind": "agent", "command": "my-cli", "run": ["-p", "{prompt}"], "capabilities": ["code"] }
  }
}
```

- `capabilities`：能力标签，可选 `code`、`video`、`image`、`audio`、`music`。面板按它分组，dsh 也按它筛选。

- `permission`：Qoder 的权限模式。设成 `bypass_permissions` 会完全跳过权限，这时每次调用都会先问你。
- `confirm`：设成 `false` 关闭 MiniMax 的确认框，**之后生成视频不再问你**。
- `env`：运行时附加的环境变量。同时装了 MiniMax 国内版和海外版时，必须用 `MCODE_REGION` 指定。

任务结果保存在 `$DSH_HOME/dsh-cli/jobs/`，超过 7 天或超过 50 个的旧任务会被清理。结果里可能有带签名的下载地址，目录权限只有你自己能读。

## 限制

- `minimax` 的自动启动目前只支持 macOS。
- `mcode-tools` 不是 MiniMax 承诺稳定的接口，升级后可能变化。
- 各家对自动化调用的条款，请你自己确认。本插件没有得到这些厂商的背书。

## 开发

```bash
npm test
```

用真实的 DSH 代码校验：

```bash
DSH_MODULES=/path/to/node_modules npm test
```

## 可以叠在桥上的插件

只装 `dsh-cli` 就有完整的桥。需要更多时再装，设置页里也能看到这份列表：

| 插件 | 适合 | token 开销 |
|---|---|---|
| `dsh-cli-flow` | 短剧、PPT、短视频、商品上架这类多步骤的工作 | 每次请求多约 400 |
| `dsh-cli-flow-audio` | 只想把文字变成配音和对应的字幕（目前只支持 macOS） | 不再增加 |

```bash
dsh plugin --profile desktop add dsh-cli-flow
dsh plugin --profile desktop add dsh-cli-flow-audio
```

装上面一层会自动带上下面几层，装完重启 dsh。

设计细节和验证记录见 [设计方案.md](设计方案.md)。

## License

MIT
