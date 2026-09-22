(function () {
  function mount(root, onChange) {
    const min = Number(root.dataset.min);
    const max = Number(root.dataset.max);
    const step = Number(root.dataset.step);
    const slider = root.querySelector(".lg-slider");
    const fill = root.querySelector(".lg-slider__fill");
    const thumb = root.querySelector(".lg-slider__thumb");
    const out = root.querySelector("output");

    let dragging = false;
    let current = Number(root.dataset.value);

    function render(value) {
      const pct = max === min ? 0 : ((value - min) / (max - min)) * 100;
      slider.style.setProperty("--x", pct.toFixed(4));
      fill.style.width = pct.toFixed(4) + "%";
      out.textContent = String(value);
      root.setAttribute("aria-valuenow", String(value));
      root.setAttribute("aria-valuetext", String(value));
    }

    function snap(value) {
      const clamped = Math.min(max, Math.max(min, value));
      return Math.round(Math.min(max, Math.max(min, Math.round(clamped / step) * step)) * 1000) / 1000;
    }

    function set(value, emit) {
      current = snap(value);
      render(current);
      if (emit !== false && onChange) onChange(current);
      return current;
    }

    function valueFromX(clientX) {
      const rect = slider.getBoundingClientRect();
      const ratio = rect.width ? (clientX - rect.left) / rect.width : 0;
      return min + Math.min(1, Math.max(0, ratio)) * (max - min);
    }

    function setGlass(on) {
      thumb.classList.toggle("is-glass", on);
    }

    slider.addEventListener("pointerdown", (event) => {
      dragging = true;
      slider.setPointerCapture(event.pointerId);
      setGlass(true);
      set(valueFromX(event.clientX));
      event.preventDefault();
    });

    slider.addEventListener("pointermove", (event) => {
      if (dragging) set(valueFromX(event.clientX));
    });

    function release(event) {
      if (!dragging) return;
      dragging = false;
      if (slider.hasPointerCapture(event.pointerId)) slider.releasePointerCapture(event.pointerId);
      setGlass(false);
    }

    slider.addEventListener("pointerup", release);
    slider.addEventListener("pointercancel", release);
    slider.addEventListener("pointerenter", () => setGlass(true));
    slider.addEventListener("pointerleave", () => {
      if (!dragging) setGlass(false);
    });

    root.addEventListener("keydown", (event) => {
      const big = (max - min) / 10;
      let next = null;
      if (event.key === "ArrowRight" || event.key === "ArrowUp") next = current + step;
      else if (event.key === "ArrowLeft" || event.key === "ArrowDown") next = current - step;
      else if (event.key === "PageUp") next = current + big;
      else if (event.key === "PageDown") next = current - big;
      else if (event.key === "Home") next = min;
      else if (event.key === "End") next = max;
      if (next === null) return;
      event.preventDefault();
      setGlass(true);
      set(next);
    });

    root.addEventListener("keyup", () => setGlass(false));
    root.addEventListener("blur", () => setGlass(false));

    root.setAttribute("aria-valuemin", String(min));
    root.setAttribute("aria-valuemax", String(max));
    render(current);

    return { set, get: () => current };
  }

  window.LiquidGlassSlider = { mount: mount };
})();
