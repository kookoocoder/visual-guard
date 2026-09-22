(function () {
  const NEAR_BOTTOM = 120;
  const MAX_INPUT_PX = 108;
  const SVG_NS = "http://www.w3.org/2000/svg";
  const MODES = ["suggest", "confirm", "auto"];
  const MODE_LABEL = {
    suggest: "Suggest only",
    confirm: "Confirm each step",
    auto: "Execute end to end",
  };

  const ICON = {
    copy: "M9 9.5h9.5V20H9zM6.5 14.5H4.5V4H14v2",
    regen: "M20 12a8 8 0 1 1-2.4-5.7M20 4.5V9h-4.5",
    chev: "M9 6l6 6-6 6",
    stop: "M6 6h12v12H6z",
  };

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function icon(path) {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    const p = document.createElementNS(SVG_NS, "path");
    p.setAttribute("d", path);
    svg.append(p);
    return svg;
  }

  function clock() {
    return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  function mount(root, options) {
    const log = root.querySelector(".chat");
    const empty = root.querySelector(".chat__empty");
    const form = root.querySelector(".composer");
    const input = root.querySelector(".composer__input");
    const stopBtn = root.querySelector(".composer__stop");
    const sendBtn = root.querySelector(".composer__send:not(.composer__stop)");
    const modeChip = root.querySelector(".chip[data-mode]");
    const modeText = modeChip && modeChip.querySelector("span");

    const settings = options || {};
    let mode = MODES.includes(settings.mode) ? settings.mode : "confirm";
    let busy = false;
    let current = null;
    let lastUserText = "";

    function nearBottom() {
      return log.scrollHeight - log.scrollTop - log.clientHeight < NEAR_BOTTOM;
    }

    function toBottom(force) {
      if (force || nearBottom()) log.scrollTop = log.scrollHeight;
    }

    function reflag() {
      const items = [...log.querySelectorAll(".msg")];
      items.forEach((item, index) => {
        const role = item.classList.contains("msg--user") ? "user" : "agent";
        const before = items[index - 1];
        const after = items[index + 1];
        const sameBefore = before && before.classList.contains("msg--" + role);
        const sameAfter = after && after.classList.contains("msg--" + role);
        item.dataset.start = sameBefore ? "false" : "true";
        item.dataset.end = sameAfter ? "false" : "true";
        item.classList.toggle("msg--grouped", Boolean(sameBefore));
        const head = item.querySelector(".msg__head");
        if (head) head.hidden = Boolean(sameBefore);
      });
    }

    function addUser(text) {
      const stick = nearBottom();
      if (empty) empty.hidden = true;
      lastUserText = text;

      const msg = el("div", "msg msg--user");
      msg.append(el("div", "msg__bubble", text));
      log.append(msg);
      reflag();
      toBottom(stick);
      return msg;
    }

    function beginAgent() {
      const stick = nearBottom();
      if (empty) empty.hidden = true;

      const msg = el("div", "msg msg--agent");
      const head = el("div", "msg__head");
      head.append(el("span", "mark", "N"), el("span", "msg__name", "Nester"), el("span", "msg__time", clock()));
      const stack = el("div", "msg__stack");
      msg.append(head, stack);
      log.append(msg);
      reflag();
      toBottom(stick);

      let bubble = null;
      let textNode = null;
      let cursor = null;
      let reasoningBody = null;
      let reasoningLabel = null;
      let finished = false;

      function ensureBubble() {
        if (bubble) return;
        bubble = el("div", "msg__bubble");
        textNode = el("span");
        cursor = el("span", "cursor");
        bubble.append(textNode, cursor);
        stack.append(bubble);
      }

      const controller = {
        reasoning(initial) {
          const part = el("div", "part part--reasoning");
          const details = el("details", "thinking");
          details.open = true;
          const summary = el("summary", "thinking__summary");
          reasoningLabel = el("span", null, "Thinking…");
          const chev = icon(ICON.chev);
          chev.classList.add("thinking__chev");
          summary.append(chev, reasoningLabel);
          reasoningBody = el("div", "thinking__body", initial || "");
          details.append(summary, reasoningBody);
          part.append(details);
          stack.append(part);
          toBottom();
          return {
            write(delta) {
              reasoningBody.textContent += delta;
              toBottom();
            },
            end() {
              details.open = false;
              if (reasoningLabel) reasoningLabel.textContent = "Reasoning";
              toBottom();
            },
          };
        },

        tool(spec) {
          const stick = nearBottom();
          const part = el("div", "part part--tool");
          const details = el("details", "tool");
          details.dataset.state = "running";
          const summary = el("summary", "tool__head");
          const name = el("span", "tool__name", spec.name);
          const meta = el("span", "tool__meta", "running");
          summary.append(el("i", "tool__state"), name, meta);
          const body = el("div", "tool__body");
          const inputLabel = el("div", "tool__label", "Input");
          const inputPre = el("pre", "tool__io", spec.input == null ? "—" : String(spec.input));
          body.append(inputLabel, inputPre);
          details.append(summary, body);
          part.append(details);
          stack.append(part);
          toBottom(stick);
          const started = Date.now();
          return {
            result(output, state) {
              details.dataset.state = state || "done";
              meta.textContent =
                (state === "error" ? "failed" : "done") + " · " + (Date.now() - started) + " ms";
              const outLabel = el("div", "tool__label", "Result");
              const outPre = el("pre", "tool__io", output == null ? "—" : String(output));
              body.append(outLabel, outPre);
              toBottom();
            },
          };
        },

        text(delta) {
          ensureBubble();
          textNode.textContent += delta;
          toBottom();
        },

        approval(spec) {
          return new Promise((resolve) => {
            const stick = nearBottom();
            const part = el("div", "part part--approval");
            part.append(
              el("p", "approval__title", spec.title || "Needs your approval"),
              el("p", "approval__text", spec.text || "")
            );
            if (spec.impact) part.append(el("p", "approval__impact", spec.impact));
            const row = el("div", "approval__actions");
            const yes = el("button", "lg-btn lg-btn--prominent");
            yes.type = "button";
            yes.append(el("span", null, "Approve"));
            const no = el("button", "lg-btn");
            no.type = "button";
            no.append(el("span", null, "Deny"));
            row.append(yes, no);
            part.append(row);
            stack.append(part);
            toBottom(stick);

            const settle = (answer) => {
              row.remove();
              part.append(
                el(
                  "p",
                  "approval__resolved",
                  answer === "approved" ? "Approved — continuing." : "Denied — stopped."
                )
              );
              toBottom();
              resolve(answer);
            };

            yes.addEventListener("click", () => settle("approved"));
            no.addEventListener("click", () => settle("denied"));
          });
        },

        citations(items) {
          if (!items || items.length === 0) return;
          const part = el("div", "part part--cites");
          items.forEach((item) => {
            const link = el("a", "cite", item.label);
            link.href = item.href || "#";
            link.target = "_blank";
            link.rel = "noreferrer noopener";
            part.append(link);
          });
          stack.append(part);
          toBottom();
        },

        error(message, retry) {
          const part = el("div", "part part--error");
          part.append(el("p", null, message));
          if (retry) {
            const again = el("button", "lg-btn");
            again.type = "button";
            again.append(el("span", null, "Retry"));
            again.addEventListener("click", () => {
              part.remove();
              retry();
            });
            part.append(again);
          }
          stack.append(part);
          toBottom(true);
        },

        done() {
          if (finished) return;
          finished = true;
          if (cursor) cursor.remove();
          const acts = el("div", "acts");
          const copy = el("button", "act");
          copy.type = "button";
          copy.append(icon(ICON.copy), el("span", null, "Copy"));
          copy.addEventListener("click", () => {
            const text = textNode ? textNode.textContent : "";
            if (navigator.clipboard) navigator.clipboard.writeText(text).catch(() => {});
            copy.querySelector("span").textContent = "Copied";
            setTimeout(() => {
              copy.querySelector("span").textContent = "Copy";
            }, 1200);
          });
          acts.append(copy);
          if (settings.onRegenerate && lastUserText) {
            const again = el("button", "act");
            again.type = "button";
            again.append(icon(ICON.regen), el("span", null, "Regenerate"));
            again.addEventListener("click", () => settings.onRegenerate(lastUserText));
            acts.append(again);
          }
          stack.append(acts);
          toBottom();
        },
      };

      current = controller;
      return controller;
    }

    function setStreaming(on) {
      busy = on;
      if (stopBtn) stopBtn.hidden = !on;
      if (sendBtn) sendBtn.hidden = on;
      syncSend();
    }

    function grow() {
      input.style.height = "auto";
      input.style.height = Math.min(input.scrollHeight, MAX_INPUT_PX) + "px";
    }

    function syncSend() {
      if (!sendBtn) return;
      sendBtn.disabled = busy || input.value.trim().length === 0;
    }

    function syncMode() {
      if (!modeChip) return;
      modeChip.dataset.mode = mode;
      if (modeText) modeText.textContent = MODE_LABEL[mode];
      modeChip.setAttribute("aria-label", "Autonomy: " + MODE_LABEL[mode]);
      if (settings.onMode) settings.onMode(mode);
    }

    async function submit() {
      const text = input.value.trim();
      if (!text || busy) return;
      input.value = "";
      grow();
      addUser(text);
      if (settings.onSend) settings.onSend(text);
      else {
        const agent = beginAgent();
        setStreaming(true);
        await new Promise((resolve) => setTimeout(resolve, 600));
        agent.text(
          "No responder is wired up. Pass `onSend` to mount(), or replace the scripted run in sidepanel.js."
        );
        agent.done();
        setStreaming(false);
      }
    }

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      submit();
    });

    if (stopBtn) {
      stopBtn.addEventListener("click", () => {
        if (settings.onStop) settings.onStop();
        setStreaming(false);
      });
    }

    if (modeChip) {
      modeChip.addEventListener("click", () => {
        mode = MODES[(MODES.indexOf(mode) + 1) % MODES.length];
        syncMode();
      });
    }

    input.addEventListener("input", () => {
      grow();
      syncSend();
    });

    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        submit();
      }
    });

    input.addEventListener("focus", () => form.classList.add("is-focus"));
    input.addEventListener("blur", () => form.classList.remove("is-focus"));

    (settings.seed || []).forEach((message) => {
      if (message.role === "user") {
        addUser(message.text);
        return;
      }
      const agent = beginAgent();
      agent.text(message.text);
      agent.done();
    });

    if ((settings.seed || []).length === 0 && empty) empty.hidden = false;
    grow();
    syncSend();
    syncMode();
    setStreaming(false);
    toBottom(true);

    return {
      addUser,
      beginAgent,
      setStreaming,
      submit,
      setHooks(next) {
        Object.assign(settings, next || {});
      },
      focus: () => input.focus(),
      get busy() {
        return busy;
      },
      clear() {
        [...log.querySelectorAll(".msg")].forEach((node) => node.remove());
        if (empty) empty.hidden = false;
      },
    };
  }

  window.LiquidGlassChat = { mount };
})();
