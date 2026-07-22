#!/usr/bin/env node
/**
 * 上下文窗口探针 — 通过 xf-proxy 直接探测讯飞 GLM-5.2 的真实可用窗口
 *
 * 策略：
 *   1. 构造指定大小的填充文本（中文段落 + 序号）
 *   2. 在总文本的 5% / 50% / 95% 位置各埋一个唯一密码（针）
 *   3. 问模型三个密码分别是什么
 *   4. 记录讯飞返回的 usage.input / output / totalTokens
 *   5. 检查响应是否含三个针 → 判断是否被截断
 *
 * 用法: node probe-context.js
 */
"use strict";

const PROXY = "http://127.0.0.1:3000/v1/chat/completions";
const MODEL = process.env.PROBE_MODEL || "xopglm52";

// 目标发送字符数（中文为主，约 1 token ≈ 2.5~3 字符）
const TARGETS = [
  { chars: 60_000,    label: "~20k tok" },
  { chars: 360_000,   label: "~120k tok" },
  { chars: 500_000,   label: "~170k tok" },
  { chars: 780_000,   label: "~260k tok" },
  { chars: 1_400_000, label: "~470k tok" },
];

const PAD_SEGMENT =
  "本段是上下文窗口测试填充文本用于观察模型在何种输入规模下开始丢失早期内容，" +
  "请忽略其语义只关注其中标注的关键信息。";

function makePasswd(tag) {
  const r = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `${tag}-${r}`;
}

/** 构造填充文本，并在 pct 位置插入针段 */
function buildFill(totalChars, needles) {
  // needles: [{pct, tag, passwd}]
  const segLen = PAD_SEGMENT.length + 12; // "第000001段：" + 段 + "\n"
  const segCount = Math.ceil(totalChars / segLen);
  const lines = [];
  // 预计算每个针落在哪一段
  const bySeg = {};
  for (const n of needles) {
    const segIdx = Math.floor(segCount * n.pct);
    bySeg[segIdx] = n;
  }
  for (let i = 0; i < segCount; i++) {
    const idx = String(i + 1).padStart(6, "0");
    const n = bySeg[i];
    if (n) {
      lines.push(`第${idx}段：【关键信息】秘密密码为 ${n.passwd}，请务必记住。${PAD_SEGMENT}`);
    } else {
      lines.push(`第${idx}段：${PAD_SEGMENT}`);
    }
  }
  return { text: lines.join("\n"), segCount };
}

async function probe(target) {
  const nStart = makePasswd("NEEDLE-START");
  const nMid = makePasswd("NEEDLE-MID");
  const nEnd = makePasswd("NEEDLE-END");
  const { text, segCount } = buildFill(target.chars, [
    { pct: 0.05, tag: "START", passwd: nStart },
    { pct: 0.50, tag: "MID", passwd: nMid },
    { pct: 0.95, tag: "END", passwd: nEnd },
  ]);

  const userQ =
    "文本里埋了三个密码，分别在第000001段附近、中间段、最后段。" +
    "请只输出三个密码本身，每行一个，顺序：开头密码 / 中间密码 / 结尾密码。不要解释。";

  const body = {
    model: MODEL,
    stream: false,
    enable_thinking: false,
    max_tokens: 200,
    messages: [
      { role: "system", content: text },
      { role: "user", content: userQ },
    ],
  };

  const bodyBytes = Buffer.byteLength(JSON.stringify(body), "utf8");
  const t0 = Date.now();
  let resp;
  try {
    resp = await fetch(PROXY, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer local-proxy" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(240_000),
    });
  } catch (e) {
    return { ...target, sentChars: text.length, segCount, bodyKB: (bodyBytes / 1024).toFixed(0),
             error: `fetch: ${e.message}`, ms: Date.now() - t0 };
  }
  const ms = Date.now() - t0;
  const respText = await resp.text();
  let parsed;
  try { parsed = JSON.parse(respText); } catch { parsed = null; }

  if (!resp.ok) {
    const errMsg = parsed?.error?.message || parsed?.message || respText.slice(0, 200);
    return { ...target, sentChars: text.length, segCount, bodyKB: (bodyBytes / 1024).toFixed(0),
             http: resp.status, error: String(errMsg).slice(0, 200), ms };
  }

  const usage = parsed?.usage || {};
  const content = parsed?.choices?.[0]?.message?.content || "";
  const hitStart = content.includes(nStart);
  const hitMid = content.includes(nMid);
  const hitEnd = content.includes(nEnd);
  const hits = [hitStart, hitMid, hitEnd].filter(Boolean).length;

  return {
    ...target,
    sentChars: text.length,
    segCount,
    bodyKB: (bodyBytes / 1024).toFixed(0),
    http: resp.status,
    inTok: usage.prompt_tokens ?? usage.input_tokens ?? usage.input,
    outTok: usage.completion_tokens ?? usage.output_tokens ?? usage.output,
    totTok: usage.total_tokens,
    cacheRead: usage.prompt_tokens_details?.cached_tokens ?? usage.cacheRead,
    hits,
    hitStart, hitMid, hitEnd,
    reply: content.replace(/\s+/g, " ").slice(0, 120),
    ms,
  };
}

function fmtRow(r) {
  if (r.error) {
    return `${r.label.padEnd(10)} chars=${String(r.sentChars).padStart(7)} body=${String(r.bodyKB).padStart(5)}KB http=${r.http||"-"}  ERROR: ${r.error}  (${r.ms}ms)`;
  }
  const hitsStr = `${r.hitStart?"✓":"✗"}${r.hitMid?"✓":"✗"}${r.hitEnd?"✓":"✗"}`;
  return `${r.label.padEnd(10)} chars=${String(r.sentChars).padStart(7)} body=${String(r.bodyKB).padStart(5)}KB ` +
         `in=${String(r.inTok).padStart(7)} out=${String(r.outTok).padStart(5)} ` +
         `cacheR=${String(r.cacheRead ?? "-").padStart(7)} ` +
         `针=${hitsStr}(${r.hits}/3) (${r.ms}ms)`;
}

(async () => {
  console.log(`探针 → ${PROXY}  model=${MODEL}  enable_thinking=false  max_tokens=200\n`);
  console.log("图例: 针=开头/中间/结尾 命中(✓=答对,✗=丢失)。in=讯飞返回 usage.input\n");
  for (const t of TARGETS) {
    process.stdout.write(`发送 ${t.label} ... `.padEnd(24));
    const r = await probe(t);
    process.stdout.write("\r" + " ".repeat(24) + "\r");
    console.log(fmtRow(r));
    if (r.reply) console.log("    reply: " + r.reply);
  }
})();
