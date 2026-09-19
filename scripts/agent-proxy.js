#!/usr/bin/env bun
// Thin launcher — real proxy is scripts/agent-proxy.py (AgentRouter + DeepSeek fallback).
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const py = resolve(import.meta.dir, "../.venv/bin/python");
const script = resolve(import.meta.dir, "agent-proxy.py");
const child = spawn(py, [script], { stdio: "inherit", env: process.env });
child.on("exit", (code) => process.exit(code ?? 1));
