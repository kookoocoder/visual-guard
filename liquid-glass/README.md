# Liquid Glass (Chrome side panel)

An Apple Liquid Glass side panel: ray-traced rim refraction over a **live** capture of the
tab, with every control cut from the same material.

## Files

| File | Purpose |
| --- | --- |
| `refraction.js` | The optics. Ray-traces a convex-squircle slab, bakes a displacement map, builds the SVG filter. |
| `glass.css` | Tokens and the panel material. |
| `glass-ui.css` | Component recipes: sections, buttons, pills, sliders, scrollbars. |
| `glass-chat.css` | Chat: message list, user bubbles, plain agent text, composer. |
| `glass-chat.js` | Chat behaviour: send, grouping, auto-scroll, auto-grow, typing. |
| `glass-slider.js` | Shared glass slider (pointer + keyboard). Used by the panel and the demo. |
| `sidepanel.html` / `.css` / `.js` | Panel UI, live `<video>` backdrop, crop-aware layout, capture lifecycle. |
| `background.js` | Toolbar click -> opens the panel and grants capture for that tab. |
| `manifest.json` | MV3. |
| `glass-demo.html` | Standalone optics + component preview. |

## Component recipes

The controls are built from five techniques, each taken from a working Liquid Glass
implementation rather than invented:

1. **Anisotropic bead rim.** `inset 2px -2px 1px -1px` + `inset -2px 2px 1px -1px` at
   `rgba(255,255,255,0.9)`, plus wider `6px/-6px` insets at `0.55`. This is what gives a
   control a lit convex bead instead of a flat translucent tile. Alpha has to be high —
   anything under ~0.5 stops reading as glass.
2. **Tight dark inner ring.** A blurred `1px` border (`filter: blur(6px)`) inset by ~7px
   on all sides, offset down. That dark line just inside the rim is the material's
   thickness, and it is the single biggest tell between "glass" and "tinted rectangle".
3. **45° specular.** A blurred pseudo-element carrying
   `linear-gradient(45deg, white 0%, transparent 18%, transparent 82%, white 100%)` so the
   highlights catch on two opposite edges only.
4. **Radial-gradient normal map lens.** A `radialGradient` from `rgb(128,128,255)` at the
   centre to `rgb(255,255,255)` at 85%, loaded by `feImage` and fed to `feDisplacementMap`
   with a large negative `scale`. R and G are the X and Y axes, 128 is neutral, so the
   centre is undistorted and distortion grows radially. Applied as
   `filter: url(#lg-lens)` on an element that also has `backdrop-filter`, which distorts
   the filtered backdrop. Cheap and no canvas needed, so it rides the slider thumb.
5. **Goo.** `feGaussianBlur` -> alpha `feColorMatrix` (`0 0 0 16 -7`) -> `feComposite atop`.
   Used so the slider fill and a blob that tracks the thumb merge into a liquid meniscus
   instead of butting up as two rectangles.

Two constraints shape where these can go. `filter` on an element makes it a **backdrop
root**, so anything with `filter: url(#goo)` cannot contain a `backdrop-filter` child —
that is why the goo wrapper only holds the fill and blob. And `backdrop-filter` on a
parent plus a descendant does not render in Chromium, so `.lg-surface` / `.lg-btn` /
`.lg-pill` carry the rim and tint but no filter of their own.

Also note: because `transform` creates a backdrop root, the slider thumb is positioned
with `left` + `margin-top` rather than `translate(-50%, -50%)`, so the lens can still see
the backdrop. Its size change on hover animates `width`/`height` instead of `scale` for
the same reason.

## The chat view

Two views behind a segmented glass control: **Chat** and **Controls**. The choice persists
in `chrome.storage.local`.

### Message model

Both sides now get a bubble, so the differentiator is material and alignment rather than
presence:

- **User**: right-aligned, bubble tinted with the accent, asymmetric radii
  (`20px`, trailing bottom corner `7px`).
- **Agent**: left-aligned, **neutral** bubble (no accent tint) carrying the same bead —
  crisp rim, dark inner ring, top sheen. The turn is introduced by a head row: a lit
  round mark, the agent name, and a timestamp, shown only on the first message of a group.
- **Grouping**: consecutive same-author messages tighten to `-9px`, the bubble corner
  facing the group flattens, and the head row is suppressed on continuations.

### The agentic surface

A chat that only sends text is not an agent UI. The parts model follows the AG-UI /
MUI X convention, where a turn is an ordered list of parts — **reasoning → tool →
reasoning → tool → text** — and each part renders as its own disclosure:

| Part | Renders as |
| --- | --- |
| `reasoning` | `<details>` that stays **open** while streaming with a live "Thinking…" label, then collapses to a clickable "Reasoning" |
| `tool` | Card with tool name, argument JSON, result JSON, status dot and elapsed ms. Starts `running`, ends `done` or `error` |
| `text` | The answer bubble, streaming word by word with a live cursor |
| `approval` | Gate with title, action description, an impact line, and Approve / Deny |
| `citations` | Row of glass chips linking to sources |
| `error` | Inline failure in the response slot with a **Retry** that preserves the conversation |
| actions | Hover row on each agent turn: Copy, Regenerate |

Three UX rules from the research are load-bearing here and are followed deliberately:

1. **Never hide system state.** Every phase is visible — thinking, running, awaiting
   approval, streaming, failed. The `uxpatterns.dev` guidance on AI error states is
   explicit that users must be able to tell waiting from streaming from retrying from done.
2. **Do not let AI controls compete with the response.** Message actions are hover-only
   and the reasoning/tool cards recede to `rgba(255,255,255,0.045)`.
3. **Approvals need reversibility marking.** The gate states what changes and that it is
   reversible, rather than a vague confirm. The agentic-UX framework calls click-through
   confirmations with vague language an anti-pattern.

**Autonomy is always visible and one click away.** The composer carries a mode chip that
cycles `Suggest only → Confirm each step → Execute end to end`. At `Confirm`, the scripted
run stops at an approval gate; at `Auto` it runs through; at `Suggest` it answers without
touching anything. This is per-action autonomy rather than implicit, which is the
documented failure mode.

The scripted run in `sidepanel.js` exercises every part so you can see all states without
a backend. **Stop** aborts mid-stream and still leaves a coherent message.

### Legibility over video

NN/g's critique of iOS 26 is that glass over a busy backdrop destroys text contrast, and
they are right — this panel sits on a live capture of a real page. So agent text carries
`text-shadow: 0 1px 4px rgba(0,0,0,0.5)` (light theme: a white shadow), and the panel
keeps a `Dim` slider for exactly this. If you push `Tint` to its minimum on a bright page,
raise `Dim` to buy the contrast back.

### Wiring a real backend

`makeRunner()` in `sidepanel.js` is scripted. Replace it with your transport:

```js
const runner = {
  onSend: async (text) => {
    const agent = chat.beginAgent();
    chat.setStreaming(true);
    const stream = await fetch("/api/agent", { method: "POST", body: JSON.stringify({ text }) });
    for await (const chunk of parse(stream)) {
      if (chunk.type === "reasoning-delta") reasoning.write(chunk.delta);
      if (chunk.type === "tool-input") tool = agent.tool(chunk);
      if (chunk.type === "tool-output") tool.result(chunk.output);
      if (chunk.type === "text-delta") agent.text(chunk.delta);
    }
    agent.done();
    chat.setStreaming(false);
  },
};
chat.setHooks(runner);
```

The module exposes `addUser`, `beginAgent`, `setStreaming`, `submit`, `setHooks`; the
controller returned by `beginAgent()` exposes `reasoning`, `tool`, `text`, `approval`
(returns a promise resolving `"approved"` / `"denied"`), `citations`, `error`, `done`.

Note the bubbles deliberately do **not** use `backdrop-filter` — see the constraint above.
They carry the material, and the panel does the refracting.

## Locked defaults

The shipped settings are the tuned ones: `refraction 250` (slider to 400), `blur 2`,
`tint 0.08`, `fringe 0`, `dim 0.4`. They live in the `settings` object in
`sidepanel.js` and are mirrored as `data-value` in `sidepanel.html`. Saved values win, so
changing the defaults only affects a fresh profile.

## The refraction model

The naive web model `d = f'/(1+f'²)` is `½·sin 2θ`. It peaks at a 45° slope and falls to
**zero at the rim** — a dead zone exactly where real glass bends light hardest. It is why
so much "liquid glass" looks like a soft frosted blob.

`refraction.js` traces the actual ray through a slab with a convex-squircle bezel
`f(x) = (1-(1-x)^4)^(1/4)`:

```
θs(x) = atan f'(x)                 surface tilt = angle of incidence
θr(x) = asin(sin θs / n)           Snell, n = 1.5168 (BK7 crown glass)
t(x)  = T0 + B·f(x)                slab thickness under the entry point
d(x)  = t(x)·tan(θs - θr)·(1-R)    lateral shift, Fresnel-weighted
```

`d(x)` peaks essentially at the rim and decays monotonically inward. The measured
profile, outermost to innermost:

```
0.201 0.982 0.766 0.562 0.410 0.298 0.215 0.152 0.104 0.069 0.043 0.025 0.012 0.005 0.002 0.000
```

The exact rim is dark because Fresnel reflectance goes to 1 at grazing incidence — which
is also the physical justification for the bright rim ring.

Other details that matter:

- The displacement vector is the **negated** SDF gradient (inward, toward the centre): a
  convex slab magnifies. The sign is easy to get backwards and it inverts the effect.
- `color-interpolation-filters="sRGB"` is mandatory. In linearRGB the 128-neutral drifts
  and the entire backdrop shifts.
- Encoding is R = X, G = Y, 128 = neutral. The map is normalised so its peak hits channel
  255, and `scale = 2.008 × 0.524 × bezel_px × ratio` converts back to physical pixels.
- The map is baked at the element's true size (up to 1024px), so the bezel is a constant
  px width rather than stretching with the panel.
- `feImage` hrefs are base64 data URLs; external URLs fail silently from zero-size SVGs.

**Chromium only.** Firefox and Safari ignore `url()` in `backdrop-filter` and fall back to
the blur-only chain.

## The material

Calibrated against macOS 26 Control Center rather than eyeballed. The measured transfer
curve is a single compressive line:

```
glass_L = 0.58 · backdrop_L + 34
```

So the material *lifts* blacks and *compresses* contrast — it is not a dark scrim. Every
glassmorphism tutorial reaches for `background: rgba(255,255,255,0.1)` plus
`mix-blend-mode: overlay`, which vanishes on black; a dark scrim is the same error
inverted. The tint here is a plain partially-transparent fill with no blend mode.

Tokens: `--lg-blur 2px`, `--lg-sat 180%`, `--lg-brightness 1.06`,
`--lg-contrast 1.04`, tint `rgba(34,34,38,0.62)` dark / `rgba(248,248,250,0.66)` light.
`.lg--clear` is the Apple "clear" variant for media; the default is "regular".

The specular is a measured ring, not a conic: bright hairlines top **and** bottom (bottom
brighter, the 0.18 : 0.25 asymmetry that keeps the convex read) and dark flanks left and
right. A conic spreads one highlight around all four edges, which brightens the flanks and
dims the horizontals — the opposite of the measurement.

Nested surfaces (`edge` zone) deliberately do not use `backdrop-filter`:

- Anything that makes an ancestor a backdrop root (`isolation`, `transform`, `opacity < 1`,
  `mask`, `will-change`, paint containment) leaves a nested `backdrop-filter` with nothing
  to sample, and it fails silently.
- Chromium also cannot render `backdrop-filter` on a parent and a descendant at once.

So `.lg-surface`, `.lg-btn`, `.lg-pill`, `.lg-range` and `.lg-scroll` carry the material —
tint, lit rim, dark flanks, top sheen — without a filter. Concentric radii via
`--lg-radius-inner = --lg-radius - --lg-inset`. `corner-shape: squircle` where available.

`prefers-reduced-transparency` swaps refraction for a frostier, more opaque material, the
same mapping Apple uses. `prefers-contrast: more` adds a contrasting border.

## The live backdrop, and the black band

`backdrop-filter` can only sample the element's own compositing surface, and a side panel
is a separate surface from the tab, so it can never read page pixels directly. Stills from
`captureVisibleTab` are capped at 2/sec by Chrome. The panel therefore captures the tab as
a live MediaStream:

```
chrome.tabCapture.getMediaStreamId({ targetTabId })
  -> getUserMedia({ video: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: id } } })
  -> <video srcObject> -> backdrop for the glass
```

Audio is not requested, so the tab's sound is unaffected.

### Why the capture has a black band on the right

Chromium's capture path latches its format at start. `FrameSinkVideoCaptureDevice::
AllocateCapturer()` calls `SetResolutionConstraints()` **once**, with
`VideoCaptureParams` defaulting to `FIXED_RESOLUTION`, and
`WebContentsFrameTracker::WillStartCapturingWebContents()` passes
`SuggestConstraints().max_frame_size` into a `IncrementCapturerCount()` that is documented
as "a strong suggestion to UI layout code to size the view such that its physical rendering
size matches the exact capture size". When the side panel later changes the tab's width,
the surface and the page disagree and the capturer letterboxes the difference. Hence a band
whose width matches whatever the panel was at capture time — which is why it appears on
every tab and why dragging the panel changes it.

The capture target is the tab's own render surface, **not** the browser window, so the
panel region is not literally being captured; the band is the size mismatch, not the panel
being filmed.

### The fix: measure, don't assume

Three layers, all in `glass-cover.js` so they are testable without a browser:

1. **Ask for the right size.** `readViewport()` injects a one-liner for `innerWidth` /
   `innerHeight` / `dpr`, and those become explicit `minWidth`/`maxWidth`/`minHeight`/
   `maxHeight` mandatory constraints on `getUserMedia`. If the constrained request fails,
   it retries unconstrained rather than dying.
2. **Compute the crop from the viewport ratio.** `fraction = viewport.w / (frameWidth / dpr)`.
   Skipped when the mismatch is under 2%.
3. **Measure the band from the pixels.** `measureBand()` draws the frame to a 160px canvas
   and walks columns inward from the right, stopping at the first column that is not
   entirely below luminance 8. This catches every cause, not just the one we diagnosed. It
   is right-biased on purpose — a leading band is left alone — and an all-black frame is
   rejected by the `> 0.3` guard so we never crop a genuinely dark page to nothing.

Whichever of (2) and (3) crops *more* wins, and the resolution is surfaced in the Optics
readout as `crop 78%` with the source in its tooltip.

`coverBox()` then does the fill. It is pure geometry, and the invariant is that the frame
always covers the panel:

```
scale   = max(boxW / (vw·f), boxH / vh)
left    = boxW − vw·f·scale   ≤ 0
top     = boxH − vh·scale     ≤ 0
left + width  ≥ boxW
top  + height ≥ boxH
```

There is a regression test for exactly that over nine geometry cases, because "no black
gap" is the requirement and it is easy to break with a plausible-looking optimisation.

`layout()` re-runs on `loadedmetadata`, on the track's `resize` event, on a
`ResizeObserver` over the stage, and on a 1.4s poll while capturing — the poll exists
because the latched format can drift at any time, not just on events we control.

## Following tab switches

Chrome only allows `getMediaStreamId` right after the extension is **invoked** on a tab —
the same rule as `activeTab`, and it cannot be bypassed without a user gesture. So:

- `background.js` handles `action.onClicked`: it opens the panel with
  `sidePanel.open({ tabId })` **and** re-grants capture for that tab, then tells the panel
  to re-acquire. Every toolbar click is an invocation.
- The panel listens for `tabs.onActivated` and re-acquires the new tab automatically. If
  Chrome refuses (no invocation on that tab yet), it says `needs a click` instead of going
  black, and keeps the previous frame rather than flashing empty.
- Navigating within the captured tab does not drop the stream; the panel just re-reads the
  viewport to re-crop.

If you want capture to survive tab switches with zero clicks, that is not something the
platform permits. The one-click path is the honest ceiling.

## Verify the optics without a browser

`%TEMP%\opencode\lg-test.js` is a fake-DOM harness. It asserts the profile peaks in the
outer 25% of the bezel, decays to ~0 at the inner end, normalises to 1, leaves the map
centre neutral, magnifies inward at both rims (`R>128`, `G>128`), sizes the filter to the
element, computes the calibrated `scale`, emits `sRGB`, and builds three displacement
passes for dispersion. Run `node lg-test.js`.

## Load it

`chrome://extensions` -> Developer mode -> Load unpacked -> pick this folder. Click the
toolbar icon.
