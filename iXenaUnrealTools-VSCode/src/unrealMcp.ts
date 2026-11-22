import { t, tr } from './i18n';
import { communicationTranslations } from './locales/communication';
import { registerTranslations } from './i18n';
registerTranslations(communicationTranslations);
import * as path from 'node:path';
import { normalizeMcpHost, normalizeMcpPort, normalizeMcpPath } from './connectionSetup';
/** Epic Unreal MCP 的可选客户端；没有 AI 服务、快捷键注入或普通 UBT 回退。 */
export interface UnrealMcpConfig {
    url: string;
    projectPath: string;
    engineRoot: string;
    timeoutSeconds?: number;
}
export type McpCompileStatus = 'Success' | 'NoChanges' | 'Failure' | 'NotEnabled' | 'NotAvailable' | 'CompileStillActive' | 'InProgress' | 'Cancelled' | 'NotStarted' | 'Unknown';
export interface McpCompileResult {
    status: McpCompileStatus;
    rawOutput: string;
    isError: boolean;
}
export interface McpConnectionInfo {
    transport: 'mcp';
    url: string;
    processId: number;
    projectPath: string;
    engineRoot: string;
    engineVersion: string;
    toolName: string;
    liveCodingAvailable: boolean;
    message?: string;
}
type EditorIdentity = Omit<McpConnectionInfo, 'toolName' | 'liveCodingAvailable' | 'message'>;
/** uncertain 为 true 时请求可能已经开始，调用者不得自动重试或转成 UBT 编译。 */
export class UnrealMcpError extends Error {
    constructor(message: string, public readonly uncertain = false) {
        super(message);
        this.name = 'UnrealMcpError';
    }
}
type JsonObject = Record<string, unknown>;
type Tool = {
    name: string;
    inputSchema: JsonObject;
};
type CompileTool = {
    name: string;
    arguments: JsonObject;
    displayName: string;
};
type Progress = (message: string) => void;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_TOOL_PAGES = 32;
const INSTANCE_KEY = 'com.epicgames.unrealengine/instance';
const TOOL_NAME = 'CompileLiveCoding';
const TOOLSETS = ['LiveCodingToolset.LiveCodingToolset', 'LiveCodingToolset'];
const SUPPORTED_PROTOCOLS = new Set(['2025-03-26', '2025-06-18', '2025-11-25']);
const STATUSES: McpCompileStatus[] = ['Success', 'NoChanges', 'Failure', 'NotEnabled',
    'NotAvailable', 'CompileStillActive', 'InProgress', 'Cancelled', 'NotStarted'];
function record(value: unknown): value is JsonObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
export function validateMcpEndpoint(value: unknown): string {
    if (typeof value !== 'string' || !value.trim())
        throw new UnrealMcpError(t("Unreal MCP URL 为空。"));
    let url: URL;
    try {
        url = new URL(value);
    }
    catch {
        throw new UnrealMcpError(t("Unreal MCP URL 无效。"));
    }
    // 仅连接用户明确配置的地址；不跟随重定向，不扫描或修改 UE 监听设置。
    try {
        normalizeMcpHost(url.hostname);
        normalizeMcpPort(url.port || (url.protocol === 'https:' ? 443 : 80));
        normalizeMcpPath(url.pathname);
    }
    catch {
        throw new UnrealMcpError(tr("MCP IP、端口或路径无效。", "The MCP IP address, port, or path is invalid."));
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
        url.search || url.hash || !url.pathname || url.pathname === '/') {
        throw new UnrealMcpError(t("MCP 地址需为 HTTP(S) IP/端口/路径，且不能包含用户名、密码、查询或片段。"));
    }
    return url.toString();
}
function isWindowsPath(value: string): boolean { return /^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+)/.test(value); }
function absoluteEditorPath(value: unknown, label: string): string {
    if (typeof value !== 'string' || !value.trim() || /[\0\r\n]/.test(value))
        throw new UnrealMcpError(t("{0} 必须是有效的绝对路径。", label));
    if (isWindowsPath(value))
        return path.win32.normalize(value).replace(/[\\/]+$/, '').toLowerCase();
    if (path.posix.isAbsolute(value))
        return path.posix.normalize(value).replace(/\/+$/, '') || '/';
    throw new UnrealMcpError(t("{0} 必须是有效的绝对路径。", label));
}
/** 先核对 initialize 的实际项目文件及引擎；目录前缀相同不算同一项目。 */
export function verifyMcpIdentity(initializeResult: unknown, config: UnrealMcpConfig): EditorIdentity {
    const expectedProject = absoluteEditorPath(config.projectPath, t(".uproject 路径"));
    if (!expectedProject.endsWith('.uproject'))
        throw new UnrealMcpError(t("项目文件不是 .uproject。"));
    const expectedEngine = absoluteEditorPath(config.engineRoot, t("UE 引擎路径"));
    const metadata = record(initializeResult) && record(initializeResult._meta) ? initializeResult._meta[INSTANCE_KEY] : undefined;
    if (!record(metadata) || !record(initializeResult) || !record(initializeResult.serverInfo) ||
        initializeResult.serverInfo.name !== 'unreal-mcp') {
        throw new UnrealMcpError(t("该服务没有 Epic Unreal MCP 编辑器身份信息，无法核对当前项目。请改用 iXena 通讯插件，或更新/启用官方 Unreal MCP；不会尝试编译。"));
    }
    if (typeof metadata.processId !== 'number' || !Number.isSafeInteger(metadata.processId) || metadata.processId <= 0) {
        throw new UnrealMcpError(t("Unreal MCP 没有返回有效的编辑器进程 ID，未发送编译。"));
    }
    const project = absoluteEditorPath(metadata.projectFile, t("MCP 返回的 projectFile"));
    const engine = absoluteEditorPath(metadata.engineDirectory, t("MCP 返回的 engineDirectory"));
    if (project !== expectedProject)
        throw new UnrealMcpError(t("MCP 连接的是另一个项目：{0}。当前选择：{1}。未发送编译。", String(metadata.projectFile), config.projectPath));
    // FPaths::EngineDir() 含 Engine 子目录；部分版本返回 FPaths::RootDir()。
    const expectedEngineDir = isWindowsPath(expectedEngine) ? path.win32.join(expectedEngine, 'engine') : path.posix.join(expectedEngine, 'Engine');
    if (engine !== expectedEngine && engine !== expectedEngineDir) {
        throw new UnrealMcpError(t("MCP 编辑器引擎目录与当前选择不一致：{0}。未发送编译。", String(metadata.engineDirectory)));
    }
    return { transport: 'mcp', url: validateMcpEndpoint(config.url), processId: metadata.processId,
        projectPath: config.projectPath, engineRoot: config.engineRoot,
        engineVersion: typeof metadata.engineVersion === 'string' ? metadata.engineVersion : '' };
}
/** UE 默认将 FString 包在 {result: ...} 内，MCP 又可能再包 structuredContent/content。 */
function unwrap(value: unknown, depth = 0): unknown {
    if (depth > 10)
        return value;
    if (typeof value === 'string') {
        try {
            return unwrap(JSON.parse(value), depth + 1);
        }
        catch {
            return value;
        }
    }
    if (!record(value))
        return value;
    if (value.structuredContent !== undefined)
        return unwrap(value.structuredContent, depth + 1);
    if (value.result !== undefined && !value.status && !value.tools && !value.toolsets)
        return unwrap(value.result, depth + 1);
    if (Array.isArray(value.content)) {
        const texts = value.content.filter((block): block is JsonObject => record(block) && block.type === 'text' && typeof block.text === 'string');
        if (texts.length === 1)
            return unwrap(texts[0].text, depth + 1);
        if (texts.length > 1)
            return texts.map(item => String(item.text)).join('\n');
    }
    return value;
}
function renderContent(value: unknown): string {
    const decoded = unwrap(value);
    if (typeof decoded === 'string')
        return decoded;
    if (record(decoded) && typeof decoded.output === 'string')
        return decoded.output;
    try {
        return JSON.stringify(decoded, null, 2) ?? '';
    }
    catch {
        return '';
    }
}
function nestedToolError(value: unknown, depth = 0): boolean {
    if (depth > 10 || !record(value))
        return false;
    if (value.isError === true)
        return true;
    for (const next of [value.structuredContent, value.result]) {
        if (nestedToolError(next, depth + 1))
            return true;
    }
    if (Array.isArray(value.content)) {
        for (const item of value.content) {
            if (record(item) && item.type === 'text' && typeof item.text === 'string') {
                try {
                    if (nestedToolError(JSON.parse(item.text), depth + 1))
                        return true;
                }
                catch { /* 普通编译日志。 */ }
            }
        }
    }
    return false;
}
/** 只采信返回结构或第一行的显式状态；日志中出现 Success 不能证明编译成功。 */
export function parseCompileToolResponse(value: unknown): McpCompileResult {
    const decoded = unwrap(value);
    const rawOutput = renderContent(value);
    let candidate: unknown;
    if (record(decoded))
        candidate = decoded.status ?? decoded.compileResult ?? decoded.resultStatus;
    if (typeof candidate !== 'string') {
        const firstLine = rawOutput.trim().split(/\r?\n/, 1)[0] ?? '';
        const match = /^(?:(?:Live\s*Coding\s*)?(?:compile|compilation)?\s*(?:result|status)\s*[:=]\s*)?(?:ELiveCodingCompileResult::)?(Success|NoChanges|Failure|NotEnabled|NotAvailable|CompileStillActive|InProgress|Cancelled|NotStarted)\s*[.!]?\s*$/i.exec(firstLine);
        candidate = match?.[1];
    }
    let status = STATUSES.find(item => typeof candidate === 'string' && item.toLowerCase() === candidate.trim().toLowerCase()) ?? 'Unknown';
    const toolError = nestedToolError(value);
    if (toolError && (status === 'Success' || status === 'NoChanges'))
        status = 'Unknown';
    return { status, rawOutput, isError: toolError || !['Success', 'NoChanges'].includes(status) };
}
function schemaOf(tool: Tool): {
    properties: JsonObject;
    required: string[];
} {
    const schema = tool.inputSchema;
    if (schema.type !== 'object' || (schema.required !== undefined && !Array.isArray(schema.required))) {
        throw new UnrealMcpError(t("{0} 的参数架构不受支持，未发送编译。", tool.name));
    }
    if (['oneOf', 'anyOf', 'allOf', '$ref'].some(key => key in schema)) {
        throw new UnrealMcpError(t("{0} 使用当前客户端不支持的组合参数架构，未发送编译。", tool.name));
    }
    const required = (schema.required ?? []) as unknown[];
    if (required.some(key => typeof key !== 'string'))
        throw new UnrealMcpError(t("{0} 的必需参数架构无效。", tool.name));
    return { properties: record(schema.properties) ? schema.properties : {}, required: required as string[] };
}
function validateKnownArguments(tool: Tool, args: JsonObject): void {
    const { properties, required } = schemaOf(tool);
    for (const key of required)
        if (!(key in args))
            throw new UnrealMcpError(t("{0} 新增了未支持的必需参数 {1}，未发送编译。", tool.name, key));
    for (const [key, value] of Object.entries(args)) {
        const definition = properties[key];
        if (!record(definition))
            throw new UnrealMcpError(t("{0} 未声明 {1} 参数，未发送编译。", tool.name, key));
        const expected = Array.isArray(value) ? 'array' : typeof value === 'object' ? 'object' : typeof value;
        if (definition.type !== undefined && definition.type !== expected)
            throw new UnrealMcpError(t("{0}.{1} 的参数类型不兼容。", tool.name, key));
        if (Array.isArray(definition.enum) && !definition.enum.includes(value))
            throw new UnrealMcpError(t("{0}.{1} 不接受当前参数。", tool.name, key));
    }
}
function isTool(value: unknown): value is Tool {
    return record(value) && typeof value.name === 'string' && record(value.inputSchema);
}
/** 描述接口在不同 UE 版本有单数/复数名称；参数名与类型必须来自服务实际公布的 schema。 */
function describeArguments(tool: Tool, value: string): JsonObject {
    const { properties } = schemaOf(tool);
    const isToolDescription = tool.name === 'describe_tools';
    const candidates = isToolDescription ? ['tool_names', 'names', 'tools', 'tool_name', 'name'] :
        ['toolset_names', 'toolsets', 'names', 'toolset_name', 'name'];
    const present = candidates.filter(key => record(properties[key]) && ['string', 'array'].includes(String((properties[key] as JsonObject).type)));
    if (present.length !== 1)
        throw new UnrealMcpError(t("{0} 的名称参数无法可靠识别，请使用 iXena 通讯插件。", tool.name));
    const key = present[0];
    const args: JsonObject = { [key]: (properties[key] as JsonObject).type === 'array' ? [value] : value };
    if ('include_schemas' in properties)
        args.include_schemas = true;
    validateKnownArguments(tool, args);
    return args;
}
function toolsetNames(value: unknown): string[] {
    const decoded = unwrap(value);
    const serialized = typeof decoded === 'string' ? decoded : JSON.stringify(decoded);
    // Token boundaries prevent accidentally selecting MyLiveCodingToolset or unrelated plugins.
    const found = new Set<string>();
    for (const match of (serialized ?? '').matchAll(/(?<![\w.])(LiveCodingToolset(?:\.LiveCodingToolset)?)(?![\w.])/g))
        found.add(match[1]);
    return [...found];
}
function describedCompileTools(value: unknown, qualifiedName: string): Tool[] {
    const found: Tool[] = [];
    const visit = (node: unknown, depth = 0): void => {
        if (depth > 20)
            return;
        if (typeof node === 'string') {
            try {
                visit(JSON.parse(node), depth + 1);
            }
            catch { /* 仅解析结构化工具描述。 */ }
        }
        else if (Array.isArray(node))
            node.forEach(item => visit(item, depth + 1));
        else if (record(node)) {
            const name = node.name ?? node.tool_name;
            const schema = node.inputSchema ?? node.input_schema;
            if ((name === TOOL_NAME || name === qualifiedName) && record(schema))
                found.push({ name: String(name), inputSchema: schema });
            else
                for (const child of Object.values(node))
                    visit(child, depth + 1);
        }
    };
    visit(unwrap(value));
    return found;
}
/** 可注入 fetch 仅用于协议测试；实际使用 Node 内置 fetch，禁止任何重定向。 */
export class UnrealMcpClient {
    private nextId = 1;
    private sessionId: string | undefined;
    private protocolVersion = '2025-03-26';
    private identity: EditorIdentity | undefined;
    private compileTool: CompileTool | undefined;
    private unavailableReason: string | undefined;
    readonly url: string;
    private readonly compileTimeoutMs: number;
    constructor(private readonly config: UnrealMcpConfig, private readonly onProgress?: Progress, private readonly httpFetch: typeof fetch = fetch, private readonly quickTimeoutMs = 12000) {
        this.url = validateMcpEndpoint(config.url);
        absoluteEditorPath(config.projectPath, t(".uproject 路径"));
        absoluteEditorPath(config.engineRoot, t("UE 引擎路径"));
        const seconds = config.timeoutSeconds ?? 900;
        if (!Number.isFinite(seconds) || seconds < 30 || seconds > 3600)
            throw new UnrealMcpError(t("MCP 编译超时必须在 30～3600 秒之间。"));
        this.compileTimeoutMs = seconds * 1000;
    }
    private async post(method: string, params?: unknown, compile = false, notification = false): Promise<unknown> {
        const id = this.nextId++;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(new Error(t("MCP 请求超时"))), compile ? this.compileTimeoutMs : this.quickTimeoutMs);
        timer.unref();
        const headers: Record<string, string> = { 'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream', Origin: 'http://127.0.0.1', 'MCP-Protocol-Version': this.protocolVersion };
        if (this.sessionId)
            headers['Mcp-Session-Id'] = this.sessionId;
        try {
            const response = await this.httpFetch(this.url, { method: 'POST', headers, redirect: 'error', signal: controller.signal,
                body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id }), method, ...(params === undefined ? {} : { params }) }) });
            if (!response.ok)
                throw new UnrealMcpError(t("Unreal MCP 返回 HTTP {0}{1}。", response.status, response.status === 404 ? t("（服务未启动、URL 不正确或会话已失效）") : ''), compile);
            const newSession = response.headers.get('Mcp-Session-Id');
            if (newSession) {
                if (!/^[\x21-\x7e]{1,256}$/.test(newSession))
                    throw new UnrealMcpError(t("MCP 会话 ID 无效。"), compile);
                if (this.sessionId && this.sessionId !== newSession)
                    throw new UnrealMcpError(t("MCP 服务中途更换了会话，未自动重试。"), compile);
                this.sessionId = newSession;
            }
            if (notification) {
                await response.body?.cancel();
                return undefined;
            }
            if (!response.body)
                throw new UnrealMcpError(t("MCP 请求没有返回结果。"), compile);
            const type = response.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase();
            if (type !== 'application/json' && type !== 'text/event-stream')
                throw new UnrealMcpError(t("MCP 返回了不支持的内容类型：{0}。", type ?? t("空")), compile);
            const reader = response.body.getReader();
            const decoder = new TextDecoder('utf-8', { fatal: true });
            let total = 0;
            let buffer = '';
            // 编译返回后马上取消本次响应流；不等待持续 SSE 连接自行结束。
            const abortPromise = new Promise<never>((_resolve, reject) => {
                if (controller.signal.aborted)
                    reject(controller.signal.reason);
                else
                    controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
            });
            const parseMessage = (data: string): {
                matched: boolean;
                result?: unknown;
            } => {
                let message: unknown;
                try {
                    message = JSON.parse(data);
                }
                catch {
                    throw new UnrealMcpError(t("MCP 返回了无效的 JSON。"), compile);
                }
                const messages = Array.isArray(message) ? message : [message];
                for (const item of messages) {
                    if (!record(item) || item.jsonrpc !== '2.0')
                        throw new UnrealMcpError(t("MCP 返回了无效的 JSON-RPC 消息。"), compile);
                    if (item.method === 'notifications/progress' && record(item.params)) {
                        const progress = typeof item.params.message === 'string' ? item.params.message : t("UE 正在处理请求\u2026");
                        this.onProgress?.(progress.slice(0, 2000));
                    }
                    if (item.id !== id)
                        continue;
                    if (record(item.error))
                        throw new UnrealMcpError(`Unreal MCP：${String(item.error.message ?? t("JSON-RPC 错误")).slice(0, 2000)}`, compile);
                    if (!('result' in item))
                        throw new UnrealMcpError(t("MCP 响应缺少 result。"), compile);
                    return { matched: true, result: item.result };
                }
                return { matched: false };
            };
            try {
                while (true) {
                    const chunk = await Promise.race([reader.read(), abortPromise]);
                    if (chunk.done) {
                        buffer += decoder.decode();
                        if (type === 'application/json') {
                            const parsed = parseMessage(buffer);
                            if (parsed.matched)
                                return parsed.result;
                        }
                        throw new UnrealMcpError(t("MCP 连接结束，但没有收到对应请求的结果。"), compile);
                    }
                    total += chunk.value.byteLength;
                    if (total > MAX_RESPONSE_BYTES)
                        throw new UnrealMcpError(t("MCP 响应超过 16 MiB，已停止接收；请查看 UE 日志。"), compile);
                    buffer += decoder.decode(chunk.value, { stream: true });
                    if (type === 'text/event-stream') {
                        let boundary: RegExpExecArray | null;
                        while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
                            const event = buffer.slice(0, boundary.index);
                            buffer = buffer.slice(boundary.index + boundary[0].length);
                            const data = event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
                            if (data) {
                                const parsed = parseMessage(data);
                                if (parsed.matched)
                                    return parsed.result;
                            }
                        }
                    }
                }
            }
            finally {
                void reader.cancel().catch(() => { });
            }
        }
        catch (error) {
            if (error instanceof UnrealMcpError)
                throw error;
            const suffix = compile ? t(" 编译可能已经开始；请先在 UE 查看结果，不会自动重试或回退到 UBT。") : t(" 请检查 Unreal MCP 已启动及 URL 正确，或选择插件通讯。");
            throw new UnrealMcpError(t("Unreal MCP 通讯失败：{0}。{1}", errorText(error), suffix), compile);
        }
        finally {
            clearTimeout(timer);
        }
    }
    async probeIdentity(): Promise<Pick<McpConnectionInfo, 'processId' | 'projectPath' | 'engineRoot'>> {
        await this.initialize();
        if (!this.identity) throw new UnrealMcpError(t('MCP 未返回编辑器身份信息。'));
        return { processId: this.identity.processId, projectPath: this.identity.projectPath, engineRoot: this.identity.engineRoot };
    }
    async initialize(): Promise<void> {
        if (this.identity)
            return;
        const result = await this.post('initialize', { protocolVersion: this.protocolVersion, capabilities: {},
            clientInfo: { name: 'iXenaUnrealTools', version: '0.6.2' } });
        if (!record(result) || typeof result.protocolVersion !== 'string' || !SUPPORTED_PROTOCOLS.has(result.protocolVersion)) {
            throw new UnrealMcpError(t("MCP 服务协商了不支持的协议版本，请使用 iXena 通讯插件。"));
        }
        this.protocolVersion = result.protocolVersion;
        this.identity = verifyMcpIdentity(result, this.config);
        await this.post('notifications/initialized', undefined, false, true);
        this.onProgress?.(t("已连接 Unreal MCP：PID {0}，{1}", this.identity.processId, this.identity.projectPath));
    }
    private async listTools(): Promise<Tool[]> {
        const tools: Tool[] = [];
        let cursor: string | undefined;
        const seen = new Set<string>();
        for (let page = 0; page < MAX_TOOL_PAGES; page++) {
            const result = await this.post('tools/list', cursor ? { cursor } : {});
            if (!record(result) || !Array.isArray(result.tools) || !result.tools.every(isTool))
                throw new UnrealMcpError(t("Unreal MCP 工具列表格式无效。"));
            tools.push(...result.tools);
            if (tools.length > 10000)
                throw new UnrealMcpError(t("Unreal MCP 工具列表过大，未发送编译。"));
            if (!result.nextCursor)
                return tools;
            if (typeof result.nextCursor !== 'string' || seen.has(result.nextCursor))
                throw new UnrealMcpError(t("Unreal MCP 工具列表游标无效。"));
            cursor = result.nextCursor;
            seen.add(cursor);
        }
        throw new UnrealMcpError(t("Unreal MCP 工具列表分页过多。"));
    }
    private async readTool(tool: Tool, args: JsonObject): Promise<unknown> {
        validateKnownArguments(tool, args);
        const result = await this.post('tools/call', { name: tool.name, arguments: args });
        if (nestedToolError(result))
            throw new UnrealMcpError(t("MCP 工具发现失败：{0}", renderContent(result).slice(0, 2000)));
        return result;
    }
    async discoverLiveCoding(): Promise<McpConnectionInfo> {
        await this.initialize();
        if (this.compileTool)
            return { ...this.identity!, toolName: this.compileTool.displayName, liveCodingAvailable: true };
        if (this.unavailableReason)
            return { ...this.identity!, toolName: '', liveCodingAvailable: false, message: this.unavailableReason };
        const tools = await this.listTools();
        const direct = tools.filter(tool => TOOLSETS.some(toolset => tool.name === `${toolset}.${TOOL_NAME}`));
        if (direct.length > 1)
            throw new UnrealMcpError(t("MCP 同时公布多个 Live Coding 工具，无法安全选择。"));
        if (direct.length === 1) {
            validateKnownArguments(direct[0], {});
            this.compileTool = { name: direct[0].name, arguments: {}, displayName: direct[0].name };
        }
        else {
            const dispatcher = tools.find(tool => tool.name === 'call_tool');
            const lister = tools.find(tool => tool.name === 'list_toolsets');
            const describer = tools.find(tool => tool.name === 'describe_tools') ??
                tools.find(tool => tool.name === 'describe_toolsets') ?? tools.find(tool => tool.name === 'describe_toolset');
            if (!dispatcher || !lister || !describer)
                return this.unavailable(t("MCP 已连接，但该编辑器没有公布 Live Coding 工具或受支持的工具发现接口。Windows 请启用 Live Coding Toolset / All Toolsets；macOS/Linux 的通讯不代表支持 Live Coding。"));
            const candidates = toolsetNames(await this.readTool(lister, {}));
            const toolset = candidates.includes(TOOLSETS[0]) ? TOOLSETS[0] : candidates.includes(TOOLSETS[1]) ? TOOLSETS[1] : undefined;
            if (!toolset)
                return this.unavailable(t("MCP 已连接，但没有注册 LiveCodingToolset。Windows 请启用 Live Coding Toolset / All Toolsets 后重启 UE；macOS/Linux 不提供此 Live Coding 工具。"));
            const qualifiedName = `${toolset}.${TOOL_NAME}`;
            const description = await this.readTool(describer, describeArguments(describer, describer.name === 'describe_tools' ? qualifiedName : toolset));
            const matches = describedCompileTools(description, qualifiedName);
            if (matches.length !== 1)
                throw new UnrealMcpError(t("MCP 未返回唯一的 CompileLiveCoding 参数架构，未发送编译。"));
            validateKnownArguments(matches[0], {});
            const args = { toolset_name: toolset, tool_name: TOOL_NAME, arguments: {} };
            validateKnownArguments(dispatcher, args);
            this.compileTool = { name: dispatcher.name, arguments: args, displayName: qualifiedName };
        }
        return { ...this.identity!, toolName: this.compileTool.displayName, liveCodingAvailable: true };
    }
    private unavailable(message: string): McpConnectionInfo {
        this.unavailableReason = message;
        return { ...this.identity!, toolName: '', liveCodingAvailable: false, message };
    }
    async compileLiveCoding(): Promise<McpCompileResult> {
        const connection = await this.discoverLiveCoding();
        if (!connection.liveCodingAvailable)
            return { status: 'NotAvailable', rawOutput: connection.message ?? t("Live Coding 不可用。"), isError: true };
        this.onProgress?.(t("调用 {0}，等待 UE 返回实际编译结果\u2026", this.compileTool!.displayName));
        const result = await this.post('tools/call', { name: this.compileTool!.name, arguments: this.compileTool!.arguments,
            _meta: { progressToken: `ixena-live-coding-${this.nextId}` } }, true);
        return parseCompileToolResponse(result);
    }
    /** 仅释放本客户端的 MCP 会话；没有 session ID 的服务器不发送 DELETE。 */
    async close(): Promise<void> {
        if (!this.sessionId)
            return;
        const headers = { 'Mcp-Session-Id': this.sessionId, 'MCP-Protocol-Version': this.protocolVersion,
            Origin: 'http://127.0.0.1' };
        this.sessionId = undefined;
        try {
            const response = await this.httpFetch(this.url, { method: 'DELETE', headers, redirect: 'error', signal: AbortSignal.timeout(2000) });
            await response.body?.cancel();
        }
        catch { /* 服务可能不支持结束会话；不覆盖实际编译结果。 */ }
    }
}
/** Auto reconnect uses a lightweight, read-only handshake. It does not enumerate tools,
 * trigger compilation or assume Live Coding is available. */
export async function probeUnrealMcpIdentity(config: UnrealMcpConfig): Promise<Pick<McpConnectionInfo, 'processId' | 'projectPath' | 'engineRoot'>> {
    const client = new UnrealMcpClient(config, undefined, fetch, 1500);
    try { return await client.probeIdentity(); }
    finally { await client.close(); }
}
/** 只做握手、身份验证和工具描述，绝不会调用 CompileLiveCoding。 */
export async function checkUnrealMcp(config: UnrealMcpConfig, onProgress?: Progress): Promise<McpConnectionInfo> {
    const client = new UnrealMcpClient(config, onProgress);
    try {
        return await client.discoverLiveCoding();
    }
    finally {
        await client.close();
    }
}
export async function compileViaUnrealMcp(config: UnrealMcpConfig, onProgress?: Progress): Promise<McpCompileResult> {
    const client = new UnrealMcpClient(config, onProgress);
    try {
        return await client.compileLiveCoding();
    }
    finally {
        await client.close();
    }
}
