#!/usr/bin/env python3
"""
Local OpenAI-compatible proxy for the Privacy Agent extension.

Order of attempts for each /v1/chat/completions request:
  1) AgentRouter (https://agentrouter.org/v1) via sync OpenAI SDK
     — works when WAF allows this IP (see https://agentrouter.org/docs/pi.html)
  2) DeepSeek official (https://api.deepseek.com) as a reliable fallback
     — maps deepseek-v4-flash / glm-5.3 → deepseek-chat

The Chrome extension must talk to this proxy (http://127.0.0.1:8787/v1), never
directly to agentrouter.org (Aliyun WAF blocks browser TLS fingerprints).
"""
from __future__ import annotations

import json
import os
import re
from pathlib import Path

import uvicorn
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from openai import OpenAI

ROOT = Path(__file__).resolve().parents[1]
ENV_LOCAL = ROOT / ".env.local"
PORT = int(os.environ.get("AGENT_PROXY_PORT", "8787"))

AGENTROUTER_BASE = os.environ.get("AGENTROUTER_BASE_URL", "https://agentrouter.org/v1").rstrip("/")
# AgentRouter's WAF rejects the OpenAI SDK user agent. This is the allowlisted CLI agent.
AGENTROUTER_USER_AGENT = os.environ.get("AGENTROUTER_USER_AGENT", "QwenCode/0.2.0 (linux x64)")
DEEPSEEK_BASE = os.environ.get("DEEPSEEK_BASE_URL", "https://api.deepseek.com").rstrip("/")

MODEL_MAP = {
    "deepseek-v4-flash": "deepseek-chat",
    "deepseek-v4f": "deepseek-chat",
    "glm-5.3": "deepseek-chat",
    "glm-5.2": "deepseek-chat",
}


def _load_env_file() -> None:
    if not ENV_LOCAL.exists():
        return
    for line in ENV_LOCAL.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key, value = key.strip(), value.strip().strip('"').strip("'")
        os.environ.setdefault(key, value)


_load_env_file()


def _key(*names: str) -> str:
    for name in names:
        value = (os.environ.get(name) or "").strip()
        if value:
            return value
    return ""


AGENTROUTER_KEY = _key("AGENTROUTER_API_KEY", "VITE_AGENTROUTER_API_KEY", "PI_GATEWAY_API_KEY")
DEEPSEEK_KEY = _key("DEEPSEEK_API_KEY", "VITE_DEEPSEEK_API_KEY")

app = FastAPI(title="Privacy Agent LLM Proxy")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

_agentrouter_disabled_until = 0.0


def _is_waf_block(exc: Exception) -> bool:
    text = str(exc)
    status = getattr(exc, "status_code", None)
    if status == 405:
        return True
    return bool(re.search(r"405|waf|doctype|unauthorized client|blocked", text, re.I))


def _forward(client: OpenAI, body: dict) -> dict:
    # Pass through OpenAI chat.completions fields; SDK accepts **kwargs via create().
    allowed = {
        "model",
        "messages",
        "tools",
        "tool_choice",
        "temperature",
        "max_tokens",
        "top_p",
        "stream",
        "response_format",
        "stop",
        "presence_penalty",
        "frequency_penalty",
        "user",
        "n",
    }
    kwargs = {k: v for k, v in body.items() if k in allowed and v is not None}
    kwargs["stream"] = False
    # AgentRouter thinking mode rejects assistant content: null on tool turns.
    messages = kwargs.get("messages")
    if isinstance(messages, list):
        fixed = []
        for message in messages:
            if not isinstance(message, dict):
                fixed.append(message)
                continue
            item = dict(message)
            if item.get("role") == "assistant" and item.get("content") is None:
                item["content"] = ""
            if item.get("role") == "assistant" and "reasoning_content" not in item and item.get("tool_calls"):
                item["reasoning_content"] = ""
            fixed.append(item)
        kwargs["messages"] = fixed
    completion = client.chat.completions.create(**kwargs)
    data = completion.model_dump(exclude_none=True)
    # Keep empty content as "" so clients do not round-trip null.
    for choice in data.get("choices") or []:
        message = choice.get("message")
        if isinstance(message, dict) and message.get("content") is None:
            message["content"] = ""
        if isinstance(message, dict) and "reasoning_content" not in message and message.get("tool_calls"):
            message["reasoning_content"] = ""
    return data


def _client(api_key: str, base_url: str, timeout: float = 60.0, user_agent: str | None = None) -> OpenAI:
    # custom headers are applied after the SDK user agent, so this is what AgentRouter sees.
    headers = {"User-Agent": user_agent} if user_agent else None
    return OpenAI(api_key=api_key, base_url=base_url, timeout=timeout, default_headers=headers)


@app.get("/health")
@app.get("/v1/health")
def health():
    return {
        "ok": True,
        "agentrouter": {
            "base": AGENTROUTER_BASE,
            "keyConfigured": bool(AGENTROUTER_KEY),
        },
        "deepseekFallback": {
            "base": DEEPSEEK_BASE,
            "keyConfigured": bool(DEEPSEEK_KEY),
        },
        "modelMap": MODEL_MAP,
    }


@app.post("/v1/chat/completions")
async def chat_completions(request: Request):
    import time

    global _agentrouter_disabled_until

    body = await request.json()
    auth = request.headers.get("Authorization") or ""
    bearer = auth[7:].strip() if auth.lower().startswith("bearer ") else ""

    ar_key = bearer or AGENTROUTER_KEY
    ds_key = DEEPSEEK_KEY or bearer
    requested_model = body.get("model") or "deepseek-chat"
    errors: list[str] = []

    # 1) AgentRouter (Pi docs: https://agentrouter.org/docs/pi.html)
    if ar_key and time.time() >= _agentrouter_disabled_until:
        try:
            client = _client(ar_key, AGENTROUTER_BASE, timeout=60.0, user_agent=AGENTROUTER_USER_AGENT)
            data = _forward(client, {**body, "model": requested_model})
            data["_proxy"] = {"upstream": "agentrouter", "model": requested_model}
            return JSONResponse(data)
        except Exception as exc:  # noqa: BLE001
            errors.append(f"agentrouter: {exc}")
            if _is_waf_block(exc):
                _agentrouter_disabled_until = time.time() + 300
                errors.append("agentrouter WAF blocked — cooling down 5m, using DeepSeek fallback")

    # 2) DeepSeek official fallback
    if ds_key:
        mapped = MODEL_MAP.get(requested_model, requested_model)
        if mapped.startswith("glm") or mapped.startswith("gpt") or mapped.startswith("claude"):
            mapped = "deepseek-chat"
        try:
            client = _client(ds_key, DEEPSEEK_BASE, timeout=90.0)
            data = _forward(client, {**body, "model": mapped})
            data["_proxy"] = {
                "upstream": "deepseek",
                "requestedModel": requested_model,
                "model": mapped,
                "note": "AgentRouter unavailable; served via DeepSeek official API",
            }
            return JSONResponse(data)
        except Exception as exc:  # noqa: BLE001
            errors.append(f"deepseek: {exc}")

    return JSONResponse(
        {
            "error": {
                "message": "All upstreams failed. " + " | ".join(errors[:4]),
                "type": "proxy_upstream_error",
            }
        },
        status_code=502,
    )


@app.get("/v1/models")
def models():
    return {
        "object": "list",
        "data": [
            {"id": "deepseek-v4-flash", "object": "model"},
            {"id": "glm-5.3", "object": "model"},
            {"id": "deepseek-chat", "object": "model"},
        ],
    }


if __name__ == "__main__":
    print(f"Privacy Agent LLM proxy on http://127.0.0.1:{PORT}/v1")
    print(f"  AgentRouter: {AGENTROUTER_BASE} key={'yes' if AGENTROUTER_KEY else 'no'}")
    print(f"  DeepSeek:    {DEEPSEEK_BASE} key={'yes' if DEEPSEEK_KEY else 'no'}")
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="info")
