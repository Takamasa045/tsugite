import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { spawn } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { createDurableSubmissionJournal } from "../adapters/elevenlabs-v4/durability.mjs";
import { generateElevenV4 as generateWithRealBilling } from "../adapters/elevenlabs-v4/client.mjs";

import { fixturePermit } from "./fixtures/elevenlabs-v4-authority.mjs";
const generateElevenV4 = (payload, options = {}) => generateWithRealBilling({ run_id: "fixture-run", ...payload }, { authorizeRecovery: async () => {}, inspectAudio: async () => ({ duration_seconds: 1 }), authorizeSubmission: async () => fixturePermit(payload.request), ...options });

const request = { id: "durability-test", operation: "voice", model: "eleven_v4", prompt: "Connection test.", params: { voice_id: "fixture-voice" } };
const rootDir = async () => fs.realpath(await fs.mkdtemp(join(tmpdir(), "tsugite-eleven-durable-")));
const speech = { name: "text_to_speech", inputSchema: { type: "object", properties: {
  text: { type: "string" }, voice_id: { type: "string" }, model_id: { type: "string", enum: ["eleven_v4"] }
}, required: ["text", "voice_id", "model_id"] } };
const client = (events = []) => ({ listTools: vi.fn(async () => ({ tools: [speech] })),
  callTool: vi.fn(async () => { events.push("submit"); return { content: [{ type: "audio", mimeType: "audio/mpeg", data: Buffer.from("ID3fixture").toString("base64") }] }; }) });

function observingFs(output, events, failAt) {
  let marker = false;
  const fail = (phase) => { if (phase === failAt) throw Object.assign(new Error("private filesystem diagnostic"), { code: "EACCES" }); };
  return {
    mkdir: async (...args) => { events.push("mkdir"); fail("mkdir"); return fs.mkdir(...args); },
    open: async (path, flags, mode) => {
      const isMarker = flags === "wx";
      const phase = isMarker ? "marker-open" : "directory-open";
      events.push(phase); fail(phase);
      const handle = await fs.open(path, flags, mode);
      if (isMarker) marker = true;
      return {
        stat: () => handle.stat(), close: () => handle.close(),
        writeFile: async data => { events.push("marker-write"); fail("marker-write"); return handle.writeFile(data); },
        sync: async () => {
          const phase = isMarker ? "file-sync" : marker && path === output ? "containing-directory-sync" : "ancestor-sync";
          events.push(phase); fail(phase); await handle.sync();
        }
      };
    }
  };
}

function startChild(root, trace, checkpoint) {
  const child = spawn(process.execPath, [resolve("test/fixtures/elevenlabs-v4-durable-child.mjs"), root, trace, ...(checkpoint ? [checkpoint] : [])],
    { stdio: ["ignore", "pipe", "pipe", "ipc"], env: { ...process.env, ELEVENLABS_MCP_ACCESS_TOKEN: "" } });
  let output = "";
  child.stdout.on("data", data => { output += data; });
  const exited = new Promise(resolve => child.once("exit", (code, signal) => resolve({ code, signal, output })));
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("child checkpoint timeout")), 10000);
    child.once("message", message => { clearTimeout(timer); resolve(message); });
    child.once("exit", () => { clearTimeout(timer); if (checkpoint) reject(new Error("child exited before checkpoint: " + output)); });
  });
  ready.catch(() => {});
  return { child, ready, exited };
}

describe("ElevenLabs paid submission durability", () => {
  it.each([false, true])("persists ancestor entries and the marker before submit (existing output directory: %s)", async (existing) => {
    const root = await rootDir(); const output = join(root, "assets", "elevenlabs-v4");
    if (existing) await fs.mkdir(output, { recursive: true });
    const events = []; const api = client(events);
    await generateElevenV4({ request, run_dir: root }, { client: api, filesystem: observingFs(output, events) });
    const submit = events.indexOf("submit"); const write = events.indexOf("marker-write");
    expect(events.lastIndexOf("ancestor-sync", write)).toBeGreaterThanOrEqual(0);
    expect(events.lastIndexOf("ancestor-sync", write)).toBeLessThan(write);
    expect(write).toBeLessThan(events.indexOf("file-sync"));
    expect(events.indexOf("file-sync")).toBeLessThan(events.indexOf("containing-directory-sync"));
    expect(events.indexOf("containing-directory-sync")).toBeLessThan(submit);
    expect(api.callTool).toHaveBeenCalledTimes(1);
  });

  it("refuses submission when any individual ancestor sync fails", async () => {
    const root=await rootDir();const output=join(root,"assets","elevenlabs-v4");
    const chain=[];for(let p=output;;p=dirname(p)){chain.push(p);if(dirname(p)===p)break;}
    for(let failIndex=0;failIndex<chain.length;failIndex++){
      let syncIndex=0;const api=client();const filesystem={mkdir:fs.mkdir,open:async(...args)=>{
        const h=await fs.open(...args);return {stat:()=>h.stat(),close:()=>h.close(),writeFile:data=>h.writeFile(data),sync:async()=>{
          if(syncIndex++===failIndex)throw Object.assign(new Error("injected sync failure"),{code:"EIO"});await h.sync();
        }};
      }};
      await expect(generateElevenV4({request,run_dir:root},{client:api,filesystem})).rejects.toMatchObject({code:"submission_not_durable"});
      expect(api.callTool).not.toHaveBeenCalled();
    }
  });

  it.each(["mkdir", "directory-open", "ancestor-sync", "marker-open", "marker-write", "file-sync", "containing-directory-sync"])("does not submit after %s fails and retains any marker", async phase => {
    const root = await rootDir();const output = join(root,"assets","elevenlabs-v4");const api = client();
    await expect(generateElevenV4({ request, run_dir: root }, { client: api, filesystem: observingFs(output, [], phase) }))
      .rejects.toMatchObject({ code: "submission_not_durable" });
    expect(api.callTool).not.toHaveBeenCalled();
    if (["marker-write","file-sync","containing-directory-sync"].includes(phase)) {
      expect((await fs.stat(join(output,request.id+".submission.jsonl"))).isFile()).toBe(true);
      await expect(generateElevenV4({ request, run_dir: root }, { client: api })).rejects.toMatchObject({ code: "receipt_unknown" });
      expect(api.callTool).not.toHaveBeenCalled();
    }
  });

  it("does not infer permission to resubmit from empty or partial old markers", async () => {
    for (const content of ["", "{", '{"phase":"submitting"}\n']) {
      const root = await rootDir();const output = join(root,"assets","elevenlabs-v4");await fs.mkdir(output,{recursive:true});
      const path=join(output,request.id+".submission.jsonl");await fs.writeFile(path,content);const api=client();
      await expect(generateElevenV4({request,run_dir:root},{client:api})).rejects.toMatchObject({code:content.startsWith('{"phase"') ? "receipt_legacy_unknown" : "receipt_unknown"});
      expect(await fs.readFile(path,"utf8")).toBe(content);expect(api.callTool).not.toHaveBeenCalled();
    }
  });

  it("rejects a symlinked ancestor before creating output in its target, even inside the run root", async () => {
    const root=await rootDir();const target=join(root,"retained-target");await fs.mkdir(target);await fs.symlink(target,join(root,"assets"));const api=client();
    await expect(generateElevenV4({request,run_dir:root},{client:api})).rejects.toMatchObject({code:"unsafe_output_directory"});
    expect(await fs.readdir(target)).toEqual([]);expect(api.callTool).not.toHaveBeenCalled();
  });

  it("allows at most one submission from two independent processes", async () => {
    const root=await rootDir();const trace=join(root,"submit.log");const a=startChild(root,trace);const b=startChild(root,trace);
    const results=await Promise.all([a.exited,b.exited]);expect(results.filter(r=>r.code===0).length).toBeGreaterThanOrEqual(1);
    expect(results.every(r=>r.code===0 || r.output.includes("submission_busy"))).toBe(true);
    expect((await fs.readFile(trace,"utf8")).trim().split("\n")).toEqual(["submit"]);
  },20000);

  it.each(["before-submit","accepted-before-record","accepted-after-record","download","linked"])("never adds a submission after SIGKILL at %s", async phase => {
    const root=await rootDir();const trace=join(root,"submit.log");const stopped=startChild(root,trace,phase);
    try { expect(await stopped.ready).toEqual({phase}); }
    finally { stopped.child.kill("SIGKILL"); }
    expect((await stopped.exited).signal).toBe("SIGKILL");
    const before=await fs.readFile(trace,"utf8").catch(()=>"");const restarted=await startChild(root,trace).exited;
    expect(await fs.readFile(trace,"utf8").catch(()=>"")).toBe(before);
    if (["before-submit", "accepted-before-record"].includes(phase)) {
      expect(restarted.code).toBe(20); expect(restarted.output).toContain("receipt_unknown");
    } else { expect(restarted.code).toBe(0); expect(JSON.parse(restarted.output)).toMatchObject({ ok: true, submissions: 0 }); }
  },20000);

  it("persists every directory entry in a power-loss model while file-only fsync loses the old marker", async () => {
    function model() {
      const entries=new Set(["/","/run","/run/assets","/run/assets/elevenlabs-v4"]);const durable=new Set(["/"]);const bytes=new Map();const durableBytes=new Map();
      return {entries,durable,crash:()=>{for(const p of [...entries])if(!durable.has(p))entries.delete(p);for(const p of [...bytes.keys()])if(!entries.has(p)||!durableBytes.has(p))bytes.delete(p);},
        open:async(path,flags)=>{
          if(flags==="wx"){if(entries.has(path))throw Object.assign(new Error(),{code:"EEXIST"});entries.add(path);bytes.set(path,"");}
          return {stat:async()=>({isDirectory:()=>!bytes.has(path)}),close:async()=>{},writeFile:async data=>bytes.set(path,String(data)),sync:async()=>{
            if(bytes.has(path))durableBytes.set(path,bytes.get(path));else for(const p of entries)if(dirname(p)===path)durable.add(p);
          }};
        }};
    }
    const directory="/run/assets/elevenlabs-v4";const marker=directory+"/attempt.submission.jsonl";
    const old=model();const h=await old.open(marker,"wx");await h.writeFile("submitting");await h.sync();await h.close();old.crash();expect(old.entries.has(marker)).toBe(false);
    const next=model();const journal=await createDurableSubmissionJournal(directory,"attempt",{phase:"submitting"},{filesystem:next,platform:"linux"});await journal.close();next.crash();
    expect(next.entries.has(marker)).toBe(true);
    await expect(createDurableSubmissionJournal(directory,"attempt",{phase:"submitting"},{filesystem:next,platform:"linux"}))
      .rejects.toMatchObject({code:"submission_already_exists_or_unwritable"});
  });

  it("syncs real directory entries on supported OSes and fails closed on unsupported ones", async () => {
    const root=await rootDir();const output=join(root,"assets","elevenlabs-v4");await fs.mkdir(output,{recursive:true});
    if(["darwin","linux"].includes(process.platform)){const handle=await createDurableSubmissionJournal(output,"os-check",{phase:"submitting"});await handle.close();}
    const api=client();await expect(generateElevenV4({request,run_dir:root},{client:api,platform:"win32"}))
      .rejects.toMatchObject({code:"submission_durability_unsupported"});expect(api.listTools).not.toHaveBeenCalled();expect(api.callTool).not.toHaveBeenCalled();
  });
});
