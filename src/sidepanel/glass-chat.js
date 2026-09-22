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

  function placeCursor(prose, cursor) {
    if (!cursor) return;
    let target = prose.lastElementChild;
    if (!target) {
      prose.append(cursor);
      return;
    }
    if (target.tagName === "UL" || target.tagName === "OL") target = target.lastElementChild || target;
    if (target.tagName === "PRE") {
      (target.querySelector("code") || target).append(cursor);
      return;
    }
    target.append(cursor);
  }

  function appendInline(parent, text) {
    const pattern =
      /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(__[^_\n]+__)|(\*[^*\n]+\*)|(_[^_\n]+_)|(\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\))/g;
    let last = 0;
    let match = pattern.exec(text);
    while (match) {
      if (match.index > last) parent.append(document.createTextNode(text.slice(last, match.index)));
      if (match[1]) {
        parent.append(el("code", "prose__code", match[1].slice(1, -1)));
      } else if (match[2] || match[3]) {
        const token = match[2] || match[3];
        parent.append(el("strong", null, token.slice(2, -2)));
      } else if (match[4] || match[5]) {
        const token = match[4] || match[5];
        parent.append(el("em", null, token.slice(1, -1)));
      } else if (match[6]) {
        const link = el("a", "prose__link", match[7]);
        link.href = match[8];
        link.target = "_blank";
        link.rel = "noreferrer noopener";
        parent.append(link);
      }
      last = match.index + match[0].length;
      match = pattern.exec(text);
    }
    if (last < text.length) parent.append(document.createTextNode(text.slice(last)));
  }

  function isTableSeparator(line) {
    return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
  }

  function isTableRow(line) {
    return /^\s*\|.+\|\s*$/.test(line) && !isTableSeparator(line);
  }

  function tableCells(line) {
    return line
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((cell) => cell.trim());
  }

  function renderProse(root, source) {
    const lines = String(source ?? "").replace(/\r\n/g, "\n").split("\n");
    const nodes = [];
    let index = 0;

    while (index < lines.length) {
      const line = lines[index];
      if (!line.trim()) {
        index += 1;
        continue;
      }

      const fence = /^```([\w-]*)\s*$/.exec(line);
      if (fence) {
        const code = [];
        index += 1;
        while (index < lines.length && !/^```\s*$/.test(lines[index])) {
          code.push(lines[index]);
          index += 1;
        }
        if (index < lines.length) index += 1;
        const pre = el("pre", "prose__pre");
        pre.append(el("code", null, code.join("\n")));
        nodes.push(pre);
        continue;
      }

      if (/^#{1,3}\s+/.test(line)) {
        const heading = el("h3", "prose__h");
        appendInline(heading, line.replace(/^#{1,3}\s+/, ""));
        nodes.push(heading);
        index += 1;
        continue;
      }

      if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
        nodes.push(el("hr", "prose__rule"));
        index += 1;
        continue;
      }

      if (/^>\s?/.test(line)) {
        const quote = [];
        while (index < lines.length && /^>\s?/.test(lines[index])) {
          quote.push(lines[index].replace(/^>\s?/, ""));
          index += 1;
        }
        const block = el("blockquote", "prose__quote");
        appendInline(block, quote.join(" "));
        nodes.push(block);
        continue;
      }

      if (isTableRow(line) && lines.slice(index, index + 8).some(isTableSeparator)) {
        const rows = [];
        while (index < lines.length && (isTableRow(lines[index]) || isTableSeparator(lines[index]))) {
          if (!isTableSeparator(lines[index])) rows.push(tableCells(lines[index]));
          index += 1;
        }
        const wrap = el("div", "prose__table-wrap");
        const table = el("table", "prose__table");
        const head = el("thead");
        const body = el("tbody");
        rows.forEach((row, rowIndex) => {
          const tr = el("tr");
          row.forEach((cell) => {
            const cellNode = el(rowIndex === 0 ? "th" : "td");
            appendInline(cellNode, cell);
            tr.append(cellNode);
          });
          (rowIndex === 0 ? head : body).append(tr);
        });
        if (head.childNodes.length) table.append(head);
        if (body.childNodes.length) table.append(body);
        wrap.append(table);
        nodes.push(wrap);
        continue;
      }

      if (/^\s*[-*+]\s+/.test(line)) {
        const list = el("ul", "prose__list");
        while (index < lines.length && /^\s*[-*+]\s+/.test(lines[index])) {
          const item = el("li");
          appendInline(item, lines[index].replace(/^\s*[-*+]\s+/, ""));
          list.append(item);
          index += 1;
        }
        nodes.push(list);
        continue;
      }

      if (/^\s*\d+[.)]\s+/.test(line)) {
        const list = el("ol", "prose__list");
        while (index < lines.length && /^\s*\d+[.)]\s+/.test(lines[index])) {
          const item = el("li");
          appendInline(item, lines[index].replace(/^\s*\d+[.)]\s+/, ""));
          list.append(item);
          index += 1;
        }
        nodes.push(list);
        continue;
      }

      const paragraph = [line.trim()];
      index += 1;
      while (
        index < lines.length &&
        lines[index].trim() &&
        !/^```/.test(lines[index]) &&
        !/^#{1,3}\s+/.test(lines[index]) &&
        !/^>\s?/.test(lines[index]) &&
        !/^\s*[-*+]\s+/.test(lines[index]) &&
        !/^\s*\d+[.)]\s+/.test(lines[index]) &&
        !isTableRow(lines[index]) &&
        !/^\s*([-*_])\1{2,}\s*$/.test(lines[index])
      ) {
        paragraph.push(lines[index].trim());
        index += 1;
      }
      const block = el("p", "prose__p");
      appendInline(block, paragraph.join(" "));
      nodes.push(block);
    }

    root.replaceChildren(...nodes);
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

    const jump = el("button", "chat__jump");
    jump.type = "button";
    jump.append(el("span", null, "Latest"));
    jump.hidden = true;
    log.after(jump);

    let pinned = true;
    let scrolling = false;
    let holding = false;
    let userMoved = false;
    let frame = 0;

    function gap() {
      return log.scrollHeight - log.scrollTop - log.clientHeight;
    }

    function nearBottom() {
      if (log.clientHeight > 0 && gap() <= NEAR_BOTTOM) pinned = true;
      return pinned;
    }

    function placeJump() {
      jump.style.bottom = form.offsetHeight + 10 + "px";
    }

    function syncJump() {
      const overflow = log.clientHeight > 0 && log.scrollHeight > log.clientHeight + 8;
      jump.hidden = pinned || !overflow;
    }

    function toBottom(force) {
      if (force) pinned = true;
      if (!pinned || (holding && !force)) {
        syncJump();
        return;
      }
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (!pinned) {
          syncJump();
          return;
        }
        scrolling = true;
        log.scrollTop = log.scrollHeight;
        requestAnimationFrame(() => {
          if (pinned) log.scrollTop = log.scrollHeight;
          requestAnimationFrame(() => {
            scrolling = false;
            syncJump();
          });
        });
      });
    }

    jump.addEventListener("click", () => toBottom(true));

    log.addEventListener("scroll", () => {
      if (scrolling || !userMoved) return;
      userMoved = false;
      pinned = log.clientHeight <= 0 || gap() <= NEAR_BOTTOM;
      syncJump();
    }, { passive: true });

    log.addEventListener("wheel", (event) => {
      userMoved = true;
      if (event.deltaY < 0) {
        pinned = false;
        syncJump();
      }
    }, { passive: true });

    let pointerY = 0;
    let dragged = false;

    log.addEventListener("pointerdown", (event) => {
      holding = true;
      dragged = false;
      pointerY = event.clientY;
    });

    log.addEventListener("pointermove", (event) => {
      if (!holding || Math.abs(event.clientY - pointerY) <= 8) return;
      dragged = true;
      userMoved = true;
      pinned = false;
      syncJump();
    });

    function releasePointer() {
      if (!holding) return;
      holding = false;
      if (dragged) {
        pinned = log.clientHeight <= 0 || gap() <= NEAR_BOTTOM;
        userMoved = false;
      }
      if (pinned) toBottom();
      else syncJump();
    }

    log.addEventListener("pointerup", releasePointer);
    log.addEventListener("pointercancel", releasePointer);

    log.addEventListener("keydown", (event) => {
      if (event.key === "ArrowUp" || event.key === "PageUp" || event.key === "Home") {
        userMoved = true;
        pinned = false;
        syncJump();
      }
      if (event.key === "ArrowDown" || event.key === "PageDown" || event.key === "End") {
        userMoved = true;
        requestAnimationFrame(() => {
          pinned = event.key === "End" || gap() <= NEAR_BOTTOM;
          userMoved = false;
          if (pinned) toBottom(event.key === "End");
          else syncJump();
        });
      }
    });

    if (typeof ResizeObserver !== "undefined") {
      new ResizeObserver(() => {
        placeJump();
        if (pinned && !holding) toBottom();
      }).observe(log);
      new ResizeObserver(() => {
        placeJump();
        if (pinned && !holding) toBottom();
      }).observe(form);
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
      if (empty) empty.hidden = true;
      lastUserText = text;

      const msg = el("div", "msg msg--user");
      msg.append(el("div", "msg__bubble", text));
      log.append(msg);
      reflag();
      toBottom(true);
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
      let prose = null;
      let raw = "";
      let cursor = null;
      let reasoningBody = null;
      let reasoningRaw = "";
      let reasoningLabel = null;
      let finished = false;

      function ensureBubble() {
        if (bubble) return;
        bubble = el("div", "msg__bubble");
        prose = el("div", "prose");
        cursor = el("span", "cursor");
        bubble.append(prose, cursor);
        stack.append(bubble);
      }

      function paintAnswer() {
        ensureBubble();
        renderProse(prose, raw);
        if (!finished) placeCursor(prose, cursor);
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
          reasoningBody = el("div", "thinking__body prose");
          reasoningRaw = initial || "";
          if (reasoningRaw) renderProse(reasoningBody, reasoningRaw);
          details.append(summary, reasoningBody);
          part.append(details);
          stack.append(part);
          toBottom();
          return {
            write(delta) {
              reasoningRaw += delta;
              renderProse(reasoningBody, reasoningRaw);
              toBottom();
            },
            end() {
              if (!reasoningRaw.trim()) {
                part.remove();
                toBottom();
                return;
              }
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
          raw += delta;
          paintAnswer();
          toBottom();
        },

        approval(spec) {
          return new Promise((resolve) => {
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
            toBottom(true);

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
            const text = prose ? prose.innerText : raw;
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
      placeJump();
      if (pinned && !holding) toBottom();
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
    placeJump();
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
        pinned = true;
        syncJump();
      },
    };
  }

  window.LiquidGlassChat = { mount };
})();
