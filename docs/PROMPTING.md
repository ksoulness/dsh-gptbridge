# 怎么跟 GPT 描述你要做的事

一句话原则：**说清楚「在哪做、做什么、做到什么算完」，剩下的交给它自己调工具。**

## 0. 模板（复制就能用）

```text
[dsh 连接器] 在 <工作区路径> 里 <做/只读核对>：
<具体要改什么 / 要查什么，1-3 条>
完成后：<验收标准，比如"node x.js 输出 hello"、"只回答字节数和标题列表">
不要动 <不该碰的路径>。
```

只要这四行，GPT 就会自己走 `list_workspaces → list_capabilities → start_run/start_review → wait_run`。

## 1. 四个常用句式

**① 只读审查（不改文件）**
```text
用 dsh 连接器，在 E:\Code\主机NAS 只读核对：
1) PROJECT.md 总字节数、行数、一级标题列表
2) 找出"最近更新"段落在第几行
只回答这三项，不要修改任何文件。
```

**② 写入实现（改代码/写文件）**
```text
用 dsh 连接器，在 E:\Code\<项目> 里实现：
- 新增 src/foo.ts，导出 parseBar(input: string)
- 在 src/index.ts 里接上它
- 跑 npm test，把失败信息贴出来
只能改 src/ 下的文件。
```

**③ 长任务（跑脚本/批量处理/等结果）**
```text
用 dsh 连接器，在 E:\Code\<项目> 里跑一次长任务：
- 执行 node scripts/bench.mjs --30min
- 全程不要中断；把最后 20 行输出和退出码贴给我
- 超过 30 分钟就停下来报告进度
```

**④ 续聊 / 纠正（同一个会话往下做）**
```text
接着刚才那个会话继续：<新的要求>。
用 reply_run（终态后）或 steer_run（还在跑时），不要新开会话。
```

## 2. 写需求时的 5 个要素（缺哪个都容易返工）

| 要素 | 例子 | 为什么 |
|---|---|---|
| **工作区** | `E:\Code\主机NAS` | 决定权限边界与侧栏归属 |
| **动作** | "新增/修改/删除/只读核对" | 决定它用 `start_run` 还是 `start_review` |
| **对象** | `src/foo.ts`、`PROJECT.md` | 少了它就自己去猜，容易改错文件 |
| **验收** | "跑通 npm test"、"只回答 3 行" | 决定 `wait_run` 何时算完成 |
| **禁区** | "别动 .git / .env / 其他项目" | 越界动作会触发审批 → 卡住 |

## 3. 常见坑与说法

| 现象 | 原因 | 你该怎么说 |
|---|---|---|
| 任务一直 running 不动 | 用了 `start_review` 却要写文件；或权限档不是完全权限 | 明确写"**把文件改掉**"，并（若自己传参）带 `permissionPreset:"danger-full-access"` |
| 改到了别的目录 | 没写禁区 | 加一句"只允许改 `X/` 下的文件" |
| 会话出现在「未分组」 | 会话不是 DSH 原生创建的 | 用本连接器（`start_run`/`start_review`）创建 |
| 侧栏标题乱 | 前缀叠加 | 现在会自动归一成 `gpt指派-<原题>` |
| 想留着会话但被归档了 | 归档=从侧栏隐藏 | 说"**不要归档**"；或之后让它 `unarchive` |

## 4. 可以直接固定成开场白

把这段贴在对话开头，后面只说需求即可：

```text
你用 dsh 连接器帮我干活。规则：
1) 要改文件/跑命令，用 start_run；只读核对用 start_review
2) start_run 必须带 permissionPreset:"danger-full-access" 和 confirmedDangerousPermission:true
3) 派完就 wait_run 到终态（succeeded/failed/cancelled/timeout/orphaned），中途不要停
4) 结束后把 assistantText 原文贴出来，不要摘要
5) 不要归档，除非我说"归档"
6) 只改我指定目录里的文件
```

## 5. 三个反例（别这么写）

- ❌ "帮我看看这个项目" → 没有工作区、没有验收标准
- ❌ "把代码优化一下" → 没有对象、没有边界，容易大改
- ❌ "随便跑跑" → 没有命令、没有停止条件

改成："在 `E:\Code\perp` 里，只读分析 `src/engine.ts` 的复杂度热点，列出前 3 处并给出改法建议，不要改文件。"
