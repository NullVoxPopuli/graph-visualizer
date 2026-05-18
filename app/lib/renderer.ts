/**
 * WebGL2 renderer for large graphs (10k+ nodes, 100k+ edges).
 *
 *  - Nodes: single drawArraysInstanced. Per-instance: (x, y, radius_world,
 *    r, g, b, a, flags). Vertex shader rasterizes a quad; fragment shader
 *    discards outside a circle and antialiases the edge.
 *  - Edges: single drawArrays(gl.LINES) with a pre-built vertex buffer of
 *    (x, y, r, g, b, a) per vertex. Alpha is set low for density.
 *  - Hulls: drawArrays(gl.TRIANGLES) — precomputed convex hulls
 *    triangulated as fans.
 *
 * The camera transform is supplied via uniforms (uCamera xy + uZoom +
 * uViewport). No DOM, no per-node objects on the hot path — typed arrays
 * throughout.
 */
// Camera lives on the main thread (d3-zoom binds DOM input); the
// renderer is fed camera state via `setCamera` so it can run in a worker
// against an OffscreenCanvas.

// aInstFlags is a packed bitmask so selection / hover / cycle / dim can
// compose:
//   bit 0 (1) = selected     — animated dashed halo
//   bit 1 (2) = hovered      — grow body radius
//   bit 2 (4) = cycle member — red outline
//   bit 3 (8) = dimmed       — alpha-faded with extra fade at low zoom

// Edge LOD: below this on-screen length (device px) for a representative
// edge, the edge/arrow layer is dropped (sub-pixel haze, pure fill-rate).
const EDGE_LOD_MIN_PX = 1.5;

// Fullscreen-triangle blit (samples the cached static layer). Uses
// gl_VertexID so it needs no vertex buffer — just an empty bound VAO.
const BLIT_VS = /* glsl */ `#version 300 es
precision highp float;
out vec2 vUv;
void main() {
  vec2 p = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0);
  vUv = p * 0.5 + 0.5;
  gl_Position = vec4(p, 0.0, 1.0);
}`;

const BLIT_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
out vec4 fragColor;
void main() { fragColor = texture(uTex, vUv); }`;

const NODE_VS = /* glsl */ `#version 300 es
precision highp float;
layout(location=0) in vec2 aQuad;
layout(location=1) in vec2 aInstPos;
layout(location=2) in float aInstRadius;
layout(location=3) in vec4 aInstColor;
layout(location=4) in float aInstFlags;
uniform vec2 uCamera;
uniform float uZoom;
uniform vec2 uViewport;
out vec2 vQuad;
out vec4 vColor;
out float vBodyPx;
out float vQuadPx;
out float vFlags;
out float vAlphaScale;
void main() {
  int flags = int(aInstFlags);
  bool sel = (flags & 1) != 0;
  bool hov = (flags & 2) != 0;
  bool cyc = (flags & 4) != 0;
  bool dim = (flags & 8) != 0;
  // screen-space body radius floor so tiny nodes stay clickable; must
  // match the floor used in hit testing so the visual lines up with the
  // pick.
  float bodyPx = max(4.0, aInstRadius * uZoom);
  if (hov) bodyPx *= 1.6;                       // hover: grow body
  float quadPx = bodyPx;
  if (cyc) quadPx = bodyPx * 1.25;              // cycle: room for a thin red ring
  if (sel) quadPx = bodyPx * 1.6;               // selected: bigger halo wins
  vec2 world = aInstPos + aQuad * (quadPx / uZoom);
  vec2 screen = (world - uCamera) * uZoom;
  vec2 clip = screen / (uViewport * 0.5);
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  vQuad = aQuad;
  vColor = aInstColor;
  vBodyPx = bodyPx;
  vQuadPx = quadPx;
  vFlags = aInstFlags;
  // Dim nodes fade further the more zoomed out we are — overlapping nodes
  // mask the dimming when many fit in a small area. mix from 0.06 at
  // zoom 0 up to 0.35 at zoom >= 1; non-dim nodes are fully opaque.
  vAlphaScale = dim ? mix(0.06, 0.35, clamp(uZoom, 0.0, 1.0)) : 1.0;
}`;

const NODE_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vQuad;
in vec4 vColor;
in float vBodyPx;
in float vQuadPx;
in float vFlags;
in float vAlphaScale;
uniform float uTime;
out vec4 fragColor;
const float TAU = 6.2831853;
void main() {
  int flags = int(vFlags);
  bool sel = (flags & 1) != 0;
  bool cyc = (flags & 4) != 0;
  float d = length(vQuad);
  float dPx = d * vQuadPx;
  float bodyAa = max(1.0 / vBodyPx, 0.01);
  // 1.0 at the body edge; >1 = outside body.
  float r = dPx / vBodyPx;
  float body = smoothstep(1.0, 1.0 - bodyAa, r);

  if (body > 0.01) {
    fragColor = vec4(vColor.rgb, vColor.a * vAlphaScale * body);
    return;
  }

  // Cycle membership: red ring hugging the node body.
  if (cyc) {
    float ringIn = smoothstep(1.00, 1.04, r);
    float ringOut = 1.0 - smoothstep(1.15, 1.20, r);
    float ring = ringIn * ringOut;
    if (ring > 0.01) {
      fragColor = vec4(1.0, 0.25, 0.3, ring * 0.95);
      return;
    }
  }

  // Selected: animated dashed halo (drawn farther out than the cycle ring).
  if (sel) {
    float ringIn = smoothstep(1.25, 1.30, r);
    float ringOut = 1.0 - smoothstep(1.50, 1.55, r);
    float ring = ringIn * ringOut;
    if (ring > 0.01) {
      float angle = atan(vQuad.y, vQuad.x) + uTime * 0.8;
      float dashes = 14.0;
      float phase = fract(angle / TAU * dashes);
      float dashOn = 1.0 - smoothstep(0.48, 0.52, phase);
      float a = ring * dashOn;
      if (a > 0.01) {
        fragColor = vec4(1.0, 1.0, 1.0, a * 0.9);
        return;
      }
    }
  }
  discard;
}`;

const LINE_VS = /* glsl */ `#version 300 es
precision highp float;
layout(location=0) in vec2 aPos;
layout(location=1) in vec4 aColor;
uniform vec2 uCamera;
uniform float uZoom;
uniform vec2 uViewport;
out vec4 vColor;
void main() {
  vec2 screen = (aPos - uCamera) * uZoom;
  vec2 clip = screen / (uViewport * 0.5);
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  vColor = aColor;
}`;

const LINE_FS = /* glsl */ `#version 300 es
precision highp float;
in vec4 vColor;
out vec4 fragColor;
void main() { fragColor = vColor; }`;

// Directional arrowhead at the source end of each edge — instanced
// triangles sized in device pixels so they read the same at any zoom.
// `aQuad` is one of three local-space corners along the source→target
// axis: (0, 0) = tip, (-1, 1) = base-left, (-1, -1) = base-right.
const ARROW_VS = /* glsl */ `#version 300 es
precision highp float;
layout(location=0) in vec2 aQuad;
layout(location=1) in vec2 aInstSrc;
layout(location=2) in vec2 aInstTgt;
layout(location=3) in vec4 aInstColor;
layout(location=4) in float aInstSrcRadius;
uniform vec2 uCamera;
uniform float uZoom;
uniform vec2 uViewport;
out vec4 vColor;
void main() {
  vec2 srcScreen = (aInstSrc - uCamera) * uZoom;
  vec2 tgtScreen = (aInstTgt - uCamera) * uZoom;
  vec2 d = srcScreen - tgtScreen;
  float dLen = length(d);
  vec2 dir = dLen > 0.0001 ? d / dLen : vec2(1.0, 0.0);
  vec2 perp = vec2(-dir.y, dir.x);
  // Mirror the node vertex shader's screen-px radius floor so the
  // arrow tip lines up just outside the visible body at any zoom.
  float srcRadiusPx = max(4.0, aInstSrcRadius * uZoom);
  // Tie arrow size to the node's screen-px radius so it scales with zoom
  // the same way the node does. Cap arrowLen at 1/4 of the node's
  // visible diameter (i.e. half the radius) so the arrowhead stays
  // subordinate to the node it points at. Floors keep the head readable
  // when srcRadiusPx is at its own 4px floor.
  float arrowLen = max(6.0, srcRadiusPx * 0.5);
  float halfWidth = max(3.0, srcRadiusPx * 0.25);
  float gapPx = max(1.5, srcRadiusPx * 0.12);
  vec2 tipScreen = srcScreen - dir * (srcRadiusPx + gapPx);
  vec2 cornerOffset = aQuad.x * dir * arrowLen + aQuad.y * perp * halfWidth;
  vec2 screen = tipScreen + cornerOffset;
  vec2 clip = screen / (uViewport * 0.5);
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  vColor = aInstColor;
}`;

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const s = gl.createShader(type)!;

  gl.shaderSource(s, src);
  gl.compileShader(s);

  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(s);

    gl.deleteShader(s);
    throw new Error(`Shader compile: ${info}`);
  }

  return s;
}

function link(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const p = gl.createProgram();

  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);

  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(p);

    gl.deleteProgram(p);
    throw new Error(`Program link: ${info}`);
  }

  return p;
}

export class Renderer {
  gl: WebGL2RenderingContext;
  // Camera transform, pushed in from the owner (main thread) via
  // `setCamera`. Defaults render the origin at 1× until the first push.
  private camX = 0;
  private camY = 0;
  private camZoom = 1;
  // Representative edge length in world units (median over the scene),
  // pushed from the owner. 0 = unknown → edge LOD disabled.
  private edgeLodWorldLen = 0;

  private nodeProg: WebGLProgram;
  private lineProg: WebGLProgram;
  private hullProg: WebGLProgram;
  private arrowProg: WebGLProgram;

  private nodeVao: WebGLVertexArrayObject;
  private nodeInstVbo: WebGLBuffer;
  private nodeInstCount = 0;
  private nodeInstCapacity = 0;

  private lineVao: WebGLVertexArrayObject;
  private lineVbo: WebGLBuffer;
  private lineVertexCount = 0;
  private lineCapacity = 0;

  private hullVao: WebGLVertexArrayObject;
  private hullVbo: WebGLBuffer;
  private hullVertexCount = 0;
  private hullCapacity = 0;

  /**
   * Highlight overlay for cycle edges (red). Drawn on top of the regular
   * line pass so the cycle path pops above the dimmed community edges.
   */
  private cycleVao!: WebGLVertexArrayObject;
  private cycleVbo!: WebGLBuffer;
  private cycleVertexCount = 0;
  private cycleCapacity = 0;

  /**
   * Directional arrowheads at the source end of each edge. Drawn between
   * the line pass and the node pass so they sit on top of the lines but
   * never overlap the node bodies.
   */
  private arrowVao!: WebGLVertexArrayObject;
  private arrowInstVbo!: WebGLBuffer;
  private arrowInstCount = 0;
  private arrowInstCapacity = 0;

  private showHulls = false;
  private showArrows = true;

  // Static-layer cache: hulls + edges + cycle + arrows render into an
  // offscreen texture, regenerated only when something affecting them
  // changes (camera / scene buffers / show / edge-LOD / resize). While
  // just the selection halo animates, we blit this texture and redraw
  // only the cheap node pass instead of re-rasterizing every edge
  // 60–240×/s. Nodes are never cached (halo/dim animate per frame).
  #blitProg: WebGLProgram | null = null;
  #blitVao: WebGLVertexArrayObject | null = null;
  #fbo: WebGLFramebuffer | null = null;
  #fboTex: WebGLTexture | null = null;
  #fboW = 0;
  #fboH = 0;
  #staticDirty = true;

  constructor(canvas: HTMLCanvasElement | OffscreenCanvas) {
    const gl = canvas.getContext("webgl2", {
      antialias: true,
      alpha: false,
      premultipliedAlpha: false,
    });

    if (!gl) throw new Error("WebGL2 not available in this browser.");
    this.gl = gl;

    gl.clearColor(0.043, 0.051, 0.063, 1);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    this.nodeProg = link(gl, NODE_VS, NODE_FS);
    this.lineProg = link(gl, LINE_VS, LINE_FS);
    this.hullProg = link(gl, LINE_VS, LINE_FS);
    this.arrowProg = link(gl, ARROW_VS, LINE_FS);

    // node VAO
    this.nodeVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.nodeVao);

    const quadVbo = gl.createBuffer();

    gl.bindBuffer(gl.ARRAY_BUFFER, quadVbo);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW,
    );
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.nodeInstVbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.nodeInstVbo);

    const stride = 32; // 8 floats / instance

    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, stride, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 1, gl.FLOAT, false, stride, 8);
    gl.vertexAttribDivisor(2, 1);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 4, gl.FLOAT, false, stride, 12);
    gl.vertexAttribDivisor(3, 1);
    gl.enableVertexAttribArray(4);
    gl.vertexAttribPointer(4, 1, gl.FLOAT, false, stride, 28);
    gl.vertexAttribDivisor(4, 1);

    // line VAO
    this.lineVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.lineVao);
    this.lineVbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineVbo);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 24, 8);

    // hull VAO (same layout)
    this.hullVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.hullVao);
    this.hullVbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.hullVbo);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 24, 8);

    // cycle VAO (same layout as line)
    this.cycleVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.cycleVao);
    this.cycleVbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cycleVbo);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 24, 8);

    // arrow VAO — 3 static triangle corners (per-vertex), 9 floats per
    // arrow (per-instance: src.xy, tgt.xy, rgba, srcRadius).
    this.arrowVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.arrowVao);

    const arrowQuadVbo = gl.createBuffer();

    gl.bindBuffer(gl.ARRAY_BUFFER, arrowQuadVbo);
    // tip at (0, 0); base corners along -X with ±1 in the perpendicular axis
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, -1, 1, -1, -1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.arrowInstVbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.arrowInstVbo);

    const arrowStride = 36; // 9 floats / instance

    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, arrowStride, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 2, gl.FLOAT, false, arrowStride, 8);
    gl.vertexAttribDivisor(2, 1);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 4, gl.FLOAT, false, arrowStride, 16);
    gl.vertexAttribDivisor(3, 1);
    gl.enableVertexAttribArray(4);
    gl.vertexAttribPointer(4, 1, gl.FLOAT, false, arrowStride, 32);
    gl.vertexAttribDivisor(4, 1);

    gl.bindVertexArray(null);

    this.#blitProg = link(gl, BLIT_VS, BLIT_FS);
    this.#blitVao = gl.createVertexArray()!;
  }

  /** (Re)create the static-layer FBO + texture at the current size. */
  #ensureFbo(): void {
    const gl = this.gl;
    const w = gl.canvas.width;
    const h = gl.canvas.height;

    if (this.#fbo && this.#fboW === w && this.#fboH === h) return;
    if (this.#fboTex) gl.deleteTexture(this.#fboTex);
    if (this.#fbo) gl.deleteFramebuffer(this.#fbo);

    const tex = gl.createTexture();

    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const fbo = gl.createFramebuffer();

    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    this.#fbo = fbo;
    this.#fboTex = tex;
    this.#fboW = w;
    this.#fboH = h;
    this.#staticDirty = true;
  }

  /**
   * Size the drawing buffer. CSS sizing of the DOM `<canvas>` is the
   * owner's job (and impossible on an `OffscreenCanvas`), so only touch
   * `.style` when it exists — keeps this worker-safe.
   */
  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    const gl = this.gl;
    const c = gl.canvas;

    c.width = Math.floor(cssWidth * dpr);
    c.height = Math.floor(cssHeight * dpr);

    if ("style" in c) {
      c.style.width = `${cssWidth}px`;
      c.style.height = `${cssHeight}px`;
    }

    gl.viewport(0, 0, c.width, c.height);
    this.#staticDirty = true;
  }

  /** Camera transform, pushed from the owner each change. */
  setCamera(x: number, y: number, zoom: number): void {
    this.camX = x;
    this.camY = y;
    this.camZoom = zoom;
    this.#staticDirty = true;
  }

  /** Representative edge length (world units) for the zoom LOD cull. */
  setEdgeLod(worldLen: number): void {
    this.edgeLodWorldLen = worldLen;
    this.#staticDirty = true;
  }

  setShowHulls(v: boolean): void {
    this.showHulls = v;
    this.#staticDirty = true;
  }
  setShowArrows(v: boolean): void {
    this.showArrows = v;
    this.#staticDirty = true;
  }

  /** Upload packed node instances. data length must be >= 8 * count. */
  uploadNodeInstances(data: Float32Array, count: number): void {
    const gl = this.gl;

    gl.bindVertexArray(this.nodeVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.nodeInstVbo);

    if (count > this.nodeInstCapacity) {
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
      this.nodeInstCapacity = count;
    } else {
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, data.subarray(0, 8 * count));
    }

    this.nodeInstCount = count;
    gl.bindVertexArray(null);
  }

  /** Upload edge line vertices. data length must be >= 6 * vertexCount. */
  uploadLines(data: Float32Array, vertexCount: number): void {
    const gl = this.gl;

    gl.bindVertexArray(this.lineVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineVbo);

    if (vertexCount > this.lineCapacity) {
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
      this.lineCapacity = vertexCount;
    } else {
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, data.subarray(0, 6 * vertexCount));
    }

    this.lineVertexCount = vertexCount;
    this.#staticDirty = true;
    gl.bindVertexArray(null);
  }

  uploadHulls(data: Float32Array, vertexCount: number): void {
    const gl = this.gl;

    gl.bindVertexArray(this.hullVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.hullVbo);

    if (vertexCount > this.hullCapacity) {
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
      this.hullCapacity = vertexCount;
    } else {
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, data.subarray(0, 6 * vertexCount));
    }

    this.hullVertexCount = vertexCount;
    this.#staticDirty = true;
    gl.bindVertexArray(null);
  }

  /**
   * Upload per-instance arrowhead data. `data` length must be ≥ 9 * count.
   * Layout: (srcX, srcY, tgtX, tgtY, r, g, b, a, srcRadiusWorld).
   */
  uploadArrows(data: Float32Array, count: number): void {
    const gl = this.gl;

    gl.bindVertexArray(this.arrowVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.arrowInstVbo);

    if (count > this.arrowInstCapacity) {
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
      this.arrowInstCapacity = count;
    } else if (count > 0) {
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, data.subarray(0, 9 * count));
    }

    this.arrowInstCount = count;
    this.#staticDirty = true;
    gl.bindVertexArray(null);
  }

  /** Upload cycle-highlight edge vertices. Same layout as `uploadLines`. */
  uploadCycleEdges(data: Float32Array, vertexCount: number): void {
    const gl = this.gl;

    gl.bindVertexArray(this.cycleVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cycleVbo);

    if (vertexCount > this.cycleCapacity) {
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
      this.cycleCapacity = vertexCount;
    } else if (vertexCount > 0) {
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, data.subarray(0, 6 * vertexCount));
    }

    this.cycleVertexCount = vertexCount;
    this.#staticDirty = true;
    gl.bindVertexArray(null);
  }

  private setCameraUniforms(prog: WebGLProgram): void {
    const gl = this.gl;

    gl.useProgram(prog);
    gl.uniform2f(gl.getUniformLocation(prog, "uCamera"), this.camX, this.camY);
    gl.uniform1f(gl.getUniformLocation(prog, "uZoom"), this.camZoom);
    gl.uniform2f(gl.getUniformLocation(prog, "uViewport"), gl.canvas.width, gl.canvas.height);
  }

  /** Hulls + edges (LOD-culled) + cycle + arrows — cacheable static layer. */
  #drawStatic(): void {
    const gl = this.gl;

    if (this.showHulls && this.hullVertexCount > 0) {
      this.setCameraUniforms(this.hullProg);
      gl.bindVertexArray(this.hullVao);
      gl.drawArrays(gl.TRIANGLES, 0, this.hullVertexCount);
    }

    // Edge level-of-detail: when a representative edge is shorter than
    // ~1.5 device-px on screen, the whole edge/arrow layer is a
    // sub-pixel haze that conveys nothing but is pure fill-rate. Skip
    // those passes (hulls and the cycle highlight still draw).
    const cullEdges =
      this.edgeLodWorldLen > 0 && this.edgeLodWorldLen * this.camZoom < EDGE_LOD_MIN_PX;

    if (!cullEdges && this.lineVertexCount > 0) {
      this.setCameraUniforms(this.lineProg);
      gl.bindVertexArray(this.lineVao);
      gl.drawArrays(gl.LINES, 0, this.lineVertexCount);
    }

    if (this.cycleVertexCount > 0) {
      this.setCameraUniforms(this.lineProg);
      gl.bindVertexArray(this.cycleVao);
      gl.drawArrays(gl.LINES, 0, this.cycleVertexCount);
    }

    if (!cullEdges && this.showArrows && this.arrowInstCount > 0) {
      this.setCameraUniforms(this.arrowProg);
      gl.bindVertexArray(this.arrowVao);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 3, this.arrowInstCount);
    }
  }

  draw(): void {
    const gl = this.gl;

    this.#ensureFbo();

    // Regenerate the static layer only when something affecting it
    // changed. While just the selection halo animates, this is skipped
    // and only the cheap node pass is redrawn.
    if (this.#staticDirty) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.#fbo);
      gl.viewport(0, 0, this.#fboW, this.#fboH);
      gl.clear(gl.COLOR_BUFFER_BIT);
      this.#drawStatic();
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      this.#staticDirty = false;
    }

    gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
    gl.clear(gl.COLOR_BUFFER_BIT);

    // Composite the cached static layer (opaque copy — it already holds
    // the blended edges over the background).
    gl.disable(gl.BLEND);
    gl.useProgram(this.#blitProg);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.#fboTex);
    gl.uniform1i(gl.getUniformLocation(this.#blitProg!, "uTex"), 0);
    gl.bindVertexArray(this.#blitVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.enable(gl.BLEND);

    // Nodes (incl. the per-frame animated halo / dim) on top.
    if (this.nodeInstCount > 0) {
      this.setCameraUniforms(this.nodeProg);
      gl.uniform1f(gl.getUniformLocation(this.nodeProg, "uTime"), (performance.now() % 1e6) / 1000);
      gl.bindVertexArray(this.nodeVao);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.nodeInstCount);
    }

    gl.bindVertexArray(null);
  }
}
