/**
 * WebGL2 renderer for large graphs (10k+ nodes, 100k+ edges).
 *
 *  - Nodes: single drawArraysInstanced. Per-instance: (x, y, radius_world,
 *    r, g, b, a, flags). Vertex shader rasterizes a quad; fragment shader
 *    discards outside a circle and antialiases the edge.
 *  - Edges: single drawArrays(gl.LINES) with a pre-built vertex buffer of
 *    (x, y, rgba) per vertex. Alpha is set low for density.
 *  - Hulls: drawArrays(gl.TRIANGLES) — precomputed convex hulls
 *    triangulated as fans.
 *
 * The camera transform is supplied via uniforms (uCamera xy + uZoom +
 * uViewport). No DOM, no per-node objects on the hot path — typed arrays
 * throughout.
 *
 * Camera lives on the main thread (d3-zoom binds DOM input).
 * The renderer is fed camera state via `setCamera`,
 * so it can run in a worker against an OffscreenCanvas.
 */
import { STRIDE } from "#lib/render-protocol";

/**
 * aInstFlags is a packed bitmask so cycle / dim can compose:
 *
 * - bit 2 (4) = cycle member: red outline
 * - bit 3 (8) = dimmed: alpha-faded with extra fade at low zoom
 *
 * Selection and hover are not instance data.
 * They draw as overlays of one instance, chosen by `uOverlay`.
 */
const OVERLAY_NONE = 0;
/** Animated dashed halo. */
const OVERLAY_SELECTED = 1;
/** Grow the body radius. */
const OVERLAY_HOVERED = 2;

/**
 * Edge LOD: below this on-screen length (device px) for a representative
 * edge, the edge/arrow layer is dropped (sub-pixel haze, pure fill-rate).
 */
const EDGE_LOD_MIN_PX = 1.5;

/**
 * Extra border of the cached layers, as a fraction of the shorter canvas
 * side. A pan inside the border reuses the layers.
 */
const PAN_MARGIN_FRACTION = 0.2;

const BACKGROUND = [0.043, 0.051, 0.063] as const;

/**
 * Fullscreen-triangle blit of a cached layer, shifted by `uOffset` texels.
 * Uses gl_VertexID, so it needs no vertex buffer, only an empty bound VAO.
 */
const BLIT_VS = /* glsl */ `#version 300 es
precision highp float;
void main() {
  vec2 p = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0);
  gl_Position = vec4(p, 0.0, 1.0);
}`;

const BLIT_FS = /* glsl */ `#version 300 es
precision highp float;
uniform highp sampler2D uTex;
uniform ivec2 uOffset;
out vec4 fragColor;
void main() { fragColor = texelFetch(uTex, ivec2(gl_FragCoord.xy) + uOffset, 0); }`;

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
uniform int uOverlay;
out vec2 vQuad;
out vec4 vColor;
out float vBasePx;
out float vBodyPx;
out float vQuadPx;
out float vFlags;
out float vAlphaScale;
void main() {
  int flags = int(aInstFlags);
  bool cyc = (flags & 4) != 0;
  bool dim = (flags & 8) != 0;
  // screen-space body radius floor so tiny nodes stay clickable; must
  // match the floor used in hit testing so the visual lines up with the
  // pick.
  float basePx = max(4.0, aInstRadius * uZoom);
  float bodyPx = basePx;
  if (uOverlay == ${OVERLAY_HOVERED}) bodyPx *= 1.6;           // hover: grow body
  float quadPx = bodyPx;
  if (cyc) quadPx = bodyPx * 1.25;              // cycle: room for a thin red ring
  if (uOverlay == ${OVERLAY_SELECTED}) quadPx = bodyPx * 1.6;  // selected: bigger halo wins
  vec2 world = aInstPos + aQuad * (quadPx / uZoom);
  vec2 screen = (world - uCamera) * uZoom;
  vec2 clip = screen / (uViewport * 0.5);
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  vQuad = aQuad;
  vColor = aInstColor;
  vBasePx = basePx;
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
precision highp int;
in vec2 vQuad;
in vec4 vColor;
in float vBasePx;
in float vBodyPx;
in float vQuadPx;
in float vFlags;
in float vAlphaScale;
uniform int uOverlay;
uniform float uTime;
out vec4 fragColor;
const float TAU = 6.2831853;
// 1.0 inside a body of radius bodyPx, 0.0 outside, antialiased between.
float coverage(float dPx, float bodyPx) {
  return smoothstep(1.0, 1.0 - max(1.0 / bodyPx, 0.01), dPx / bodyPx);
}
void main() {
  int flags = int(vFlags);
  bool cyc = (flags & 4) != 0;
  float d = length(vQuad);
  float dPx = d * vQuadPx;
  // 1.0 at the body edge; >1 = outside body.
  float r = dPx / vBodyPx;

  // Selected: animated dashed halo (drawn farther out than the cycle ring).
  if (uOverlay == ${OVERLAY_SELECTED}) {
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
    discard;
  }

  float body = coverage(dPx, vBodyPx);

  if (body > 0.01) {
    float alpha = vColor.a * vAlphaScale * body;
    if (uOverlay == ${OVERLAY_HOVERED}) {
      // The node layer holds the body at its normal size.
      // This alpha blends the grown body over it to the same color
      // that one grown body gives.
      float under = vColor.a * vAlphaScale * coverage(dPx, vBasePx);
      alpha = (alpha - under) / max(1.0 - under, 0.0001);
    }
    fragColor = vec4(vColor.rgb, alpha);
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

interface Program<K extends string> {
  prog: WebGLProgram;
  /** Uniform locations, looked up one time after the link. */
  u: Record<K, WebGLUniformLocation | null>;
}

type CameraUniform = "uCamera" | "uZoom" | "uViewport";

function link<K extends string>(
  gl: WebGL2RenderingContext,
  vs: string,
  fs: string,
  uniforms: readonly K[],
): Program<K> {
  const prog = gl.createProgram();

  gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(prog);

  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(prog);

    gl.deleteProgram(prog);
    throw new Error(`Program link: ${info}`);
  }

  const u = {} as Record<K, WebGLUniformLocation | null>;

  for (const name of uniforms) u[name] = gl.getUniformLocation(prog, name);

  return { prog, u };
}

/** An offscreen color texture that caches a part of the scene. */
interface Layer {
  fbo: WebGLFramebuffer;
  tex: WebGLTexture;
  /** True if the content must render again at the cached camera. */
  dirty: boolean;
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

  private nodeProg: Program<CameraUniform | "uOverlay" | "uTime">;
  /** Lines, cycle lines and hulls: a position and a color per vertex. */
  private lineProg: Program<CameraUniform>;
  private arrowProg: Program<CameraUniform>;
  private blitProg: Program<"uTex" | "uOffset">;

  private nodeVao: WebGLVertexArrayObject;
  /** Same layout as `nodeVao`, pointed at one instance for an overlay. */
  private overlayVao: WebGLVertexArrayObject;
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
  private cycleVao: WebGLVertexArrayObject;
  private cycleVbo: WebGLBuffer;
  private cycleVertexCount = 0;
  private cycleCapacity = 0;

  /**
   * Directional arrowheads at the source end of each edge. Drawn between
   * the line pass and the node pass so they sit on top of the lines but
   * never overlap the node bodies.
   */
  private arrowVao: WebGLVertexArrayObject;
  private arrowInstVbo: WebGLBuffer;
  private arrowInstCount = 0;
  private arrowInstCapacity = 0;

  private showHulls = false;
  private showArrows = true;

  private selected = -1;
  private hovered = -1;

  /**
   * Cached layers.
   * A frame is two blits plus the overlays, unless a layer must render again.
   *
   * - edge layer: hulls + edges + cycle + arrows, over the background
   * - node layer: node bodies and cycle rings, over transparent
   *
   * A layer renders again when its buffers change. A node upload leaves
   * the edge layer as it is, and the other way around.
   *
   * Both layers are larger than the canvas by `#layerMargin` on each
   * side. A pan at the same zoom shifts the blits, until the pan leaves
   * the border that the last render filled (`#cacheMargin`).
   *
   * The hover growth and the selection halo are overlays on top of the blits,
   * so they never invalidate a layer.
   */
  #edgeLayer: Layer | null = null;
  #nodeLayer: Layer | null = null;
  #layerW = 0;
  #layerH = 0;
  #layerMargin = 0;
  #cacheX = 0;
  #cacheY = 0;
  #cacheZoom = NaN;
  #cacheMargin = 0;
  #blitVao: WebGLVertexArrayObject;

  constructor(canvas: HTMLCanvasElement | OffscreenCanvas) {
    /**
     * No MSAA: the scene renders into textures, and the node shader
     * smooths its own edges.
     */
    const gl = canvas.getContext("webgl2", {
      antialias: false,
      alpha: false,
      premultipliedAlpha: false,
    });

    if (!gl) throw new Error("WebGL2 not available in this browser.");
    this.gl = gl;

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    this.nodeProg = link(gl, NODE_VS, NODE_FS, [
      "uCamera",
      "uZoom",
      "uViewport",
      "uOverlay",
      "uTime",
    ]);
    this.lineProg = link(gl, LINE_VS, LINE_FS, ["uCamera", "uZoom", "uViewport"]);
    this.arrowProg = link(gl, ARROW_VS, LINE_FS, ["uCamera", "uZoom", "uViewport"]);
    this.blitProg = link(gl, BLIT_VS, BLIT_FS, ["uTex", "uOffset"]);

    gl.useProgram(this.blitProg.prog);
    gl.uniform1i(this.blitProg.u.uTex, 0);

    const quadVbo = gl.createBuffer();

    gl.bindBuffer(gl.ARRAY_BUFFER, quadVbo);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW,
    );
    this.nodeInstVbo = gl.createBuffer();
    this.nodeVao = this.#nodeVao(quadVbo);
    this.overlayVao = this.#nodeVao(quadVbo);

    this.lineVbo = gl.createBuffer();
    this.lineVao = this.#lineVao(this.lineVbo);
    this.hullVbo = gl.createBuffer();
    this.hullVao = this.#lineVao(this.hullVbo);
    this.cycleVbo = gl.createBuffer();
    this.cycleVao = this.#lineVao(this.cycleVbo);

    // arrow VAO: 3 static triangle corners (per-vertex),
    // 6 slots per arrow (per-instance: src.xy, tgt.xy, srcRadius, rgba).
    this.arrowVao = gl.createVertexArray();
    gl.bindVertexArray(this.arrowVao);

    const arrowQuadVbo = gl.createBuffer();

    gl.bindBuffer(gl.ARRAY_BUFFER, arrowQuadVbo);
    // tip at (0, 0); base corners along -X with ±1 in the perpendicular axis
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, -1, 1, -1, -1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.arrowInstVbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.arrowInstVbo);

    const arrowStride = STRIDE.arrows * 4;

    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, arrowStride, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 2, gl.FLOAT, false, arrowStride, 8);
    gl.vertexAttribDivisor(2, 1);
    gl.enableVertexAttribArray(4);
    gl.vertexAttribPointer(4, 1, gl.FLOAT, false, arrowStride, 16);
    gl.vertexAttribDivisor(4, 1);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 4, gl.UNSIGNED_BYTE, true, arrowStride, 20);
    gl.vertexAttribDivisor(3, 1);

    gl.bindVertexArray(null);

    this.#blitVao = gl.createVertexArray();
  }

  /** A VAO of instanced node quads over `nodeInstVbo`. */
  #nodeVao(quadVbo: WebGLBuffer): WebGLVertexArrayObject {
    const gl = this.gl;
    const vao = gl.createVertexArray();

    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, quadVbo);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.nodeInstVbo);

    for (let location = 1; location <= 4; location++) {
      gl.enableVertexAttribArray(location);
      gl.vertexAttribDivisor(location, 1);
    }

    this.#pointNodeAttribs(0);

    return vao;
  }

  /**
   * Point the instance attributes of the bound node VAO at the instance
   * that starts at `offset` bytes. `nodeInstVbo` must be bound.
   */
  #pointNodeAttribs(offset: number): void {
    const gl = this.gl;
    const stride = STRIDE.nodes * 4;

    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, stride, offset);
    gl.vertexAttribPointer(2, 1, gl.FLOAT, false, stride, offset + 8);
    gl.vertexAttribPointer(3, 4, gl.FLOAT, false, stride, offset + 12);
    gl.vertexAttribPointer(4, 1, gl.FLOAT, false, stride, offset + 28);
  }

  /** A VAO of `(x, y, rgba)` vertices: lines, cycle lines and hulls. */
  #lineVao(vbo: WebGLBuffer): WebGLVertexArrayObject {
    const gl = this.gl;
    const vao = gl.createVertexArray();
    const stride = STRIDE.lines * 4;

    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.UNSIGNED_BYTE, true, stride, 8);

    return vao;
  }

  #createLayer(width: number, height: number): Layer {
    const gl = this.gl;
    const tex = gl.createTexture();

    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const fbo = gl.createFramebuffer();

    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    return { fbo, tex, dirty: true };
  }

  /** (Re)create the cached layers at the current canvas size. */
  #ensureLayers(): void {
    const gl = this.gl;
    const w = gl.canvas.width;
    const h = gl.canvas.height;
    const room = Math.floor((gl.getParameter(gl.MAX_TEXTURE_SIZE) - Math.max(w, h)) / 2);
    const margin = Math.max(0, Math.min(Math.round(Math.min(w, h) * PAN_MARGIN_FRACTION), room));
    const layerW = w + 2 * margin;
    const layerH = h + 2 * margin;

    if (this.#edgeLayer && this.#layerW === layerW && this.#layerH === layerH) return;

    for (const layer of [this.#edgeLayer, this.#nodeLayer]) {
      if (!layer) continue;
      gl.deleteTexture(layer.tex);
      gl.deleteFramebuffer(layer.fbo);
    }

    this.#edgeLayer = this.#createLayer(layerW, layerH);
    this.#nodeLayer = this.#createLayer(layerW, layerH);
    this.#layerW = layerW;
    this.#layerH = layerH;
    this.#layerMargin = margin;
    this.#cacheZoom = NaN;
  }

  /**
   * Size the drawing buffer. CSS sizing of the DOM `<canvas>` is the
   * owner's job (and impossible on an `OffscreenCanvas`), so only touch
   * `.style` when it exists — keeps this worker-safe.
   */
  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    const c = this.gl.canvas;

    c.width = Math.floor(cssWidth * dpr);
    c.height = Math.floor(cssHeight * dpr);

    if ("style" in c) {
      c.style.width = `${cssWidth}px`;
      c.style.height = `${cssHeight}px`;
    }

    this.#cacheZoom = NaN;
  }

  /** Camera transform, pushed from the owner each change. */
  setCamera(x: number, y: number, zoom: number): void {
    this.camX = x;
    this.camY = y;
    this.camZoom = zoom;
  }

  #edgesChanged(): void {
    if (this.#edgeLayer) this.#edgeLayer.dirty = true;
  }

  /** Representative edge length (world units) for the zoom LOD cull. */
  setEdgeLod(worldLen: number): void {
    this.edgeLodWorldLen = worldLen;
    this.#edgesChanged();
  }

  setShowHulls(v: boolean): void {
    this.showHulls = v;
    this.#edgesChanged();
  }
  setShowArrows(v: boolean): void {
    this.showArrows = v;
    this.#edgesChanged();
  }

  /**
   * Node indices of the selected node and the hovered node, or -1.
   * Both draw as overlays,
   * so a change costs no upload and no render of a layer.
   */
  setHighlight(selected: number, hovered: number): void {
    this.selected = selected;
    this.hovered = hovered;
  }

  /** True while a frame differs from the last one with no new input. */
  get animating(): boolean {
    return this.selected >= 0;
  }

  /**
   * Fill `vbo` with the first `length` slots of `data`.
   * Returns the new capacity in slots.
   */
  #fill(vbo: WebGLBuffer, data: Float32Array, length: number, capacity: number): number {
    const gl = this.gl;
    const used = data.subarray(0, length);

    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);

    if (length > capacity) {
      gl.bufferData(gl.ARRAY_BUFFER, used, gl.DYNAMIC_DRAW);

      return length;
    }

    if (length > 0) gl.bufferSubData(gl.ARRAY_BUFFER, 0, used);

    return capacity;
  }

  /** Upload packed node instances. data length must be >= 8 * count. */
  uploadNodeInstances(data: Float32Array, count: number): void {
    this.nodeInstCapacity = this.#fill(
      this.nodeInstVbo,
      data,
      count * STRIDE.nodes,
      this.nodeInstCapacity,
    );
    this.nodeInstCount = count;
    if (this.#nodeLayer) this.#nodeLayer.dirty = true;
  }

  /** Upload edge line vertices. data length must be >= 3 * vertexCount. */
  uploadLines(data: Float32Array, vertexCount: number): void {
    if (vertexCount === 0 && this.lineVertexCount === 0) return;

    this.lineCapacity = this.#fill(
      this.lineVbo,
      data,
      vertexCount * STRIDE.lines,
      this.lineCapacity,
    );
    this.lineVertexCount = vertexCount;
    this.#edgesChanged();
  }

  uploadHulls(data: Float32Array, vertexCount: number): void {
    if (vertexCount === 0 && this.hullVertexCount === 0) return;

    this.hullCapacity = this.#fill(
      this.hullVbo,
      data,
      vertexCount * STRIDE.hulls,
      this.hullCapacity,
    );
    this.hullVertexCount = vertexCount;
    this.#edgesChanged();
  }

  /**
   * Upload per-instance arrowhead data. `data` length must be ≥ 6 * count.
   * Layout: (srcX, srcY, tgtX, tgtY, srcRadiusWorld, rgba).
   */
  uploadArrows(data: Float32Array, count: number): void {
    if (count === 0 && this.arrowInstCount === 0) return;

    this.arrowInstCapacity = this.#fill(
      this.arrowInstVbo,
      data,
      count * STRIDE.arrows,
      this.arrowInstCapacity,
    );
    this.arrowInstCount = count;
    this.#edgesChanged();
  }

  /** Upload cycle-highlight edge vertices. Same layout as `uploadLines`. */
  uploadCycleEdges(data: Float32Array, vertexCount: number): void {
    if (vertexCount === 0 && this.cycleVertexCount === 0) return;

    this.cycleCapacity = this.#fill(
      this.cycleVbo,
      data,
      vertexCount * STRIDE.cycle,
      this.cycleCapacity,
    );
    this.cycleVertexCount = vertexCount;
    this.#edgesChanged();
  }

  #use(p: Program<CameraUniform>, camX: number, camY: number, viewW: number, viewH: number): void {
    const gl = this.gl;

    gl.useProgram(p.prog);
    gl.uniform2f(p.u.uCamera, camX, camY);
    gl.uniform1f(p.u.uZoom, this.camZoom);
    gl.uniform2f(p.u.uViewport, viewW, viewH);
  }

  /** Hulls + edges (LOD-culled) + cycle + arrows. */
  #drawEdgeLayer(viewW: number, viewH: number): void {
    const gl = this.gl;
    const x = this.#cacheX;
    const y = this.#cacheY;

    this.#use(this.lineProg, x, y, viewW, viewH);

    if (this.showHulls && this.hullVertexCount > 0) {
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
      gl.bindVertexArray(this.lineVao);
      gl.drawArrays(gl.LINES, 0, this.lineVertexCount);
    }

    if (this.cycleVertexCount > 0) {
      gl.bindVertexArray(this.cycleVao);
      gl.drawArrays(gl.LINES, 0, this.cycleVertexCount);
    }

    if (!cullEdges && this.showArrows && this.arrowInstCount > 0) {
      this.#use(this.arrowProg, x, y, viewW, viewH);
      gl.bindVertexArray(this.arrowVao);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 3, this.arrowInstCount);
    }
  }

  /** Node bodies and cycle rings. */
  #drawNodeLayer(viewW: number, viewH: number): void {
    const gl = this.gl;

    if (this.nodeInstCount === 0) return;

    this.#use(this.nodeProg, this.#cacheX, this.#cacheY, viewW, viewH);
    gl.uniform1i(this.nodeProg.u.uOverlay, OVERLAY_NONE);
    gl.bindVertexArray(this.nodeVao);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.nodeInstCount);
  }

  /** Clear `layer` to `alpha` and render its content at the cached camera. */
  #renderLayer(layer: Layer, alpha: number, content: (viewW: number, viewH: number) => void): void {
    const gl = this.gl;
    const viewW = gl.canvas.width + 2 * this.#cacheMargin;
    const viewH = gl.canvas.height + 2 * this.#cacheMargin;
    const inset = this.#layerMargin - this.#cacheMargin;

    gl.bindFramebuffer(gl.FRAMEBUFFER, layer.fbo);
    gl.viewport(0, 0, this.#layerW, this.#layerH);
    gl.clearColor(BACKGROUND[0] * alpha, BACKGROUND[1] * alpha, BACKGROUND[2] * alpha, alpha);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.viewport(inset, inset, viewW, viewH);
    content(viewW, viewH);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    layer.dirty = false;
  }

  /** Draw one node on top of the layers, as the given overlay. */
  #drawOverlay(node: number, overlay: number): void {
    const gl = this.gl;

    this.#pointNodeAttribs(node * STRIDE.nodes * 4);
    gl.uniform1i(this.nodeProg.u.uOverlay, overlay);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, 1);
  }

  draw(): void {
    const gl = this.gl;
    const w = gl.canvas.width;
    const h = gl.canvas.height;

    if (w === 0 || h === 0) return;

    this.#ensureLayers();

    const edges = this.#edgeLayer!;
    const nodes = this.#nodeLayer!;

    /**
     * Pan since the last render of the layers, in whole device px.
     * Whole px keep the blits sharp.
     */
    let dx = Math.round((this.camX - this.#cacheX) * this.camZoom);
    let dy = Math.round((this.camY - this.#cacheY) * this.camZoom);
    const sameZoom = this.camZoom === this.#cacheZoom;

    if (!sameZoom || Math.abs(dx) > this.#cacheMargin || Math.abs(dy) > this.#cacheMargin) {
      /**
       * A zoom gesture changes the zoom on each frame, and no frame can
       * reuse the border. Render the visible part only.
       */
      this.#cacheMargin = sameZoom ? this.#layerMargin : 0;
      this.#cacheX = this.camX;
      this.#cacheY = this.camY;
      this.#cacheZoom = this.camZoom;
      edges.dirty = true;
      nodes.dirty = true;
      dx = 0;
      dy = 0;
    }

    if (edges.dirty) {
      this.#renderLayer(edges, 1, (viewW, viewH) => this.#drawEdgeLayer(viewW, viewH));
    }

    if (nodes.dirty) {
      /** Keep the color premultiplied and the alpha as coverage. */
      gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      this.#renderLayer(nodes, 0, (viewW, viewH) => this.#drawNodeLayer(viewW, viewH));
    }

    gl.viewport(0, 0, w, h);
    gl.useProgram(this.blitProg.prog);
    gl.uniform2i(this.blitProg.u.uOffset, this.#layerMargin + dx, this.#layerMargin - dy);
    gl.bindVertexArray(this.#blitVao);
    gl.activeTexture(gl.TEXTURE0);

    /** Opaque copy. The edge layer holds the background and covers the canvas. */
    gl.disable(gl.BLEND);
    gl.bindTexture(gl.TEXTURE_2D, edges.tex);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.enable(gl.BLEND);

    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindTexture(gl.TEXTURE_2D, nodes.tex);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    const selected = this.selected < this.nodeInstCount ? this.selected : -1;
    const hovered = this.hovered < this.nodeInstCount ? this.hovered : -1;

    if (selected >= 0 || hovered >= 0) {
      /** The camera that the blits show, so the overlays line up with them. */
      const x = this.#cacheX + dx / this.camZoom;
      const y = this.#cacheY + dy / this.camZoom;

      this.#use(this.nodeProg, x, y, w, h);
      gl.bindVertexArray(this.overlayVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.nodeInstVbo);

      /** Selection wins over hover on the same node. */
      if (hovered >= 0 && hovered !== selected) this.#drawOverlay(hovered, OVERLAY_HOVERED);

      if (selected >= 0) {
        gl.uniform1f(this.nodeProg.u.uTime, (performance.now() % 1e6) / 1000);
        this.#drawOverlay(selected, OVERLAY_SELECTED);
      }
    }

    gl.bindVertexArray(null);
  }
}
