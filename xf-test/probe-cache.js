#!/usr/bin/env node
// 验证讯飞 prompt cache 的 usage 语义：连发相同请求，看 cached 增长时 total 如何变化
"use strict";
const PROXY = "http://127.0.0.1:3000/v1/chat/completions";
const MODEL = "xopglm52";
const PAD = "本段是上下文窗口测试填充文本用于观察模型在何种输入规模下开始丢失早期内容，请忽略其语义只关注其中标注的关键信息。";

// 中等大小，足以触发缓存
const segCount = 1500; // ~100k 字符
const lines = [];
for (let i = 0; i < segCount; i++) {
  lines.push(`第${String(i+1).padStart(6,"0")}段：${PAD}`);
}
const sys = lines.join("\n");
const body = {
  model: MODEL, stream: false, enable_thinking: false, max_tokens: 20,
  messages: [
    { role: "system", content: sys },
    { role: "user", content: "请回复 OK 两个字。" },
  ],
};
const bodyStr = JSON.stringify(body);
console.log(`请求体 ${ (Buffer.byteLength(bodyStr,"utf8")/1024).toFixed(0) }KB, sys字符=${sys.length}\n`);

async function once(n) {
  const t0 = Date.now();
  const r = await fetch(PROXY, { method:"POST", headers:{"content-type":"application/json",authorization:"Bearer local-proxy"},
    body: bodyStr, signal: AbortSignal.timeout(120000) });
  const j = await r.json();
  const u = j.usage || {};
  const ms = Date.now() - t0;
  const cached = u.prompt_tokens_details?.cached_tokens ?? 0;
  console.log(`#${n}  http=${r.status} (${ms}ms)  prompt=${u.prompt_tokens}  completion=${u.completion_tokens}  total=${u.total_tokens}  cached=${cached}`);
  console.log(`     算法A(total=prompt+completion): ${u.prompt_tokens}+${u.completion_tokens}=${(u.prompt_tokens||0)+(u.completion_tokens||0)}`);
  console.log(`     算法B(total=prompt+completion+cached): ${(u.prompt_tokens||0)+(u.completion_tokens||0)+cached}`);
  console.log(`     reply: ${(j.choices?.[0]?.message?.content||"").slice(0,40)}`);
}

(async () => {
  for (let i = 1; i <= 3; i++) {
    await once(i);
    if (i < 3) await new Promise(r => setTimeout(r, 2000));
  }
  console.log("\n判读:");
  console.log(" - 若 #2/#3 的 prompt 变小、cached 变大、total 不变 → prompt=未缓存部分, total=真实大小(cache不虚高)");
  console.log(" - 若 #2/#3 的 total 随 cached 增大 → total 把缓存重复计入(cache虚高, 即会话跳变根因)");
})();
