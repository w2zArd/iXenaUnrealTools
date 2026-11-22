# iXenaUnrealBridge 文件协议 v1

协议只用于同一台机器上的可信编辑器/VSCode。字符编码为 UTF-8；JSON 必须先写同目录临时文件，再 rename 成最终名称，读取方应容忍原子替换期间的短暂不可见。

## 实例描述

位置：`<project>/Saved/iXenaUnrealBridge/instances/<PID>-<GUID>/instance.json`。

```json
{
  "protocol": 1,
  "pluginVersion": "0.6.0",
  "instanceId": "1234-00000000-1111-2222-3333-444444444444",
  "token": "64位小写十六进制会话值",
  "processId": 1234,
  "projectPath": "D:/Develop/UnrealEngine/UE5Test/UE5Test.uproject",
  "engineRoot": "D:/Engines/UE_5.9/",
  "engineVersion": "所用引擎的 FEngineVersion 字符串",
  "platform": "Win64",
  "startedAt": "2026-11-22T00:00:00.000Z",
  "updatedAt": "2026-11-22T00:00:01.000Z",
  "status": "ready",
  "liveCodingAvailable": true,
  "liveCodingEnabled": true
}
```

实例编号等于目录名。GUID 格式为小写、带连字符；token 是两个随机 GUID 的 64 位十六进制串。实例编号和 token 每次编辑器启动都改变。心跳每秒发布，状态为 `ready` 或 `compiling`。原生等待编译时主线程心跳可能暂停，客户端不得把 `compiling` 的过期心跳当作允许发起第二次编译的依据。

## 请求与响应

客户端使用规范的小写 UUID 作为请求 id，写入 `Requests/<id>.json`：

```json
{
  "protocol": 1,
  "id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  "instanceId": "1234-00000000-1111-2222-3333-444444444444",
  "token": "与该实例描述一致的值",
  "command": "compile",
  "createdAt": "2026-11-22T00:00:02.000Z"
}
```

命令只允许 `ping`、`compile`、`listConsole`、`executeConsole`。单个请求最多 16 KiB；超过 60 秒或超前本机时间超过 30 秒的未执行请求会拒绝。插件先把请求移到 `Processing` 后读取并删除，最终写 `Responses/<id>.json`。本实例已领取过的 UUID 会保留在会话去重集合中；即使客户端随后删除响应，该 UUID 也不会执行第二次。

```json
{
  "protocol": 1,
  "id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  "instanceId": "1234-00000000-1111-2222-3333-444444444444",
  "ok": true,
  "status": "Success",
  "output": "本轮有界日志文本",
  "message": "UE Live Coding 已返回最终结果。",
  "completedAt": "2026-11-22T00:00:10.000Z"
}
```

客户端必须验证协议、id、实例编号和所有字段类型。编译成功仅为 `ok=true` 且 `status` 为 `Success`/`NoChanges`；ping 为 `Ready`。其他可能状态：`Failure`、`NotEnabled`、`NotAvailable`、`CompileStillActive`、`Unknown`、`InvalidRequest`、`Expired`。客户端可兼容 `NotStarted`/`Cancelled`，当前桥的编译适配将未稳定命名的原生枚举统一保留为 `Unknown` 加数字说明。

实时日志路径由客户端以自己的 id 构造：`Logs/<id>.log`，不要接受服务端提供的任意绝对路径。插件以允许并发读取的方式创建文件并逐行刷新 UTF-8 字节。最终 `output` 可能重复已读取的内容，客户端应去重显示。日志源及限额见 README。

## 超时和停止

本协议没有取消已开始的原生 Live Coding 编译的命令。客户端超时或关闭后不应自动重试 compile，也不能改走标准 UBT 并发构建。只能确认当前实例状态后，由用户重新发起新的请求。控制台执行同样不能自动重试；退出编辑器等命令可能在响应落盘之前使进程关闭。

## 控制台命令 / CVar

`listConsole` 请求的 `parameters` 为 `{ "filter": "r.Shadow", "cursor": 0, "limit": 100 }`。filter 最多 256 字符，按名称不区分大小写过滤；cursor 是 0–50000 的整数，limit 为 1–100。注册表名称缓存两秒，分页时读取最新变量值。返回 `ok:true,status:"ConsoleList"`，并包含额外的 `data`：

```json
{
  "items": [
    { "name": "t.MaxFPS", "help": "引擎提供的帮助文本", "type": "variable", "value": "0", "flags": 0 }
  ],
  "total": 1
}
```

有后续页时包含数字 `nextCursor`。type 仅为 `command`/`variable`，命令可省略 value；flags 是原始 `EConsoleVariableFlags` 整数。help、value 和列表数量都有上限。部分 `stat`/`show` 等 Exec 命令没有注册对象，不在此列表内。

`executeConsole` 请求的 `parameters` 为 `{ "command": "t.MaxFPS 60" }`。必须是最多 4096 字符的非空单行，不允许 NUL、CR、LF、`;`、`|`。游戏线程先调用 `IConsoleManager::ProcessUserConsoleInput`，未处理时再调用 `GEditor->Exec`，世界上下文为 Editor 世界。

返回 `ok:true,status:"Executed"` 或 `ok:false,status:"NotHandled"`，output 为有界控制台回复。Executed 仅表示引擎识别并处理输入，不能推断异步任务成功。客户端必须让用户明确提交此输入；列表查询不得隐式执行命令。

## 性能快照

实例目录中的 `metrics.json` 每秒原子更新：

```json
{
  "protocol": 1,
  "instanceId": "1234-00000000-1111-2222-3333-444444444444",
  "processId": 1234,
  "updatedAt": "2026-11-22T00:00:10.000Z",
  "processMemoryBytes": 2147483648,
  "peakProcessMemoryBytes": 2684354560,
  "availablePhysicalBytes": 17179869184,
  "cpuTimePct": 8,
  "cpuTimePctRelative": 48,
  "frameDeltaMs": 16.67,
  "debuggerAttached": false
}
```

示例数字仅解释字段，不是实际测量。CPU 未建立基线或采样无效时省略相应字段。帧间隔不是线程/GPU耗时；进程内存和系统可用内存含义不同。客户端必须验证 protocol、instanceId、processId、时间戳和数字范围；断点、卡顿或编译等待造成过期时，保留最后样本并标明过期，不伪造实时零值。

## 界面语言

协议状态名、命令名和字段名不随界面语言改变。message / output 中由插件生成的文本跟随 UE 插件的 Auto / zh-CN / en 设置；引擎原始日志和控制台帮助不重新翻译。语言选择属于当前项目的编辑器用户设置，不修改项目共享配置或 UE 全局 Culture。
