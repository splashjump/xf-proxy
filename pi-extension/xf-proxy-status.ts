/**
 * xf-proxy-status — 讯飞本地代理的实时状态（pi footer，加法方式）
 *
 * 读 proxy-events.jsonl（增量跟随），把**单次请求的失败进度**堆成 ✗ 串：
 *   - 重试中：每失败一次堆一个 ✗（warning 色），冷却处插一个不起眼的 `'`（dim）
 *   - 成功：左边塞 `✅ N× 耗时`，右边保留 ✗ 串（dim）作为战绩，直到下次请求清空
 *   - 失败：左边 `⛔ 原因 N× 耗时` 整行红 + ✗ 串
 *   - 取消：✗ 串不动、转 dim
 *   - 首试未败 / 无历史：`—`（dim）
 *   - 代理停止：`⚠ 代理已停止`（红）
 *
 * 用 ctx.ui.setStatus() 追加到 pi 原始 footer（不替换 model/tokens/context）。
 * setStatus 会自动 requestRender；idle 时状态文本完全稳定，不触发重绘，不抢输入。
 *
 * 配置（环境变量，均可选）：
 *   XF_PROXY_LOG   结构化事件日志路径（默认 T:\xf-proxy\logs\proxy-events.jsonl）
 *   XF_PROXY_PORT  代理健康检查端口（默认 3000，每 10s 探活一次 /health）
 *
 * 命令：
 *   /xfproxy [off|N]  在编辑器下方贴一个"最近 N 行日志"的 widget（默认 8 行）
 */

import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionUIContext,
	Theme,
	ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { closeSync, openSync, readSync, statSync } from "node:fs";

const WIDGET_KEY = "xf-proxy-status";
const STATUS_KEY = "xf-proxy";
const POLL_MS = 500;
const HEALTH_INTERVAL_MS = 10_000;
const HEALTH_TIMEOUT_MS = 2000;
const STALE_ACTIVE_MS = 90_000;
const DEFAULT_WIDGET_LINES = 8;
const WIDGET_LINE_CAP = 60;
const KEEP_RAW_LINES = 500;

// ── 数据结构 ────────────────────────────────────────────

interface StackItem {
	type: "fail" | "cooldown";
}

interface Terminal {
	kind: "success" | "failed" | "cancelled";
	retries: number;
	durationMs: number;
	reason?: string;
}

interface ActiveReq {
	id: string;
	sinceTs: number;
	phase: "processing" | "retrying" | "cooldown";
}

interface Runtime {
	sid: string; // 本 pi 会话标识，用于按终端过滤事件
	proxyAlive: boolean;
	active?: ActiveReq;
	stack: StackItem[]; // 当前/上次请求的失败进度
	terminal?: Terminal; // 上次请求的终态
	lastActivityTs?: number;
	rawLines: string[]; // JSONL 原文，供 widget
	statusText: string; // 去重：仅在变化时 setStatus
	widgetOn: boolean;
	widgetLines: number;
}

function freshRuntime(): Runtime {
	return {
		sid: "",
		proxyAlive: true,
		stack: [],
		rawLines: [],
		statusText: "",
		widgetOn: false,
		widgetLines: DEFAULT_WIDGET_LINES,
	};
}

// ── 日志增量跟随 ──────────────────────────────────────────
class LogTailer {
	private pos = 0;
	private leftover = "";
	private exists = false;
	constructor(private readonly file: string) {}

	readNew(): string[] {
		let st;
		try {
			st = statSync(this.file);
		} catch {
			if (this.exists) {
				this.pos = 0;
				this.leftover = "";
			}
			this.exists = false;
			return [];
		}
		this.exists = true;
		if (st.size < this.pos) {
			this.pos = 0;
			this.leftover = "";
		}
		if (st.size === this.pos) return [];

		const want = st.size - this.pos;
		const buf = Buffer.allocUnsafe(want);
		let fd: number | undefined;
		let total = 0;
		try {
			fd = openSync(this.file, "r");
			while (total < want) {
				const r = readSync(fd, buf, total, want - total, this.pos + total);
				if (r <= 0) break;
				total += r;
			}
		} catch {
			return [];
		} finally {
			if (fd !== undefined) {
				try {
					closeSync(fd);
				} catch {}
			}
		}
		this.pos += total;
		this.leftover += buf.subarray(0, total).toString("utf8");
		const parts = this.leftover.split("\n");
		this.leftover = parts.pop() ?? "";
		return parts.filter((l) => l.length > 0);
	}
}

// ── 事件解析 ──────────────────────────────────────────────

function parseEvent(raw: string): Record<string, unknown> | null {
	if (!raw.trim()) return null;
	try {
		const obj = JSON.parse(raw);
		if (obj && typeof obj === "object" && !Array.isArray(obj) && obj.t) return obj;
	} catch {}
	return null;
}

function applyEvent(ev: Record<string, unknown>, rt: Runtime): boolean {
	const type = ev.t as string;

	// 终端隔离：全局事件（start/fatal）所有终端共享；其余只处理本会话的事件
	if (type !== "start" && type !== "fatal" && ev.sid !== rt.sid) {
		return false;
	}

	rt.lastActivityTs = (ev.ts as number) ?? Date.now();

	// 存原始 JSONL 供 widget（已按 sid 过滤）
	if (rt.rawLines.length >= KEEP_RAW_LINES) rt.rawLines.shift();
	rt.rawLines.push(JSON.stringify(ev));

	switch (type) {
		case "start":
			rt.proxyAlive = true;
			rt.active = undefined;
			rt.stack = [];
			rt.terminal = undefined;
			return true;

		case "fatal":
			rt.proxyAlive = false;
			return true;

		case "req_start":
			rt.active = {
				id: (ev.id as string) ?? "?",
				sinceTs: (ev.ts as number) ?? Date.now(),
				phase: "processing",
			};
			rt.stack = [];
			rt.terminal = undefined;
			return true;

		case "think_inject":
			// 仍在 processing，无副作用（req_start 已初始化）
			return true;

		case "retry":
			rt.stack.push({ type: "fail" });
			if (rt.active) rt.active.phase = "retrying";
			return true;

		case "cooldown":
			rt.stack.push({ type: "cooldown" });
			if (rt.active) rt.active.phase = "cooldown";
			return true;

		case "success":
			rt.terminal = {
				kind: "success",
				retries: (ev.retries as number) ?? 0,
				durationMs: (ev.durationMs as number) ?? 0,
			};
			rt.active = undefined;
			return true; // stack 保留（成功战绩）

		case "failed":
			rt.terminal = {
				kind: "failed",
				retries: (ev.retries as number) ?? 0,
				durationMs: (ev.durationMs as number) ?? 0,
				reason: (ev.reason as string) ?? "failed",
			};
			rt.active = undefined;
			return true; // stack 保留

		case "cancelled":
			rt.terminal = {
				kind: "cancelled",
				retries: (ev.retries as number) ?? 0,
				durationMs: (ev.durationMs as number) ?? 0,
			};
			rt.active = undefined;
			return true; // stack 不动，仅转 dim（由渲染决定）

		case "stream_interrupt":
			return true;

		default:
			return true;
	}
}

// ── 渲染 ──────────────────────────────────────────────────

function fmtDur(ms: number): string {
	if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
	return `${(ms / 60000).toFixed(1)}m`;
}

/** 渲染 ✗ 串，冷却处插 `'`。failColor=✗ 的颜色；`'` 恒为 dim（不起眼）。 */
function renderStack(theme: Theme, stack: StackItem[], failColor: ThemeColor): string {
	let s = "";
	for (const item of stack) {
		if (item.type === "fail") s += theme.fg(failColor, "✗");
		else s += theme.fg("dim", "'");
	}
	return s;
}

function buildStatusText(theme: Theme, rt: Runtime, now: number): string {
	// 代理停止：最高优先级
	if (!rt.proxyAlive) {
		return theme.fg("error", "⚠ 代理已停止");
	}

	// 活跃态超时回退（防卡死）
	let active = rt.active;
	if (active && rt.lastActivityTs && now - rt.lastActivityTs > STALE_ACTIVE_MS) {
		active = undefined;
	}

	// 请求进行中
	if (active) {
		if (rt.stack.length === 0) {
			// 首试未败：继承无历史的 —
			return theme.fg("dim", "—");
		}
		// 实时堆 ✗（warning）
		return renderStack(theme, rt.stack, "warning");
	}

	// idle
	if (!rt.terminal) {
		// 有遗留 stack（异常：活跃态超时但 stack 非空）→ dim
		if (rt.stack.length > 0) return renderStack(theme, rt.stack, "dim");
		return theme.fg("dim", "—");
	}

	switch (rt.terminal.kind) {
		case "success": {
			const t = rt.terminal;
			if (t.retries === 0) {
				// 无重试：✅ 1.1s（无 ✗ 串）
				return theme.fg("success", "✅") + theme.fg("dim", ` ${fmtDur(t.durationMs)}`);
			}
			const left = theme.fg("success", "✅") + theme.fg("dim", ` ${t.retries}× ${fmtDur(t.durationMs)} `);
			return left + renderStack(theme, rt.stack, "dim") + theme.fg("success", "✓");
		}
		case "failed": {
			const t = rt.terminal;
			const left = theme.fg("error", `⛔ ${t.reason ?? "failed"} ${t.retries}× ${fmtDur(t.durationMs)} `);
			return left + renderStack(theme, rt.stack, "error");
		}
		case "cancelled":
			// ✗ 串不动，转 dim
			return renderStack(theme, rt.stack, "dim");
	}
}

// ── Widget（最近日志行）──────────────────────────────────

function formatEventReadable(theme: Theme, ev: Record<string, unknown>): string {
	const ts = ev.ts ? new Date(ev.ts as number).toISOString().slice(11, 19) : "--:--:--";
	const t = ev.t as string;
	const id = ev.id ? `[${String(ev.id).slice(-6)}]` : "";
	const prefix = theme.fg("dim", ts);
	let msg = "";
	let color: ThemeColor | undefined;
	switch (t) {
		case "start":
			msg = `🏁 启动 端口=${ev.port}`;
			color = "accent";
			break;
		case "fatal":
			msg = `💀 致命: ${ev.reason}`;
			color = "error";
			break;
		case "req_start":
			msg = `${id} → ${ev.method ?? "?"} ${ev.path ?? "?"}`;
			color = "accent";
			break;
		case "think_inject":
			msg = `${id} 🧠 think`;
			break;
		case "retry":
			msg = `${id} 🔄 ${ev.reason === "http" ? `HTTP ${ev.status}` : ev.reason} ${ev.attempt}/${ev.max} fails${ev.fails}`;
			color = "warning";
			break;
		case "cooldown":
			msg = `${id} ⏸ 冷却 ${ev.cooldownMs}ms fails${ev.fails}`;
			color = "warning";
			break;
		case "success":
			msg = `${id} ✅ r${ev.retries} ${(ev.durationMs as number | undefined) ?? 0}ms`;
			color = "success";
			break;
		case "failed":
			msg = `${id} ✗ ${ev.reason} r${ev.retries}`;
			color = "error";
			break;
		case "cancelled":
			msg = `${id} – 取消 r${ev.retries}`;
			color = "dim";
			break;
		case "stream_interrupt":
			msg = `${id} ⚠ 流中断`;
			color = "warning";
			break;
		default:
			msg = JSON.stringify(ev).slice(0, 80);
	}
	if (color) msg = theme.fg(color, msg);
	return `${prefix} ${msg}`;
}

function renderWidget(theme: Theme, rt: Runtime): string[] {
	const n = Math.max(1, rt.widgetLines);
	const raw = rt.rawLines.slice(-n);
	const lines: string[] = [];
	for (const l of raw) {
		const ev = parseEvent(l);
		if (!ev) {
			lines.push(l.slice(0, 120));
			continue;
		}
		lines.push(formatEventReadable(theme, ev));
	}
	lines.unshift(theme.fg("accent", theme.bold(`xf-proxy 最近 ${raw.length} 行（/xfproxy off 关闭）`)));
	return lines;
}

// ── 扩展入口 ──────────────────────────────────────────────
export default function (pi: ExtensionAPI) {
	let rt: Runtime = freshRuntime();
	let tailer: LogTailer | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let ui: ExtensionUIContext | undefined;
	let logPath = "";
	let healthPort = 3000;
	let lastHealthCheck = 0;

	const checkHealth = async () => {
		const ctrl = new AbortController();
		const t = setTimeout(() => ctrl.abort(), HEALTH_TIMEOUT_MS);
		try {
			const resp = await fetch(`http://127.0.0.1:${healthPort}/health`, { signal: ctrl.signal });
			const alive = resp.ok;
			if (alive !== rt.proxyAlive) rt.proxyAlive = alive;
		} catch {
			if (rt.proxyAlive) rt.proxyAlive = false;
		} finally {
			clearTimeout(t);
		}
	};

	const poll = () => {
		if (!tailer || !ui) return;
		const now = Date.now();
		let changed = false;
		const lines = tailer.readNew();
		for (const l of lines) {
			const ev = parseEvent(l);
			if (ev) {
				if (!applyEvent(ev, rt)) continue; // 非本会话事件：不影响状态，不刷 widget
			} else {
				if (rt.rawLines.length >= KEEP_RAW_LINES) rt.rawLines.shift();
				rt.rawLines.push(l);
			}
			changed = true;
		}

		if (rt.widgetOn && ui && changed) {
			ui.setWidget(WIDGET_KEY, renderWidget(ui.theme, rt), { placement: "belowEditor" });
		}

		if (now - lastHealthCheck > HEALTH_INTERVAL_MS) {
			lastHealthCheck = now;
			void checkHealth();
		}

		// 仅在状态文本变化时 setStatus（自动 requestRender）。
		// idle 时文本完全稳定（无相对时间），不会触发重绘，不干扰输入。
		const text = buildStatusText(ui.theme, rt, now);
		if (changed || text !== rt.statusText) {
			rt.statusText = text;
			ui.setStatus(STATUS_KEY, text);
		}
	};

	function startup(ctx: ExtensionContext) {
		const portFromEnv = parseInt(process.env.XF_PROXY_PORT || "3000", 10);
		healthPort = Number.isNaN(portFromEnv) ? 3000 : portFromEnv;
		logPath = process.env.XF_PROXY_LOG || "T:/xf-proxy/logs/proxy-events.jsonl";

		rt = freshRuntime();
		rt.sid = ctx.sessionManager.getSessionId();
		tailer = new LogTailer(logPath);
		// 回放现有文件
		const lines = tailer.readNew();
		for (const l of lines) {
			const ev = parseEvent(l);
			if (ev) applyEvent(ev, rt);
		}

		ui = ctx.ui;
		const text = buildStatusText(ui.theme, rt, Date.now());
		rt.statusText = text;
		ui.setStatus(STATUS_KEY, text);

		if (timer) clearInterval(timer);
		timer = setInterval(poll, POLL_MS);
		lastHealthCheck = 0;
	}

	function shutdown(ctx: ExtensionContext) {
		if (timer) {
			clearInterval(timer);
			timer = undefined;
		}
		ctx.ui.setStatus(STATUS_KEY, undefined);
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		tailer = undefined;
		rt = freshRuntime();
	}

	pi.on("before_provider_headers", (event, ctx) => {
		if (ctx.mode !== "tui") return;
		// 给出站请求注入本会话标识，代理据此把事件标注为 src="pi" + sid
		event.headers["x-pi-session"] = ctx.sessionManager.getSessionId();
	});

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		startup(ctx);
	});

	pi.on("session_tree", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		shutdown(ctx);
		startup(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		shutdown(ctx);
	});

	pi.registerCommand("xfproxy", {
		description: "切换 xf-proxy 最近日志 widget（/xfproxy [off|N]）",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("xfproxy 仅在 TUI 模式可用", "warning");
				return;
			}
			const a = (args ?? "").trim().toLowerCase();
			if (a === "off" || a === "stop" || a === "close") {
				rt.widgetOn = false;
				ctx.ui.setWidget(WIDGET_KEY, undefined);
				ctx.ui.notify("xf-proxy 日志 widget 已关闭", "info");
				return;
			}
			if (/^\d+$/.test(a)) {
				rt.widgetLines = Math.min(WIDGET_LINE_CAP, Math.max(1, parseInt(a, 10)));
			}
			rt.widgetOn = true;
			ctx.ui.setWidget(WIDGET_KEY, renderWidget(ctx.ui.theme, rt), { placement: "belowEditor" });
			ctx.ui.notify(`xf-proxy 日志 widget 已开启（最近 ${rt.widgetLines} 行）`, "info");
		},
	});
}
