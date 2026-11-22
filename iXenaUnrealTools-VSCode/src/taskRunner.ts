import { t } from './i18n';
import * as vscode from 'vscode';
import { randomUUID, createHash } from 'node:crypto';

/** 所有构建均交给 VS Code Tasks；本类不自行捕获输出，也不创建第二套诊断。 */
export interface PreparedTask {
  original?: vscode.Task;
  /** 同一个 .uproject 的构建始终使用相同 Task 身份以复用专用终端。 */
  projectPath?: string;
  label: string;
  scope: vscode.WorkspaceFolder | vscode.TaskScope.Workspace | vscode.TaskScope.Global;
  process: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  problemMatchers: string[];
  presentation?: vscode.TaskPresentationOptions;
  group?: vscode.TaskGroup;
}

export interface RunResult {
  status: 'succeeded' | 'failed' | 'cancelled';
  exitCode?: number;
}

export interface RunState {
  status: 'idle' | 'preparing' | 'running' | 'stopping';
  label?: string;
  step?: number;
  total?: number;
}

interface PendingStep {
  id: string;
  execution?: vscode.TaskExecution;
  sawProcessEnd: boolean;
  ended: boolean;
  finished: boolean;
  terminationRequested: boolean;
  /** 仅向包含本项目任务稳定标记的终端发送 Ctrl+C，不影响其他终端。 */
  terminalTag: string;
  taskKey: string;
  interruptRequested: boolean;
  interruptSent: boolean;
  lookupTimer?: ReturnType<typeof setTimeout>;
  forceTimer?: ReturnType<typeof setTimeout>;
  exitCode?: number;
  timer?: ReturnType<typeof setTimeout>;
  resolve: (value: RunResult) => void;
  reject: (error: unknown) => void;
}

const OWNER = 'ixena-unreal-tools.ixena-unreal-tools-vscode';
// Ctrl+C 不会立即杀死任务终端；如果进程完全不响应，则保底终止，防止停止按钮永久卡住。
const TERMINAL_LOOKUP_TIMEOUT_MS = 1800;
const INTERRUPT_GRACE_MS = 10000;
const LOOKUP_INTERVAL_MS = 120;

/** 以项目路径派生稳定终端标题标记；相同项目复用，避免误杀其他 PowerShell。 */
export function taskTerminalTag(projectPath: string): string {
  return `ixena-${createHash('sha256').update(projectPath.replace(/\\/g, '/').toLowerCase()).digest('hex').slice(0, 8)}`;
}

export function matchingTaskTerminal(terminals: readonly vscode.Terminal[], tag: string): vscode.Terminal | undefined {
  const matches = terminals.filter(terminal => terminal.name.includes(tag));
  return matches.length === 1 ? matches[0] : undefined;
}

export function isOwnedTask(task: vscode.Task): boolean {
  return task.definition.type === 'ixena-unreal-tools' && task.definition.owner === OWNER;
}

/** 逐步执行、精确取消，并在收到真正的任务结束事件后恢复按钮。 */
export class NativeTaskRunner implements vscode.Disposable {
  private readonly changes = new vscode.EventEmitter<RunState>();
  readonly onDidChangeState = this.changes.event;
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly adopted = new Set<vscode.TaskExecution>();
  private source?: vscode.CancellationTokenSource;
  private pending?: PendingStep;
  private value: RunState = { status: 'idle' };
  private disposed = false;

  constructor(private readonly log: (message: string) => void) {
    this.subscriptions.push(
      vscode.tasks.onDidStartTask(event => {
        const step = this.match(event.execution);
        if (!step) { return; }
        step.execution = event.execution;
        if (this.source?.token.isCancellationRequested) { this.requestInterrupt(step, event.execution); }
      }),
      vscode.tasks.onDidEndTaskProcess(event => {
        const step = this.match(event.execution);
        if (!step) { return; }
        step.sawProcessEnd = true;
        step.exitCode = event.exitCode;
        if (step.ended) { this.finishStep(step); }
      }),
      vscode.tasks.onDidEndTask(event => {
        if (this.adopted.delete(event.execution)) {
          if (!this.adopted.size && !this.source) { this.setState({ status: 'idle' }); }
        }
        const step = this.match(event.execution);
        if (!step) { return; }
        step.ended = true;
        // 某些任务启动失败时没有 ProcessEnd；不能把缺失退出码当作成功。
        // 短暂让出事件循环，同时兼容快速结束时的事件抵达顺序。
        if (step.sawProcessEnd) { this.finishStep(step); }
        else { step.timer = setTimeout(() => this.finishStep(step), 100); }
      })
    );
    // 重载窗口后，只接管带本插件标记的在运行任务，不影响其他扩展的任务。
    for (const execution of vscode.tasks.taskExecutions) {
      if (isOwnedTask(execution.task)) { this.adopted.add(execution); }
    }
    if (this.adopted.size) {
      this.value = { status: 'running', label: t("已恢复正在运行的 iXenaUnrealTools 构建") };
    }
  }

  get state(): RunState { return { ...this.value }; }
  get isBusy(): boolean { return Boolean(this.source) || this.adopted.size > 0; }

  async run(
    title: string,
    prepare: (token: vscode.CancellationToken) => Promise<PreparedTask[]>
  ): Promise<RunResult> {
    if (this.disposed) { throw new Error(t("构建器已关闭。")); }
    if (this.isBusy) { throw new Error(t("已有 iXenaUnrealTools 构建正在运行，请等待完成或点击停止。")); }
    const source = new vscode.CancellationTokenSource();
    this.source = source;
    this.setState({ status: 'preparing', label: title });
    try {
      const steps = await prepare(source.token);
      if (source.token.isCancellationRequested) { return { status: 'cancelled' }; }
      if (!steps.length) { throw new Error(t("没有可执行的构建步骤。")); }
      for (let index = 0; index < steps.length; index++) {
        if (source.token.isCancellationRequested) { return { status: 'cancelled' }; }
        const step = steps[index];
        this.setState({ status: 'running', label: step.label, step: index + 1, total: steps.length });
        const result = await this.executeStep(step);
        if (result.status !== 'succeeded') { return result; }
      }
      return source.token.isCancellationRequested
        ? { status: 'cancelled' }
        : { status: 'succeeded', exitCode: 0 };
    } catch (error) {
      if (source.token.isCancellationRequested) { return { status: 'cancelled' }; }
      throw error;
    } finally {
      this.pending = undefined;
      this.source = undefined;
      source.dispose();
      this.setState({ status: 'idle' });
    }
  }

  cancel(): void {
    if (!this.isBusy || this.value.status === 'stopping') { return; }
    this.setState({ ...this.value, status: 'stopping' });
    this.source?.cancel();
    this.log(t("请求停止当前构建，等待 VS Code 任务结束事件。"));
    if (this.pending?.execution) { this.requestInterrupt(this.pending, this.pending.execution); }
    for (const execution of this.adopted) { this.interruptAdoptedTask(execution); }
  }

  private match(execution: vscode.TaskExecution): PendingStep | undefined {
    const step = this.pending;
    if (!step || step.finished || !isOwnedTask(execution.task)) { return undefined; }
    if (step.execution && step.execution !== execution) { return undefined; }
    return execution.task.definition.taskKey === step.taskKey ? step : undefined;
  }

  private executeStep(step: PreparedTask): Promise<RunResult> {
    const id = randomUUID();
    const taskKey = (step.projectPath || step.cwd).replace(/\\/g, '/').toLowerCase();
    const terminalTag = taskTerminalTag(taskKey);
    const execution = new vscode.ProcessExecution(step.process, step.args, {
      cwd: step.cwd,
      env: step.env
    });
    const task = new vscode.Task(
      { type: 'ixena-unreal-tools', owner: OWNER, taskKey },
      step.scope,
      `iXena Unreal Build [${terminalTag}]`,
      'iXenaUnrealTools',
      execution,
      step.problemMatchers
    );
    task.isBackground = false;
    task.group = step.group ?? step.original?.group ?? vscode.TaskGroup.Build;
    task.presentationOptions = {
      ...step.original?.presentationOptions,
      ...step.presentation,
      // 任务终止时 VS Code 可能销毁终端；以下选项尽量保留可用终端，
      // 对真正已回收的终端，BuildController 还会从 UBT 的 Log.txt 创建独立快照。
      reveal: vscode.TaskRevealKind.Always,
      panel: vscode.TaskPanelKind.Dedicated,
      focus: false,
      close: false,
      clear: false,
      showReuseMessage: true
    };
    task.runOptions = { ...step.original?.runOptions, reevaluateOnRerun: true };
    task.detail = t("{0} · 重用本项目构建终端；直接运行 UBT。", step.label);
    this.log(t("任务：{0}", step.label));
    this.log(t("进程：{0}", step.process));
    this.log(t("参数：{0}", JSON.stringify(step.args)));
    this.log(t("目录：{0}", step.cwd));
    return new Promise<RunResult>((resolve, reject) => {
      const pending: PendingStep = {
        id, terminalTag, taskKey, interruptRequested: false, interruptSent: false,
        sawProcessEnd: false, ended: false, finished: false, terminationRequested: false, resolve, reject
      };
      // 必须先设置关联，再调用 executeTask，防止极短任务先触发结束事件。
      this.pending = pending;
      try {
        Promise.resolve(vscode.tasks.executeTask(task)).then(result => {
          if (pending.finished) { return; }
          pending.execution = result;
          if (this.source?.token.isCancellationRequested) { this.requestInterrupt(pending, result); }
        }, error => this.rejectStep(pending, error));
      } catch (error) { this.rejectStep(pending, error); }
    });
  }

  private finishStep(step: PendingStep): void {
    if (step.finished) { return; }
    step.finished = true;
    if (step.timer) { clearTimeout(step.timer); }
    if (step.lookupTimer) { clearTimeout(step.lookupTimer); }
    if (step.forceTimer) { clearTimeout(step.forceTimer); }
    const cancelled = Boolean(this.source?.token.isCancellationRequested);
    const result: RunResult = {
      status: cancelled ? 'cancelled' : step.sawProcessEnd && step.exitCode === 0 ? 'succeeded' : 'failed',
      exitCode: step.exitCode
    };
    this.log(t("任务结束：{0}；退出码：{1}", result.status, String(result.exitCode)));
    step.resolve(result);
  }

  /**
   * 停止优先投递与手动 Ctrl+C 相同的 ETX（0x03），让 UBT 自行退出。
   * VS Code TaskExecution 没有公开 terminal 属性：以本项目稳定任务名寻找终端，绝不向当前焦点终端盲发信号。
   * 找不到目标终端或 UBT 不响应时才退回 terminate()，保留 0.2.1 的日志快照机制。
   */
  private requestInterrupt(step: PendingStep, execution: vscode.TaskExecution): void {
    if (step.finished || step.terminationRequested || step.interruptRequested) { return; }
    step.interruptRequested = true;
    const beganAt = Date.now();
    const attempt = (): void => {
      if (step.finished || step.terminationRequested) { return; }
      const terminal = matchingTaskTerminal(vscode.window.terminals, step.terminalTag);
      if (terminal) {
        try {
          terminal.sendText('\u0003', false);
          step.interruptSent = true;
          this.log(t("已向本次构建终端发送 Ctrl+C（{0}），保留终端输出。", terminal.name));
          step.forceTimer = setTimeout(() => {
            if (!step.finished && !step.terminationRequested) {
              this.log(t("Ctrl+C 后 10 秒任务仍未结束，执行保底终止（终端可能被回收）。"));
              this.terminateStep(step, execution);
            }
          }, INTERRUPT_GRACE_MS);
          return;
        } catch (error) {
          this.log(t("向构建终端发送 Ctrl+C 失败：{0}", String(error)));
          this.terminateStep(step, execution);
          return;
        }
      }
      if (Date.now() - beganAt >= TERMINAL_LOOKUP_TIMEOUT_MS) {
        this.log(t("未找到本次构建专属终端（{0}），为保证能够停止，改用任务终止接口。", step.terminalTag));
        this.terminateStep(step, execution);
      } else {
        step.lookupTimer = setTimeout(attempt, LOOKUP_INTERVAL_MS);
      }
    };
    attempt();
  }

  /** 窗口恢复后重新接管的任务同样尝试准确发送 Ctrl+C。 */
  private interruptAdoptedTask(execution: vscode.TaskExecution): void {
    const match = /\[(ixena-[0-9a-f]{8})\]/.exec(execution.task.name);
    const terminal = match && matchingTaskTerminal(vscode.window.terminals, match[1]);
    if (!terminal) {
      this.log(t("无法定位恢复任务的专属终端，使用原生停止功能。"));
      execution.terminate();
      return;
    }
    try {
      terminal.sendText('\u0003', false);
      this.log(t("已向恢复任务终端发送 Ctrl+C（{0}）。", terminal.name));
      setTimeout(() => {
        if (this.adopted.has(execution)) { execution.terminate(); }
      }, INTERRUPT_GRACE_MS);
    } catch {
      execution.terminate();
    }
  }

  private terminateStep(step: PendingStep, execution: vscode.TaskExecution): void {
    if (step.finished || step.terminationRequested) { return; }
    step.terminationRequested = true;
    if (step.lookupTimer) { clearTimeout(step.lookupTimer); }
    if (step.forceTimer) { clearTimeout(step.forceTimer); }
    execution.terminate();
  }

  private rejectStep(step: PendingStep, error: unknown): void {
    if (step.finished) { return; }
    step.finished = true;
    if (step.timer) { clearTimeout(step.timer); }
    if (step.lookupTimer) { clearTimeout(step.lookupTimer); }
    if (step.forceTimer) { clearTimeout(step.forceTimer); }
    step.reject(error);
  }

  private setState(state: RunState): void {
    this.value = state;
    if (!this.disposed) { this.changes.fire(this.state); }
  }

  dispose(): void {
    this.disposed = true;
    // 重载/关闭扩展不擅自终止构建，下一次激活会从 taskExecutions 恢复。
    this.subscriptions.forEach(value => value.dispose());
    this.changes.dispose();
    if (this.pending?.timer) { clearTimeout(this.pending.timer); }
    if (this.pending?.lookupTimer) { clearTimeout(this.pending.lookupTimer); }
    if (this.pending?.forceTimer) { clearTimeout(this.pending.forceTimer); }
  }
}
