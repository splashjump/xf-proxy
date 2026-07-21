#!/usr/bin/env node
/**
 * xunfei-proxy — 讯飞星辰 API 本地代理（自定义重试策略）
 *
 * 策略：固定 0.5s + 抖动，每 10 次连续失败冷却 10s，上限 50 次，成功刷新计数
 *
 * 用法:
 *   XFYUN_API_KEY="your-key" node xunfei-proxy.js
 *   或
 *   XFYUN_API_KEY="your-key" ./xunfei-proxy.js   (chmod +x)
 *
 * 环境变量:
 *   XFYUN_API_KEY        讯飞 API Key（必填）
 *   XFYUN_BASE_URL       上游地址（默认 https://maas-coding-api.cn-huabei-1.xf-yun.com/v2）
 *   PROXY_PORT           监听端口（默认 3000）
 *   RETRY_DELAY_MS       固定重试间隔 ms（默认 500）
 *   MAX_RETRIES          最大重试次数（默认 50）
 *   COOLDOWN_AFTER       连续失败多少次触发冷却（默认 10）
 *   COOLDOWN_MS          冷却时长 ms（默认 10000）
 *   LOG_LEVEL            可读 stderr 级别: none / simple / full（默认 simple）
 *   LOG_DIR              日志输出目录（默认 <脚本目录>/logs）
 *   EVENT_LOG_MAX_LINES 结构化事件日志滚动行数（默认 1000）
 *
 * 日志产物：
 *   logs/proxy-events.jsonl  结构化事件（始终写，滚动；供 pi 扩展读取）
 *   logs/proxy-stderr.log   可读 stderr（nssm 重定向；simple/full 级）
 *   logs/proxy.log          full 级完整请求/响应明文
 */

"use strict";

const path = require("path");
const fs = require("fs");

// ── 配置 ──────────────────────────────────────────────
const PORT = parseInt(process.env.PROXY_PORT || "3000", 10);
const XFYUN_BASE = (process.env.XFYUN_BASE_URL ||
  "https://maas-coding-api.cn-huabei-1.xf-yun.com/v2").replace(/\/$/, "");
const API_KEY = process.env.XFYUN_API_KEY || "";
const RETRY_DELAY = parseInt(process.env.RETRY_DELAY_MS || "500", 10);
const MAX_RETRIES = parseInt(process.env.MAX_RETRIES || "50", 10);
const COOLDOWN_AFTER = parseInt(process.env.COOLDOWN_AFTER || "10", 10);
const COOLDOWN_MS = parseInt(process.env.COOLDOWN_MS || "5000", 10);
const JITTER_RATIO = 0.15;

// 进程标识 + 请求自增序号，用于结构化日志里的请求 ID（跨重启唯一）
const procTag = Date.now().toString(36);
let reqSeq = 0;

// ── 日志配置 ──────────────────────────────────────────
//   none   — 不输出任何日志
//   simple — stderr 输出重试/错误信息（默认）
//   full   — 在 simple 基础上，将完整请求/响应内容写入日志文件
const LOG_LEVELS = { none: 0, simple: 1, full: 2 };
const LOG_LEVEL = LOG_LEVELS[String(process.env.LOG_LEVEL || "simple").toLowerCase()] ?? 1;
const LOG_DIR = process.env.LOG_DIR || path.join(__dirname, "logs");
const LOG_FILE = path.join(LOG_DIR, "proxy.log");              // full 模式日志（完整请求/响应）
const LOG_EVENTS_FILE = path.join(LOG_DIR, "proxy-events.jsonl"); // 结构化事件日志（供 pi 扩展读取，滚动）
const EVENT_LOG_MAX_LINES = parseInt(process.env.EVENT_LOG_MAX_LINES || "1000", 10) || 1000;

// ── 日志工具 ──────────────────────────────────────────
function _ts() {
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  // 固定东八区显示，不依赖运行机器的本地时区
  const t = new Date(Date.now() + 8 * 3600 * 1000);
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}T` +
    `${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:${pad(t.getUTCSeconds())}.` +
    `${pad(t.getUTCMilliseconds(), 3)}+08:00`;
}

// ── 结构化事件日志（滚动，供 pi 扩展读取）──────────────────
// 每个事件一行 JSON：{"t":"<type>","ts":<ms>, ...fields}
// 文件超过上限 1.2× 时裁剪到上限，保持滚动窗口。
let _eventLineCount = -1;
function _appendEventLine(line) {
  try {
    fs.appendFileSync(LOG_EVENTS_FILE, line + "\n");
    if (_eventLineCount < 0) {
      try { _eventLineCount = fs.readFileSync(LOG_EVENTS_FILE, "utf8").split("\n").filter((l) => l.trim()).length; }
      catch { _eventLineCount = 0; }
    } else {
      _eventLineCount++;
    }
    if (_eventLineCount > Math.ceil(EVENT_LOG_MAX_LINES * 1.2)) {
      const lines = fs.readFileSync(LOG_EVENTS_FILE, "utf8").split("\n").filter((l) => l.trim());
      const kept = lines.slice(-EVENT_LOG_MAX_LINES);
      fs.writeFileSync(LOG_EVENTS_FILE, kept.join("\n") + "\n");
      _eventLineCount = kept.length;
    }
  } catch (e) {
    // 日志写入失败不阻塞主流程
  }
}

/** 发出一个结构化事件：写 JSONL（始终）+ 可读 stderr 行（simple/full 级）。 readable 留空则只写结构化日志。 */
function emit(type, fields = {}, readable) {
  const obj = { t: type, ts: Date.now(), ...fields };
  _appendEventLine(JSON.stringify(obj));
  if (readable && LOG_LEVEL >= 1) {
    console.error(`[${_ts()}] ${readable}`);
  }
}

/** 全量日志 — 追加写入文件（仅 full 级） */
function logDetail(text) {
  if (LOG_LEVEL < 2) return;
  try {
    fs.appendFileSync(LOG_FILE, text);
  } catch (e) {
    console.error(`[${_ts()}] ⚠ 日志写入失败: ${e.message}`);
  }
}

/** 脱敏请求头（隐藏 API Key） */
function redactHeaders(headers) {
  const out = { ...headers };
  if (out.authorization) out.authorization = "Bearer ***REDACTED***";
  return out;
}

// 可重试的 HTTP 状态码
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);
// 需要响应体包含讯飞业务码才重试的状态码（502/504 是网关层错误，直接重试）
const STATUSES_NEEDING_BODY_CHECK = new Set([429, 503]);

// 讯飞业务错误码（在响应 body 中检查）
const RETRYABLE_XFYUN_CODES = new Set(["10012", "10010", "11210", "10310"]);

// ── 工具函数 ──────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function calcDelay() {
  const jitter = (Math.random() * 2 - 1) * RETRY_DELAY * JITTER_RATIO;
  return Math.max(50, RETRY_DELAY + jitter);
}

async function maybeCooldown(failCount, reqId) {
  if (failCount > 0 && failCount % COOLDOWN_AFTER === 0) {
    emit("cooldown", { id: reqId, fails: failCount, cooldownMs: COOLDOWN_MS },
      `⚠ 连续失败 ${failCount} 次，冷却 ${COOLDOWN_MS / 1000}s ...`);
    await sleep(COOLDOWN_MS);
  }
}

function isRetryableXfyunBody(body) {
  try {
    const obj = JSON.parse(body);
    const code = obj?.error?.code || obj?.code;
    return code != null && RETRYABLE_XFYUN_CODES.has(String(code));
  } catch {
    return false;
  }
}

// ── 核心：带重试的 fetch ──────────────────────────────
// clientSignal：客户端断开时传入，用于中止上游请求并停止重试
// 终态事件（success / failed / cancelled）由本函数发出；抛出的 Error 带 __xfEmitted 标记，
// 调用方据此跳过重复记录。
async function fetchWithRetry(url, init, isStream, reqId, clientSignal) {
  const startTime = Date.now();
  let failCount = 0;
  const dur = () => Date.now() - startTime;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    // 客户端已断开 → 停止重试
    if (clientSignal?.aborted) {
      emit("cancelled", { id: reqId, reason: "client_disconnected", retries: attempt, durationMs: dur() },
        "✗ 客户端断开连接");
      const e = new Error("client disconnected");
      e.__xfEmitted = true;
      throw e;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 300_000); // 5 min
    // 客户端断开时同步中断当前 fetch
    const onClientAbort = () => controller.abort();
    if (clientSignal) {
      if (clientSignal.aborted) controller.abort();
      else clientSignal.addEventListener("abort", onClientAbort, { once: true });
    }

    try {
      const resp = await fetch(url, { ...init, signal: controller.signal, redirect: "follow" });
      clearTimeout(timeout);

      // 成功
      if (resp.ok) {
        emit("success", { id: reqId, retries: attempt, durationMs: dur() },
          attempt > 0 ? `✅️ 请求成功 (重试 ${attempt} 次, 总耗时 ${dur()}ms)` : `✅️ 请求成功 (总耗时 ${dur()}ms)`);
        return resp;
      }

      // 检查 HTTP 状态码是否可重试
      if (!RETRYABLE_STATUSES.has(resp.status)) {
        // 非可重试状态码 — 不计数，直接返回
        return resp;
      }

      // 429/503（非流式）需响应体包含讯飞业务码才重试；502/504 直接重试
      if (!isStream && STATUSES_NEEDING_BODY_CHECK.has(resp.status)) {
        const bodyText = await resp.clone().text();
        const isRetryableXF = isRetryableXfyunBody(bodyText);
        if (!isRetryableXF) {
          // HTTP 可重试但响应体不包含可重试业务码 — 返回原响应
          return resp;
        }
      }

      // ── 需要重试 ──
      failCount++;

      if (attempt >= MAX_RETRIES) {
        // HTTP 重试耗尽：返回最后一个错误响应给客户端
        emit("failed", { id: reqId, reason: "http_exhausted", status: resp.status, retries: attempt, durationMs: dur() },
          `✗ 重试耗尽 HTTP ${resp.status} (重试 ${attempt} 次, 总耗时 ${dur()}ms)`);
        return resp;
      }

      // 释放上游响应体（clone 已读取校验信息，原 body 不再需要），避免连接池泄漏
      await resp.body?.cancel();

      await maybeCooldown(failCount, reqId);

      const delay = calcDelay();
      emit("retry", { id: reqId, reason: "http", status: resp.status, attempt: attempt + 1, max: MAX_RETRIES, fails: failCount, delayMs: Math.round(delay) },
        `🔄 HTTP ${resp.status} — 第 ${attempt + 1}/${MAX_RETRIES} 次重试，等待 ${Math.round(delay)}ms (连续失败: ${failCount})`);
      await sleep(delay);

    } catch (err) {
      clearTimeout(timeout);
      // 客户端断开 — 不再重试
      if (clientSignal?.aborted) {
        emit("cancelled", { id: reqId, reason: "client_disconnected", retries: attempt, durationMs: dur() },
          "✗ 客户端断开连接");
        err.__xfEmitted = true;
        throw err;
      }

      failCount++;

      if (attempt >= MAX_RETRIES) {
        // 网络错误重试耗尽
        emit("failed", { id: reqId, reason: "network_exhausted", msg: err.message, retries: attempt, durationMs: dur() },
          `✗ 网络重试耗尽: ${err.message} (重试 ${attempt} 次, 总耗时 ${dur()}ms)`);
        err.__xfEmitted = true;
        throw err;
      }

      await maybeCooldown(failCount, reqId);

      const delay = calcDelay();
      const cause = err.cause ? ` (cause: ${err.cause.code || err.cause.message})` : "";
      emit("retry", { id: reqId, reason: "network", msg: err.message, attempt: attempt + 1, max: MAX_RETRIES, fails: failCount, delayMs: Math.round(delay) },
        `🔄 网络错误 — 第 ${attempt + 1}/${MAX_RETRIES} 次重试: ${err.message}${cause}，等待 ${Math.round(delay)}ms (连续失败: ${failCount})`);
      await sleep(delay);
    } finally {
      if (clientSignal) clientSignal.removeEventListener("abort", onClientAbort);
    }
  }

  // 理论上不可达；兜底发出 failed 再抛出，避免静默丢失终态
  emit("failed", { id: reqId, reason: "exhausted", retries: MAX_RETRIES, durationMs: dur() },
    `✗ 重试耗尽 (${MAX_RETRIES} 次)`);
  const e = new Error(`All ${MAX_RETRIES} retries exhausted`);
  e.__xfEmitted = true;
  throw e;
}

// ── 请求体读取 ────────────────────────────────────────
function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// ── 注入 enable_thinking ───────────────────────────────
// 讯飞模型默认不开启思考，在请求体缺失 enable_thinking 时自动补入
function injectThinking(bodyBuffer) {
  try {
    const body = JSON.parse(bodyBuffer.toString("utf8"));
    if (body.enable_thinking === undefined) {
      body.enable_thinking = true;
      return Buffer.from(JSON.stringify(body), "utf8");
    }
  } catch (e) {
    // 非 JSON 请求体（不应发生），原样透传
  }
  return bodyBuffer;
}

// ── SSE 流式转发 ──────────────────────────────────────
async function pipeStream(response, res, reqId, reqBytes, onData, idleTimeoutMs = 60_000) {
  res.writeHead(response.status, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  // 跟踪流式 usage（讯飞/OpenAI 在最终 chunk 带 usage），流结束后上报
  let lastUsage = null;
  let lastFinish = null;

  // 统一出口：转发给客户端，同时喂给日志采集器
  const _emit = (chunk) => {
    if (res.writableEnded || res.destroyed) return;
    res.write(chunk);
    if (onData) onData(chunk);
  };

  // 客户端断开 → 取消上游读取，避免无意义转发与连接挂起
  const onClientClose = () => {
    try { reader.cancel(); } catch {}
  };
  res.on("close", onClientClose);

  try {
    while (true) {
      // idle 超时：上游 hang 住不发数据时主动取消，避免连接永久挂起
      const idleTimer = setTimeout(() => {
        try { reader.cancel(new Error("stream idle timeout")); } catch {}
      }, idleTimeoutMs);

      let readResult;
      try {
        readResult = await reader.read();
      } catch (readErr) {
        clearTimeout(idleTimer);
        if (res.writableEnded || res.destroyed) break; // 客户端断开导致的中断，静默退出
        emit("stream_interrupt", { id: reqId, msg: readErr.message },
          `⚠ 流读取中断: ${readErr.message}`);
        break;
      }
      clearTimeout(idleTimer);

      const { done, value } = readResult;
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        // 只转发 data: 行和空行（SSE 分隔符），过滤讯飞非标准 event:
        if (line.startsWith("data:")) {
          // 解析 usage（讯飞/OpenAI 流式在最终 chunk 带 usage）
          const payload = line.slice(5).trim();
          if (payload && payload !== "[DONE]") {
            try {
              const obj = JSON.parse(payload);
              if (obj.usage) lastUsage = obj.usage;
              const fr = obj.choices?.[0]?.finish_reason;
              if (fr) lastFinish = fr;
            } catch {}
          }
          _emit(line + "\n");
        } else if (line === "") {
          _emit("\n");
        } else if (line.startsWith("event:")) {
          const eventType = line.slice(6).trim();
          // 仅转发标准 message 事件
          if (eventType === "message") {
            _emit(line + "\n");
          }
          // 其他事件静默丢弃 (progress_notice, context_usage 等)
        }
        // 其他行（id:、:注释心跳、retry: 等）静默丢弃
      }
    }

    // 刷新 buffer 残留
    if (buffer && !res.writableEnded) {
      _emit(buffer + "\n");
    }
  } finally {
    res.off("close", onClientClose);
    try { reader.releaseLock(); } catch {}
  }
  // 流结束后上报 usage（对比 reqBytes vs 讯飞报的 token，用于诊断 cache 虚高）
  if (lastUsage) {
    const u = lastUsage;
    emit("usage", {
      id: reqId, stream: true, reqBytes,
      in: u.prompt_tokens,
      out: u.completion_tokens,
      cached: u.prompt_tokens_details?.cached_tokens,
      total: u.total_tokens,
      finish: lastFinish,
    });
  }
  if (!res.writableEnded) res.end();
}

// ── HTTP 服务器 ───────────────────────────────────────
const http = require("http");

const server = http.createServer(async (req, res) => {
  const startTime = Date.now();
  const reqId = `${procTag}-${++reqSeq}`;

  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;

  // 健康检查
  if (path === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }

  // ── 构建上游请求 ──
  const upstreamPath = path.replace(/^\/v1/, ""); // /v1/chat/completions → /chat/completions
  const upstreamUrl = `${XFYUN_BASE}${upstreamPath}${url.search}`;

  const headers = {};
  const HOP_BY_HOP = new Set(["host", "authorization", "connection", "expect",
    "keep-alive", "transfer-encoding", "upgrade", "proxy-connection", "te", "trailer"]);
  for (const [k, v] of Object.entries(req.headers)) {
    if (HOP_BY_HOP.has(k)) continue;
    headers[k] = v;
  }
  headers["authorization"] = `Bearer ${API_KEY}`;
  headers["host"] = new URL(XFYUN_BASE).host;

  const isChat = upstreamPath === "/chat/completions";

  emit("req_start", { id: reqId, method: req.method, path: upstreamPath, chat: isChat });

  let bodyBuffer;
  let isStream = false;
  if (req.method !== "GET" && req.method !== "HEAD") {
    bodyBuffer = await readRequestBody(req);
    if (isChat && bodyBuffer && bodyBuffer.length > 0) {
      const before = bodyBuffer;
      bodyBuffer = injectThinking(bodyBuffer);
      if (bodyBuffer !== before) {
        emit("think_inject", { id: reqId });
        delete headers["content-length"]; // 体长已变，交由 fetch 自动计算
      }
      try { isStream = JSON.parse(bodyBuffer.toString("utf8")).stream === true; } catch {}
    }
  }

  // ── 全量日志：请求 ──
  if (LOG_LEVEL >= 2) {
    logDetail(
      `\n${"═".repeat(60)}\n` +
      `[${_ts()}] → ${req.method} ${upstreamUrl}\n` +
      `Headers: ${JSON.stringify(redactHeaders(headers), null, 2)}\n` +
      `Body: ${bodyBuffer ? bodyBuffer.toString("utf8") : "(empty)"}\n`
    );
  }

  // 客户端断开 → 中止上游请求与重试，避免无意义消耗上游配额
  const clientAbort = new AbortController();
  const onClientClose = () => {
    if (!res.writableEnded) clientAbort.abort();
  };
  res.on("close", onClientClose);

  try {
    const upstreamResp = await fetchWithRetry(
      upstreamUrl,
      {
        method: req.method,
        headers,
        body: bodyBuffer || undefined,
      },
      isStream,
      reqId,
      clientAbort.signal
    );

    // 流式转发
    if (isStream && upstreamResp.ok) {
      // full 级流式日志：直接边到边写入文件，不在内存中累积（避免长对话内存膨胀）
      if (LOG_LEVEL >= 2) {
        logDetail(`[${_ts()}] ← STREAM ${upstreamResp.status}\n`);
      }
      const collector = LOG_LEVEL >= 2 ? (chunk) => logDetail(chunk) : null;
      await pipeStream(upstreamResp, res, reqId, bodyBuffer?.length || 0, collector);
      if (LOG_LEVEL >= 2) {
        logDetail(`[${_ts()}] STREAM 完成 (${Date.now() - startTime}ms)\n${"═".repeat(60)}\n`);
      }
    } else {
      // 非流式：直接转发
      const bodyText = await upstreamResp.text();
      const respHeaders = {};
      upstreamResp.headers.forEach((v, k) => {
        if (k !== "transfer-encoding" && k !== "content-encoding") {
          respHeaders[k] = v;
        }
      });
      res.writeHead(upstreamResp.status, respHeaders);
      res.end(bodyText);
      // 非流式：解析 usage 上报（用于诊断 cache 虚高）
      if (isChat) {
        try {
          const resp = JSON.parse(bodyText);
          const u = resp.usage || {};
          emit("usage", {
            id: reqId, stream: false, reqBytes: bodyBuffer?.length || 0,
            in: u.prompt_tokens,
            out: u.completion_tokens,
            cached: u.prompt_tokens_details?.cached_tokens,
            total: u.total_tokens,
            finish: resp.choices?.[0]?.finish_reason,
          });
        } catch {}
      }
      if (LOG_LEVEL >= 2) {
        logDetail(
          `[${_ts()}] ← ${upstreamResp.status} (${Date.now() - startTime}ms)\n` +
          `Headers: ${JSON.stringify(respHeaders, null, 2)}\n` +
          `Body: ${bodyText}\n${"═".repeat(60)}\n`
        );
      }
    }
  } catch (err) {
    if (!err.__xfEmitted) {
      emit("failed", { id: reqId, reason: "proxy_error", msg: err.message, durationMs: Date.now() - startTime },
        `✗ 请求失败: ${err.message}`);
    }
    if (LOG_LEVEL >= 2) {
      logDetail(
        `[${_ts()}] ✗ ERROR (${Date.now() - startTime}ms): ${err.stack || err.message}\n` +
        `${"═".repeat(60)}\n`
      );
    }
    if (res.writableEnded || res.destroyed) {
      // 客户端已断开，无法再写
    } else if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: `proxy error: ${err.message}`, type: "proxy_error" } }));
    } else {
      res.end();
    }
  } finally {
    res.off("close", onClientClose);
  }
});

// ── 启动 ──────────────────────────────────────────────
// 结构化事件日志始终写入，日志目录必须存在
const _LEVEL_NAME = Object.keys(LOG_LEVELS).find((k) => LOG_LEVELS[k] === LOG_LEVEL);
try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch {}

if (!API_KEY) {
  emit("fatal", { reason: "no_api_key" }, "✗ 错误: 请设置 XFYUN_API_KEY 环境变量");
  process.exit(1);
}

// 后台运行（无控制台）时也要把致命错误落盘
process.on("uncaughtException", (err) => {
  emit("fatal", { reason: "uncaughtException", msg: err.message, stack: err.stack },
    `✗ uncaughtException: ${err.stack || err.message}`);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  emit("fatal", { reason: "unhandledRejection", msg: reason && reason.message ? reason.message : String(reason) },
    `✗ unhandledRejection: ${reason && reason.stack ? reason.stack : reason}`);
});

server.on("error", (err) => {
  emit("fatal", { reason: "server_error", msg: err.message }, `✗ 服务启动失败: ${err.message}`);
  process.exit(1);
});

server.listen(PORT, "127.0.0.1", () => {
  const banner = [
    "═══════════════════════════════════════════",
    "  讯飞星辰本地代理 (自定义重试策略)",
    `  监听:     http://127.0.0.1:${PORT}`,
    `  上游:     ${XFYUN_BASE}`,
    `  重试间隔: ${RETRY_DELAY}ms (固定 + ±${Math.round(JITTER_RATIO * 100)}% 抖动)`,
    `  重试上限: ${MAX_RETRIES} 次`,
    `  冷却策略: 每 ${COOLDOWN_AFTER} 次连续失败冷却 ${COOLDOWN_MS / 1000}s`,
    `  日志级别: ${_LEVEL_NAME}${LOG_LEVEL >= 2 ? ` + ${LOG_FILE}` : ""}`,
    `  事件日志: ${LOG_EVENTS_FILE} (滚动 ${EVENT_LOG_MAX_LINES} 行)`,
    "═══════════════════════════════════════════",
  ].join("\n");
  emit("start", {
    port: PORT, upstream: XFYUN_BASE, retryDelay: RETRY_DELAY,
    maxRetries: MAX_RETRIES, cooldownAfter: COOLDOWN_AFTER, cooldownMs: COOLDOWN_MS,
    logLevel: _LEVEL_NAME,
  }, banner);
});
