#!/usr/bin/env node
import {
  bootstrapHelp,
  formatHumanReport,
  parseBootstrapArgs,
  runBootstrap
} from "../src/bootstrap/index.mjs";

const args = process.argv.slice(2);
const parsed = parseBootstrapArgs(args);

if (parsed.help && parsed.ok) {
  console.log(bootstrapHelp());
  process.exitCode = 0;
} else {
  try {
    const report = await runBootstrap({ argv: args });
    if (parsed.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(formatHumanReport(report));
    }
    process.exitCode = report.ok ? 0 : 1;
  } catch {
    const issue = {
      ok: false,
      issues: [{
        code: "bootstrap.unexpected_failure",
        message: "Bootstrap stopped safely because an unexpected local error occurred."
      }]
    };
    if (parsed.json) {
      console.error(JSON.stringify(issue, null, 2));
    } else {
      console.error("継手のセットアップを安全に停止しました。ローカルの権限、空き容量、ファイル競合を確認して再実行してください。");
    }
    process.exitCode = 1;
  }
}
