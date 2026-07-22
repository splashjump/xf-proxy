#!/usr/bin/env node
// 上下文窗口探针 v2 — 逐档独立、即时输出、失败继续
"use strict";
const PORT = process.env.PROXY_PORT || "3000";
const PROXY = `http://127.0.0.1:${PORT}/v1/chat/completions`;
const MODEL = process.env.PROBE_MODEL || "xopglm52";
const PAD = "本段是上下文窗口测试填充文本用于观察模型在何种输入规模下开始丢失早期内容，请忽略其语义只关注其中标注的关键信息。";
const SEG_LEN = PAD.length + 12;

// 已验证: 60k字符→34k tok, 360k字符→208k tok. 这里继续推大
const TARGETS = [
  { chars: 500_000,   label: "~286k tok" },
  { chars: 780_000,   label: "~446k tok" },
  { chars: 1_100_000, label: "~630k tok" },
  { chars: 1_500_000, label: "~860k tok" },
];

function pw(tag){ return tag+"-"+Math.random().toString(36).slice(2,8).toUpperCase(); }

function buildFill(total, needles){
  const segCount = Math.ceil(total/SEG_LEN);
  const bySeg={};
  for(const n of needles){ bySeg[Math.floor(segCount*n.pct)]=n; }
  const lines=[];
  for(let i=0;i<segCount;i++){
    const idx=String(i+1).padStart(6,"0");
    const n=bySeg[i];
    lines.push(n ? `第${idx}段：【关键信息】秘密密码为 ${n.passwd}，请务必记住。${PAD}` : `第${idx}段：${PAD}`);
  }
  return {text:lines.join("\n"), segCount};
}

async function probe(target){
  const ns=pw("START"), nm=pw("MID"), ne=pw("END");
  const {text, segCount}=buildFill(target.chars,[{pct:0.05,passwd:ns},{pct:0.5,passwd:nm},{pct:0.95,passwd:ne}]);
  const body={model:MODEL,stream:false,enable_thinking:false,max_tokens:200,
    messages:[{role:"system",content:text},
      {role:"user",content:"文本里埋了三个密码，分别在第000001段附近、中间段、最后段。请只输出三个密码本身，每行一个，顺序：开头/中间/结尾。不要解释。"}]};
  const bodyKB=(Buffer.byteLength(JSON.stringify(body),"utf8")/1024).toFixed(0);
  const t0=Date.now();
  process.stdout.write(`  发送 ${target.label} (chars=${text.length} body=${bodyKB}KB) ... `);
  try{
    const r=await fetch(PROXY,{method:"POST",headers:{"content-type":"application/json",authorization:"Bearer local-proxy"},
      body:JSON.stringify(body),signal:AbortSignal.timeout(280000)});
    const t=await r.text(); const ms=Date.now()-t0;
    let j; try{j=JSON.parse(t);}catch{ j=null; }
    if(!r.ok){
      const msg=j?.error?.message||j?.message||t.slice(0,150);
      console.log(`\r  ✗ ${target.label.padEnd(10)} http=${r.status} ERROR=${String(msg).slice(0,150)} (${ms}ms)`);
      return;
    }
    const u=j.usage||{}; const c=(j.choices?.[0]?.message?.content||"").replace(/\s+/g," ");
    const hits=`${c.includes(ns)?"✓":"✗"}${c.includes(nm)?"✓":"✗"}${c.includes(ne)?"✓":"✗"}`;
    console.log(`\r  ✓ ${target.label.padEnd(10)} in=${u.prompt_tokens} out=${u.completion_tokens} `+
      `cached=${u.prompt_tokens_details?.cached_tokens??0} total=${u.total_tokens} 针=${hits} (${ms}ms)`);
    console.log(`     reply: ${c.slice(0,160)}`);
  }catch(e){
    console.log(`\r  ✗ ${target.label.padEnd(10)} EXC: ${e.message} (${Date.now()-t0}ms)`);
  }
}

(async()=>{
  console.log(`探针v2 → ${PROXY} model=${MODEL}\n`);
  for(const t of TARGETS){ await probe(t); }
  console.log("\n完成。");
})();
