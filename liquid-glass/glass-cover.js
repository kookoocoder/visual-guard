(function () {
  const PROBE_W = 160;
  const BLACK = 8;
  const probe = document.createElement("canvas");
  let ctx = null;

  function measureBand(video) {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh || vw < 8) return null;

    const ph = Math.max(2, Math.round((PROBE_W * vh) / vw));
    if (probe.width !== PROBE_W || probe.height !== ph) {
      probe.width = PROBE_W;
      probe.height = ph;
      ctx = probe.getContext("2d", { willReadFrequently: true });
    }
    if (!ctx) return null;

    try {
      ctx.drawImage(video, 0, 0, PROBE_W, ph);
    } catch {
      return null;
    }

    let data;
    try {
      data = ctx.getImageData(0, 0, PROBE_W, ph).data;
    } catch {
      return null;
    }

    let edge = PROBE_W;
    while (edge > 2) {
      let blank = true;
      for (let y = 0; y < ph; y++) {
        const i = (y * PROBE_W + edge - 1) * 4;
        const lum = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
        if (lum > BLACK) {
          blank = false;
          break;
        }
      }
      if (!blank) break;
      edge--;
    }

    return edge / PROBE_W;
  }

  function coverBox(vw, vh, boxW, boxH, fraction) {
    const f = fraction > 0 && fraction <= 1 ? fraction : 1;
    const contentW = vw * f;
    const scale = Math.max(boxW / contentW, boxH / vh);
    return {
      width: vw * scale,
      height: vh * scale,
      left: boxW - contentW * scale,
      top: boxH - vh * scale,
      scale: scale,
      fraction: f,
    };
  }

  function chooseFraction(frameWidth, frameHeight, viewport, measured) {
    let fraction = 1;
    let source = "none";

    if (viewport && viewport.w && viewport.dpr) {
      const capturedCss = frameWidth / viewport.dpr;
      if (capturedCss > viewport.w * 1.02) {
        fraction = Math.max(0.25, Math.min(1, viewport.w / capturedCss));
        source = "viewport";
      }
    }

    if (measured != null && measured > 0.3 && measured < 0.995 && measured < fraction) {
      fraction = measured;
      source = "measured";
    }

    return { fraction: fraction, source: source };
  }

  window.LiquidGlassCover = {
    measureBand: measureBand,
    coverBox: coverBox,
    chooseFraction: chooseFraction,
  };
})();
