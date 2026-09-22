(function () {
  const SVG_NS = "http://www.w3.org/2000/svg";
  const IOR = 1.5168;
  const DISPERSION = [0.99516, 1.0, 1.01084];
  const BEZEL_RATIO = 0.14;
  const BEZEL_MIN = 10;
  const BEZEL_MAX = 44;
  const MAP_EDGE = 1024;
  const LUT_STEPS = 256;
  const PEAK_RATIO = 0.524;
  const ENCODE = 1 / 0.498;

  function squircle(x) {
    const c = Math.max(1e-6, 1 - x);
    return Math.pow(Math.max(0, 1 - Math.pow(c, 4)), 0.25);
  }

  function squircleSlope(x) {
    const c = Math.max(1e-6, 1 - x);
    const inner = Math.max(1e-6, 1 - Math.pow(c, 4));
    return Math.pow(c, 3) * Math.pow(inner, -0.75);
  }

  function fresnelTransmittance(thetaS) {
    const sinR = Math.sin(thetaS) / IOR;
    if (sinR >= 1) return 0;
    const thetaR = Math.asin(sinR);
    const ci = Math.cos(thetaS);
    const ct = Math.cos(thetaR);
    const rs = (ci - IOR * ct) / (ci + IOR * ct);
    const rp = (IOR * ci - ct) / (IOR * ci + ct);
    return 1 - 0.5 * (rs * rs + rp * rp);
  }

  function lateralShift(x) {
    const thetaS = Math.atan(squircleSlope(x));
    const sinR = Math.min(1, Math.sin(thetaS) / IOR);
    const thetaR = Math.asin(sinR);
    const thickness = 0.5 + squircle(x);
    return thickness * Math.tan(thetaS - thetaR) * fresnelTransmittance(thetaS);
  }

  const profile = (function () {
    const lut = new Float32Array(LUT_STEPS);
    let peak = 0;
    for (let i = 0; i < LUT_STEPS; i++) {
      const x = (i + 0.5) / LUT_STEPS;
      const value = x < 1 ? lateralShift(x) : 0;
      lut[i] = value;
      if (value > peak) peak = value;
    }
    if (peak > 0) for (let i = 0; i < LUT_STEPS; i++) lut[i] /= peak;
    return lut;
  })();

  function sample(x) {
    if (x <= 0 || x >= 1) return 0;
    return profile[Math.min(LUT_STEPS - 1, (x * LUT_STEPS) | 0)];
  }

  function bezelFor(w, h) {
    return Math.max(BEZEL_MIN, Math.min(BEZEL_MAX, Math.min(w, h) * BEZEL_RATIO));
  }

  function buildMap(w, h, radius) {
    const ratio = Math.min(1, MAP_EDGE / Math.max(w, h));
    const mw = Math.max(4, Math.round(w * ratio));
    const mh = Math.max(4, Math.round(h * ratio));
    const canvas = document.createElement("canvas");
    canvas.width = mw;
    canvas.height = mh;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const image = ctx.createImageData(mw, mh);
    const data = image.data;

    const hx = mw / 2;
    const hy = mh / 2;
    const r = Math.max(0, Math.min(radius * ratio, Math.min(hx, hy)));
    const bezel = Math.max(1.5, bezelFor(w, h) * ratio);

    function sdf(px, py) {
      const qx = Math.abs(px - hx) - hx + r;
      const qy = Math.abs(py - hy) - hy + r;
      const ax = Math.max(qx, 0);
      const ay = Math.max(qy, 0);
      return Math.min(Math.max(qx, qy), 0) + Math.sqrt(ax * ax + ay * ay) - r;
    }

    const step = 1.25;
    for (let y = 0; y < mh; y++) {
      for (let x = 0; x < mw; x++) {
        const i = (y * mw + x) * 4;
        const magnitude = sample(-sdf(x + 0.5, y + 0.5) / bezel);
        data[i + 2] = 128;
        data[i + 3] = 255;
        if (magnitude <= 0.0001) {
          data[i] = 128;
          data[i + 1] = 128;
          continue;
        }
        const gx = sdf(x + 1.75, y + 0.5) - sdf(x - 0.75, y + 0.5);
        const gy = sdf(x + 0.5, y + 1.75) - sdf(x + 0.5, y - 0.75);
        const len = Math.sqrt(gx * gx + gy * gy) || 1;
        data[i] = Math.max(0, Math.min(255, 128 - (gx / len) * magnitude * 127));
        data[i + 1] = Math.max(0, Math.min(255, 128 - (gy / len) * magnitude * 127));
      }
    }
    ctx.putImageData(image, 0, 0);
    return canvas.toDataURL("image/png");
  }

  let defs = null;
  let seq = 0;

  function ensureDefs() {
    if (defs && defs.isConnected) return defs;
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("width", "0");
    svg.setAttribute("height", "0");
    svg.setAttribute("aria-hidden", "true");
    svg.style.cssText = "position:absolute;width:0;height:0";
    const node = document.createElementNS(SVG_NS, "defs");
    svg.append(node);
    (document.body || document.documentElement).append(svg);
    defs = node;
    return defs;
  }

  function svgEl(name, attrs) {
    const node = document.createElementNS(SVG_NS, name);
    for (const key in attrs) node.setAttribute(key, attrs[key]);
    return node;
  }

  function setHref(node, value) {
    node.setAttribute("href", value);
    node.setAttributeNS("http://www.w3.org/1999/xlink", "xlink:href", value);
  }

  function dispersionPass(filter, mapId, scale, spread) {
    const keep = [
      "1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0",
      "0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0",
      "0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0",
    ];
    const results = [];
    for (let i = 0; i < 3; i++) {
      const displaced = "d" + i;
      const isolated = "i" + i;
      filter.append(
        svgEl("feDisplacementMap", {
          in: "SourceGraphic",
          in2: mapId,
          scale: String(scale * DISPERSION[i] * (1 + (spread * (i - 1)) / 100)),
          xChannelSelector: "R",
          yChannelSelector: "G",
          result: displaced,
        })
      );
      filter.append(
        svgEl("feColorMatrix", {
          in: displaced,
          type: "matrix",
          values: keep[i],
          result: isolated,
        })
      );
      results.push(isolated);
    }
    filter.append(svgEl("feBlend", { in: results[0], in2: results[1], mode: "screen", result: "rg" }));
    filter.append(svgEl("feBlend", { in: "rg", in2: results[2], mode: "screen" }));
  }

  function supportsRefraction() {
    if (typeof CSS === "undefined" || typeof navigator === "undefined") return false;
    if (!CSS.supports("backdrop-filter", "url(#x)")) return false;
    return /Chrome|Chromium|Edg\//.test(navigator.userAgent);
  }

  function refract(target, options) {
    if (!target.__lg) {
      const state = {
        ratio: 1,
        blur: 2,
        saturate: 180,
        brightness: 1.06,
        contrast: 1.04,
        chroma: 0,
        radius: null,
        frame: 0,
        id: "lg-refract-" + ++seq,
      };
      const supported = supportsRefraction();
      const filter = svgEl("filter", {
        id: state.id,
        "color-interpolation-filters": "sRGB",
        x: "0",
        y: "0",
        width: "100%",
        height: "100%",
      });
      ensureDefs().append(filter);

      const self = {};
      target.__lg = self;
      self.state = state;
      self.supported = supported;
      self.id = state.id;
      self.filter = filter;

      self.chain = function (withRefraction) {
        const parts = [
          "blur(" + state.blur + "px)",
          "saturate(" + state.saturate + "%)",
          "brightness(" + state.brightness + ")",
          "contrast(" + state.contrast + ")",
        ];
        if (withRefraction && supported && state.ratio > 0) {
          parts.push("url(#" + state.id + ")");
        }
        return parts.join(" ");
      };

      self.paint = function () {
        const base = self.chain(false);
        target.style.backdropFilter = base;
        target.style.webkitBackdropFilter = base;
        if (!supported || state.ratio <= 0) return;
        const value = self.chain(true);
        target.style.backdropFilter = value;
        target.style.webkitBackdropFilter = value;
      };

      self.rebuild = function () {
        const rect = target.getBoundingClientRect();
        const w = Math.max(8, Math.round(rect.width));
        const h = Math.max(8, Math.round(rect.height));
        const computed = parseFloat(getComputedStyle(target).borderTopLeftRadius) || 0;
        const radius = state.radius == null ? computed : state.radius;
        const bezel = bezelFor(w, h);
        const scale = ENCODE * PEAK_RATIO * bezel * state.ratio;

        while (filter.firstChild) filter.removeChild(filter.firstChild);

        const mapId = state.id + "_map";
        const image = svgEl("feImage", {
          x: "0",
          y: "0",
          width: String(w),
          height: String(h),
          preserveAspectRatio: "none",
          result: mapId,
        });
        setHref(image, buildMap(w, h, radius));
        filter.append(image);

        if (state.chroma > 0) {
          dispersionPass(filter, mapId, scale, state.chroma);
        } else {
          filter.append(
            svgEl("feDisplacementMap", {
              in: "SourceGraphic",
              in2: mapId,
              scale: String(scale),
              xChannelSelector: "R",
              yChannelSelector: "G",
            })
          );
        }
        self.paint();
      };

      self.schedule = function () {
        if (state.frame) return;
        state.frame = requestAnimationFrame(function () {
          state.frame = 0;
          self.rebuild();
        });
      };

      self.update = function (next) {
        if (!next) return;
        const needsMap =
          next.ratio !== undefined ||
          next.chroma !== undefined ||
          next.radius !== undefined;
        const needsPaint =
          needsMap ||
          next.blur !== undefined ||
          next.saturate !== undefined ||
          next.brightness !== undefined ||
          next.contrast !== undefined;
        Object.keys(next).forEach(function (key) {
          if (next[key] !== undefined) state[key] = next[key];
        });
        if (needsMap) self.schedule();
        else if (needsPaint) self.paint();
      };

      self.destroy = function () {
        if (observer) observer.disconnect();
        if (state.frame) cancelAnimationFrame(state.frame);
        if (filter.parentNode) filter.parentNode.removeChild(filter);
        target.style.backdropFilter = "";
        target.style.webkitBackdropFilter = "";
        delete target.__lg;
      };

      const observer =
        typeof ResizeObserver !== "undefined"
          ? new ResizeObserver(function () {
              self.schedule();
            })
          : null;
      if (observer) observer.observe(target);
    }

    if (options) target.__lg.update(options);
    else target.__lg.schedule();
    return target.__lg;
  }

  window.LiquidGlass = {
    refract: refract,
    supportsRefraction: supportsRefraction,
    profile: function (steps) {
      const n = steps || 16;
      const out = [];
      for (let i = 0; i < n; i++) out.push(profile[Math.min(LUT_STEPS - 1, ((i / n) * LUT_STEPS) | 0)]);
      return out;
    },
    constants: { IOR: IOR, PEAK_RATIO: PEAK_RATIO, ENCODE: ENCODE },
  };
})();
