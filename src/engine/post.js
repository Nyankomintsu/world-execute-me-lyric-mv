// WebGL2 passes. Stateless: output depends only on the layer canvases, fx and the frame number.
//
//   1. mix    outgoing layer A + incoming layer B -> transition (transitions.js) -> + HUD layer
//   2. bloom  5-level blur pyramid of the mixed picture
//   3. final  camera (zoom / rotate / shake), glitch rows, mosaic, datamosh blocks, RGB split,
//             bloom, desaturate, invert, scanlines, vignette, flash, grain
//
// v4 LIGHT (all off by default: with fx.bloomAll, fx.rays, fx.streak and fx.zoomBlur at 0 every frame is as it was):
//   fx.bloomAll 0..1 + fx.bloomThreshold   what is simply BRIGHT blooms too (cream, over-exposed orange), not only
//                                          saturated colour; the threshold is a luminance, 0..1
//   fx.rays 0..n + fx.raysAt [x, y]        rays of whatever blooms, running outwards from one point (virtual px)
//   fx.streak 0..n                         a horizontal streak through whatever blooms
//   fx.zoomBlur 0..1 + fx.zoomAt [x, y]    the picture smeared along the lines through one point (a push)
// None of them is capped by safety.maxFlash: only tools/check_flash.py guards them (docs/v4/PLAN.md §9).
import { TRANSITION_GLSL } from './transitions.js';

const VS = `#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const HASH = `float h21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float inside(vec2 u) { return step(0.0, u.x) * step(u.x, 1.0) * step(0.0, u.y) * step(u.y, 1.0); }
`;

const FS_MIX = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform sampler2D uA, uB, uHud;
uniform int uType;
uniform float uK, uFrame, uAspect, uHudA;
uniform vec4 uP;
uniform vec3 uEdge;
${HASH}
vec3 A(vec2 u) { return texture(uA, u).rgb * inside(u); }
vec3 B(vec2 u) { return texture(uB, u).rgb * inside(u); }
${TRANSITION_GLSL}
void main() {
  vec3 c = transition(vUv, vec2(vUv.x, 1.0 - vUv.y), uK);
  vec4 h = texture(uHud, vUv) * uHudA;              // premultiplied HUD on top, untouched by the transition
  o = vec4(h.rgb + c * (1.0 - h.a), 1.0);
}`;

const FS_DOWN = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform sampler2D uSrc; uniform vec2 uTexel; uniform float uThreshold, uAll, uLumT; uniform vec3 uBg; uniform vec2 uSat;
void main() {
  vec3 c = (texture(uSrc, vUv + uTexel * vec2(-1.0, -1.0)).rgb + texture(uSrc, vUv + uTexel * vec2(1.0, -1.0)).rgb
          + texture(uSrc, vUv + uTexel * vec2(-1.0, 1.0)).rgb + texture(uSrc, vUv + uTexel * vec2(1.0, 1.0)).rgb) * 0.25;
  // LOCAL glow: only saturated colour feeds the bloom (uSat = knee lo / hi; hi <= lo switches this off for
  // the deeper levels). Cream text and grey surfaces stay matte; the orange spark and red errors glow.
  if (uSat.y > uSat.x) {
    float mx = max(c.r, max(c.g, c.b)), mn = min(c.r, min(c.g, c.b));
    float gate = smoothstep(uSat.x, uSat.y, (mx - mn) / max(mx, 1e-4));
    // v4, fx.bloomAll: strong light. What is bright enough blooms whatever its colour (cream, hot orange)
    if (uAll > 0.0) gate = max(gate, uAll * smoothstep(uLumT, uLumT + 0.2, dot(c, vec3(0.2126, 0.7152, 0.0722))));
    c *= gate;
  }
  // and only what is brighter than the palette background (a coloured backdrop must not fog the frame)
  o = vec4(max(c - uBg - uThreshold, 0.0), 1.0);
}`;

const FS_BLUR = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform sampler2D uSrc; uniform vec2 uDir;
void main() {
  vec3 c = texture(uSrc, vUv).rgb * 0.2270270270;
  c += (texture(uSrc, vUv + uDir * 1.3846153846).rgb + texture(uSrc, vUv - uDir * 1.3846153846).rgb) * 0.3162162162;
  c += (texture(uSrc, vUv + uDir * 3.2307692308).rgb + texture(uSrc, vUv - uDir * 3.2307692308).rgb) * 0.0702702703;
  o = vec4(c, 1.0);
}`;

const FS_COMP = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform sampler2D uBase, uB1, uB2, uB3, uB4, uB5;
uniform vec3 uTint, uFlashCol, uMoshCol;
uniform float uGlow, uFlash, uZoom, uAberr, uScan, uScanCount, uVig, uGrain, uBright, uGlitch, uFlipY, uFrame;
uniform float uRot, uSplit, uMosh, uInvert, uDesat, uAspect, uRays, uStreak, uZoomBlur;
uniform vec2 uShake, uMosaic, uRaysAt, uZoomAt;
uniform vec4 uMosaicRect;
${HASH}
void main() {
  vec2 uv = vUv;
  if (uFlipY > 0.5) uv.y = 1.0 - uv.y;            // export: first row of readPixels = top of image
  vec2 screen = uv;                                // un-transformed coords for scanlines / vignette

  // whole-frame camera: rotate + zoom about the centre, then shake
  vec2 p = (uv - 0.5) * vec2(uAspect, 1.0);
  float cr = cos(uRot), sr = sin(uRot);
  p = vec2(p.x * cr - p.y * sr, p.x * sr + p.y * cr) / uZoom;
  uv = p / vec2(uAspect, 1.0) + 0.5 + uShake;

  // glitch: a few horizontal bands slide sideways
  if (uGlitch > 0.0) {
    float gq = floor(uFrame / 6.0);                 // the tear pattern holds for 0.1 s (per-frame noise would strobe)
    float band = floor(uv.y * 28.0 + h21(vec2(gq, 3.0)) * 7.0);
    float on = step(0.72, h21(vec2(band, gq)));
    uv.x += on * (h21(vec2(band + 9.0, gq)) - 0.5) * 0.12 * uGlitch;
  }

  // mosaic: coarse cells, optionally only inside a rectangle (screen coords, y down)
  vec2 sd = vec2(uv.x, 1.0 - uv.y);
  if (uMosaic.x > 0.0 && sd.x > uMosaicRect.x && sd.x < uMosaicRect.z && sd.y > uMosaicRect.y && sd.y < uMosaicRect.w)
    uv = (floor(uv * uMosaic) + 0.5) / uMosaic;

  // datamosh: clumps of blocks smear a displaced column of the picture and lose colour depth
  float moshed = 0.0; vec2 mcell = vec2(0.0);
  if (uMosh > 0.0) {
    vec2 n = vec2(24.0, 13.5);
    mcell = floor(uv * n);
    float tq = floor(uFrame / 16.0);              // blocks re-shuffle ~4x per second, not every frame (no flicker)
    float hh = h21(mcell + tq * 0.37) * 0.55 + h21(floor(mcell / 3.0) + tq * 0.11) * 0.45;
    if (hh < uMosh * 0.7) {
      moshed = 1.0;
      vec2 dm = vec2(h21(mcell + 1.7 + tq) - 0.5, h21(mcell + 4.1 + tq) - 0.5);
      uv = vec2((mcell.x + 0.5) / n.x + dm.x * 0.2, uv.y + dm.y * 0.06);
    }
  }

  vec2 d = uv - 0.5, sp = vec2(uSplit, 0.0);       // radial aberration + horizontal RGB split
  float m = inside(uv);
  vec3 base = vec3(texture(uBase, uv + d * uAberr + sp).r, texture(uBase, uv).g, texture(uBase, uv - d * uAberr - sp).b) * m;
  if (uZoomBlur > 0.0) {                           // v4: a push. Twelve samples along the line towards uZoomAt
    base = vec3(0.0);
    for (int i = 0; i < 12; i++) {
      vec2 u = uZoomAt + (uv - uZoomAt) * (1.0 - uZoomBlur * float(i) / 11.0);
      base += texture(uBase, u).rgb * inside(u);
    }
    base /= 12.0;
  }
  vec3 bloom = texture(uB1, uv).rgb * 0.9 + texture(uB2, uv).rgb * 0.8 + texture(uB3, uv).rgb * 0.7
             + texture(uB4, uv).rgb * 0.6 + texture(uB5, uv).rgb * 0.5;
  vec3 c = base + bloom * uTint * (uGlow * 0.42) * m;
  // v4 rays and streak light what is DARK: a pixel takes them only as far as its brightest channel has room left, so a
  // flat area of orange keeps its hue instead of drifting to yellow (light added to all three channels would do that)
  if (uRays > 0.0) {                               // rays: whatever blooms between this pixel and uRaysAt lights it
    vec2 dir = uRaysAt - uv; vec3 r = vec3(0.0); float w = 1.0, ws = 0.0;
    for (int i = 1; i <= 16; i++) {
      vec2 u = uv + dir * (float(i) / 16.0) * 0.9;
      r += (texture(uB2, u).rgb + texture(uB3, u).rgb) * w; ws += w; w *= 0.9;
    }
    c += r / ws * uTint * uRays * m * clamp(1.0 - max(c.r, max(c.g, c.b)), 0.0, 1.0);
  }
  if (uStreak > 0.0) {                             // a horizontal streak through whatever blooms
    vec3 s = vec3(0.0); float ws = 0.0;
    for (int i = -8; i <= 8; i++) {
      float w = 1.0 - abs(float(i)) / 9.0;
      s += texture(uB3, uv + vec2(float(i) * 0.03, 0.0)).rgb * w; ws += w;
    }
    c += s / ws * uTint * uStreak * m * clamp(1.0 - max(c.r, max(c.g, c.b)), 0.0, 1.0);
  }

  if (moshed > 0.5) {                              // damaged blocks: fewer colour levels, and now and then a block stuck
    c = floor(c * 3.0 + 0.5) / 3.0;                //   on one palette colour. (v3 also swapped channels in some blocks:
    float pick = h21(mcell + 9.3);                 //   that turned orange into blue / violet, colours with no meaning here)
    c = pick >= 0.14 && pick < 0.4 ? uMoshCol * (0.2 + 0.6 * h21(mcell + 2.2)) : c;
  }
  c = mix(c, vec3(dot(c, vec3(0.2126, 0.7152, 0.0722))), uDesat);
  c = mix(c, 1.0 - c, uInvert);

  c *= 1.0 - uScan * (0.5 + 0.5 * cos(screen.y * uScanCount * 6.2831853));
  float v = length((screen - 0.5) * vec2(1.0, 0.82));
  c *= 1.0 - uVig * smoothstep(0.35, 0.95, v);
  c *= uBright;
  c += uFlashCol * uFlash * (0.55 + 0.45 * (1.0 - v));
  c += (h21(gl_FragCoord.xy + vec2(uFrame * 1.37, uFrame * 0.61)) - 0.5) * uGrain;
  o = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;

const LEVELS = 5;

export class Post {
  /** keepFrame: the drawing buffer survives being shown (readPixels at any later time); costs a copy per frame. */
  constructor(canvas, cfg, { keepFrame = true } = {}) {
    this.canvas = canvas;
    this.cfg = cfg;
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: keepFrame, powerPreference: 'high-performance' });
    if (!gl) throw new Error('WebGL2 is not available');
    this.gl = gl;
    // half-float bloom buffers avoid banding in the dark glow falloff
    this.hdr = !!gl.getExtension('EXT_color_buffer_float') || !!gl.getExtension('EXT_color_buffer_half_float');
    gl.getExtension('OES_texture_float_linear');
    this.pMix = this._program(FS_MIX);
    this.pDown = this._program(FS_DOWN);
    this.pBlur = this._program(FS_BLUR);
    this.pComp = this._program(FS_COMP);
    this.texA = this._texture(); this.texB = this._texture(); this.texHud = this._texture();
    // stands in for an empty HUD layer: one transparent pixel instead of a full-size upload of nothing
    this.texNone = this._texture();
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    this.levels = [];
    this.vao = gl.createVertexArray();
  }

  /** GPU description (so the exporter can verify we are not on a software rasteriser). */
  rendererInfo() {
    const gl = this.gl, ext = gl.getExtension('WEBGL_debug_renderer_info');
    return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  }

  _program(fsSrc) {
    const gl = this.gl, p = gl.createProgram();
    for (const [type, src] of [[gl.VERTEX_SHADER, VS], [gl.FRAGMENT_SHADER, fsSrc]]) {
      const s = gl.createShader(type);
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      gl.attachShader(p, s);
    }
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const u = {}, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) { const name = gl.getActiveUniform(p, i).name; u[name] = gl.getUniformLocation(p, name); }
    return { p, u };
  }

  _texture() {
    const gl = this.gl, t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  _target(w, h, hdr = this.hdr) {
    const gl = this.gl, tex = this._texture();
    if (hdr) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return { tex, fb, w, h };
  }

  resize(w, h) {
    const gl = this.gl;
    this.canvas.width = w; this.canvas.height = h;
    this.w = w; this.h = h;
    for (const t of [this.mixed, ...this.levels.flatMap((l) => [l.a, l.b])]) if (t) { gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fb); }
    this.mixed = this._target(w, h, false);       // full-res result of the mix pass
    this.levels = [];
    for (let i = 1; i <= LEVELS; i++) {
      const lw = Math.max(1, w >> i), lh = Math.max(1, h >> i);
      this.levels.push({ a: this._target(lw, lh), b: this._target(lw, lh) });
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /**
   * Leave no texture bound to any unit, so a bloom target is never still bound for sampling
   * (from the previous frame's composite) while the next frame renders into it.
   *
   * Known limit (measured, not solved): everything up to the layer canvases is bit-identical for
   * a given t, but the GPU passes below can differ by 1/255 on up to ~0.02 % of the output bytes
   * between two renders of the same frame, depending on what the GPU drew before. It appears from
   * bloom level 3 onwards and in the final composite; it is not caused by canvas rasterisation,
   * dithering, the half-float format or stale bindings (each was ruled out by test).
   */
  _unbindAll() {
    const gl = this.gl;
    for (let i = 0; i <= LEVELS; i++) { gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_2D, null); }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  _upload(tex, unit, canvas, premultiply = false) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, premultiply);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
  }

  _pass(prog, target, srcTex, uniforms) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, null);            // the previous pass's source may be this pass's target
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fb : null);
    gl.viewport(0, 0, target ? target.w : this.w, target ? target.h : this.h);
    gl.useProgram(prog.p);
    if (srcTex) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, srcTex);
      gl.uniform1i(prog.u.uSrc ?? prog.u.uBase, 0);
    }
    uniforms(gl, prog.u);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /** Bind a texture to a unit without uploading anything. */
  _bind(tex, unit) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
  }

  /**
   * @param layers  { a: canvas, b: canvas|null, hud: canvas|null }   (hud null = nothing on the overlay layer)
   * @param tr      { type, k, p[4], edge[3] } from resolveTransition()
   * @param fx      shared per-frame effect parameters
   * @param look    { tint[3], flashCol[3], moshCol[3], glow } derived from the active palette(s), 0..1
   */
  render(layers, tr, fx, look, frame, flipY) {
    const gl = this.gl, c = this.cfg, asp = this.w / this.h;
    gl.bindVertexArray(this.vao);
    gl.disable(gl.BLEND);
    gl.disable(gl.DITHER);
    this._unbindAll();
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    // each layer canvas is uploaded once: without an incoming shot, unit 1 samples the same texture as unit 0
    this._upload(this.texA, 0, layers.a);
    if (layers.b) this._upload(this.texB, 1, layers.b); else this._bind(this.texA, 1);
    if (layers.hud) this._upload(this.texHud, 2, layers.hud, true); else this._bind(this.texNone, 2);

    // 1. transition + HUD
    this._pass(this.pMix, this.mixed, this.texA, (gl, u) => {
      gl.uniform1i(u.uA, 0); gl.uniform1i(u.uB, 1); gl.uniform1i(u.uHud, 2);
      gl.uniform1i(u.uType, layers.b ? tr.type : 0);
      gl.uniform1f(u.uK, tr.k);
      gl.uniform4f(u.uP, ...tr.p);
      gl.uniform3f(u.uEdge, ...tr.edge);
      gl.uniform1f(u.uFrame, frame % 4096);
      gl.uniform1f(u.uAspect, asp);
      gl.uniform1f(u.uHudA, Math.max(0, Math.min(1, fx.hud)));
    });

    // 2. bloom pyramid: downsample -> blur H -> blur V, each level half the previous
    let src = this.mixed.tex, sw = this.w, sh = this.h;
    this.levels.forEach((l, i) => {
      this._pass(this.pDown, l.a, src, (gl, u) => {
        gl.uniform2f(u.uTexel, 1 / sw, 1 / sh);
        gl.uniform1f(u.uThreshold, i === 0 ? c.glow.threshold : 0);
        gl.uniform3f(u.uBg, ...(i === 0 ? look.bg : [0, 0, 0]));
        gl.uniform2f(u.uSat, ...(i === 0 ? c.glow.satKnee : [1, 0]));
        gl.uniform1f(u.uAll, i === 0 ? Math.max(0, Math.min(1, fx.bloomAll ?? 0)) : 0);
        gl.uniform1f(u.uLumT, fx.bloomThreshold ?? 0.35);
      });
      this._pass(this.pBlur, l.b, l.a.tex, (gl, u) => gl.uniform2f(u.uDir, c.glow.radius / l.a.w, 0));
      this._pass(this.pBlur, l.a, l.b.tex, (gl, u) => gl.uniform2f(u.uDir, 0, c.glow.radius / l.a.h));
      src = l.a.tex; sw = l.a.w; sh = l.a.h;
    });

    // 3. final composite
    this._pass(this.pComp, null, this.mixed.tex, (gl, u) => {
      this.levels.forEach((l, i) => {
        gl.activeTexture(gl.TEXTURE1 + i);
        gl.bindTexture(gl.TEXTURE_2D, l.a.tex);
        gl.uniform1i(u[`uB${i + 1}`], i + 1);
      });
      const flash = Math.min(c.safety.maxFlash, Math.max(0, fx.flash));
      const mos = fx.mosaic > 0 ? [1920 / fx.mosaic, 1080 / fx.mosaic] : [0, 0];
      const mr = fx.mosaicRect ?? [0, 0, 1920, 1080];
      gl.uniform3f(u.uTint, ...look.tint);
      gl.uniform3f(u.uFlashCol, ...look.flashCol);
      gl.uniform3f(u.uMoshCol, ...look.moshCol);
      gl.uniform1f(u.uGlow, (fx.glow + flash * c.glow.flashGain) * look.glow);
      gl.uniform1f(u.uFlash, flash * c.post.flashStrength);
      gl.uniform1f(u.uZoom, fx.zoom);
      gl.uniform1f(u.uRot, fx.rot);
      gl.uniform2f(u.uShake, fx.shake[0] / 1920, -fx.shake[1] / 1080);
      gl.uniform1f(u.uAberr, fx.aberration);
      gl.uniform1f(u.uSplit, fx.rgbSplit / 1920);
      gl.uniform1f(u.uGlitch, fx.glitch);
      gl.uniform1f(u.uMosh, fx.mosh);
      gl.uniform2f(u.uMosaic, ...mos);
      gl.uniform4f(u.uMosaicRect, mr[0] / 1920, mr[1] / 1080, (mr[0] + mr[2]) / 1920, (mr[1] + mr[3]) / 1080);
      const ra = fx.raysAt ?? [960, 540], za = fx.zoomAt ?? [960, 540];      // virtual px, y down -> uv, y up
      gl.uniform1f(u.uRays, Math.max(0, fx.rays ?? 0));
      gl.uniform2f(u.uRaysAt, ra[0] / 1920, 1 - ra[1] / 1080);
      gl.uniform1f(u.uStreak, Math.max(0, fx.streak ?? 0));
      gl.uniform1f(u.uZoomBlur, Math.max(0, Math.min(1, fx.zoomBlur ?? 0)));
      gl.uniform2f(u.uZoomAt, za[0] / 1920, 1 - za[1] / 1080);
      gl.uniform1f(u.uInvert, fx.invert);
      gl.uniform1f(u.uDesat, fx.desat);
      gl.uniform1f(u.uScan, c.post.scanlines * fx.scan);
      gl.uniform1f(u.uScanCount, c.post.scanlineCount);
      gl.uniform1f(u.uVig, c.post.vignette * fx.vignette);
      gl.uniform1f(u.uGrain, c.post.grain);
      gl.uniform1f(u.uBright, fx.bright);
      gl.uniform1f(u.uAspect, asp);
      gl.uniform1f(u.uFlipY, flipY ? 1 : 0);
      gl.uniform1f(u.uFrame, frame % 4096);
    });
    this._unbindAll();
  }

  /** Read back the final frame as tightly packed RGBA (top row first when rendered with flipY). */
  readPixels(buf) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(0, 0, this.w, this.h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    return buf;
  }
}
