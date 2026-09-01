/**
 * acp-stream-probe — 诊断 dsh --profile acp 的 session/update 事件到达节奏。
 *
 * 用法: node scripts/acp-stream-probe.mjs [prompt]
 * 默认 prompt: 请从1数到10，每个数字一行。
 *
 * 对每个 session/update 打印: 时间戳 | sessionUpdate 类型 | 文本长度 | 前 40 字符。
 * 用于判断内核是流式 delta 还是一次性 committed 消息。
 */
import { spawn } from "node:child_process";

const prompt = process.argv[2] ?? "请从1数到10，每个数字一行。";
const t0 = Date.now();
const ts = () => `${((Date.now() - t0) / 1000).toFixed(2)}s`;

const isWin = process.platform === "win32";
const child = isWin
  ? spawn("cmd", ["/C", "dsh", "--profile", "acp"], { stdio: ["pipe", "pipe", "pipe"] })
  : spawn("dsh", ["--profile", "acp"], { stdio: ["pipe", "pipe", "pipe"] });

let buf = "";
let sessionId = null;
let counts = {};

child.stdout.on("data", (d) => {
  buf += d.toString();
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    let v;
    try { v = JSON.parse(line); } catch { continue; }

    if (v.method === "session/update") {
      const u = v.params?.update ?? {};
      const kind = u.sessionUpdate ?? "?";
      let len = 0;
      let head = "";
      if (Array.isArray(u.content)) {
        len = u.content.reduce((a, b) => a + (b.text?.length ?? 0), 0);
        head = u.content.map((b) => b.text ?? "").join("").slice(0, 40);
      } else if (u.content?.text) {
        len = u.content.text.length;
        head = u.content.text.slice(0, 40);
      } else if (u.content?.type === "tool_call" || u.toolCallId) {
        head = u.title ?? "";
      }
      counts[kind] = (counts[kind] ?? 0) + 1;
      console.log(`${ts()}  ${kind}  len=${len}  #${counts[kind]}  ${JSON.stringify(head)}`);
    } else if (v.id !== undefined && (v.result || v.error)) {
      if (v.id === 1) {
        console.log(`${ts()}  initialize ok`);
        send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: process.cwd(), mcpServers: [] } });
      } else if (v.id === 2) {
        sessionId = v.result?.sessionId;
        console.log(`${ts()}  session/new → ${sessionId}`);
        send({ jsonrpc: "2.0", id: 3, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: prompt }] } });
        console.log(`${ts()}  prompt sent: ${JSON.stringify(prompt)}`);
      } else if (v.id === 3) {
        console.log(`${ts()}  prompt settled: stopReason=${v.result?.stopReason}`);
        console.log(`\n=== 汇总 ===`);
        for (const [k, n] of Object.entries(counts)) console.log(`  ${k}: ${n} 个事件`);
        const msgEvents = counts["agent_message_chunk"] ?? 0;
        console.log(
          msgEvents <= 2
            ? "❌ 内核未流式：assistant 消息以 ≤2 个 committed 块到达"
            : "✅ 内核流式：assistant 消息分多个 delta 到达",
        );
        child.stdin.end();
        setTimeout(() => process.exit(0), 500);
      }
    } else if (v.method) {
      // agent 请求（权限等）直接拒绝
      if (v.id !== undefined) {
        send({ jsonrpc: "2.0", id: v.id, result: { outcome: { outcome: "cancelled" } } });
      }
    }
  }
});

child.stderr.on("data", (d) => process.stderr.write(`[dsh] ${d}`));
child.on("error", (e) => { console.error("spawn error:", e); process.exit(1); });
child.on("exit", (code) => { console.error(`[dsh exited: ${code}]`); });
function send(obj) { child.stdin.write(JSON.stringify(obj) + "\n"); }

console.log(ts(), "spawned, sending initialize…");
setTimeout(() => send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } }), 800);
setTimeout(() => { console.log("超时退出"); child.kill(); process.exit(1); }, 90000);
