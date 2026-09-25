/**
 * The shader language's helpers, in GLSL ES 3.00 and WGSL, for the web
 * emitters in `web.ts`.
 *
 * A THIRD AND FOURTH COPY of what `SLCommon.cginc`, `Noise2D.cginc` and
 * `SDF2D.cginc` compute for the VM and the HLSL backend, translated by hand.
 * Nothing in a browser can compile HLSL, so the copies are the price of
 * compiling there at all, and what keeps them honest is the parity harness
 * (`Tools/sl-web-parity` in the container): every entry here is rendered
 * compiled and through the VM, on both web backends, and must agree within
 * 1/255. A translation that is plausible and wrong fails there, not in a game.
 *
 * Translation rules, applied everywhere below:
 *   - HLSL `mul(v, float2x2(a, b, c, d))` is written out as
 *     `(v.x * a + v.y * c, v.x * b + v.y * d)`: the row vector convention,
 *     spelled so neither language's matrix layout can get it backwards.
 *   - HLSL `fmod` truncates and GLSL `mod` floors. The shader language's `%`
 *     is `fmod`, which `web.ts` writes inline as `a - b * trunc(a / b)`.
 *     `glslMod` in SDF2D.cginc IS the floored one: GLSL `mod` already is, and
 *     `sd_util` defines it for WGSL.
 *   - WGSL has no overloading, no swizzle assignment, no ternary and immutable
 *     parameters: `name1..name4` for widths, whole vector rebuilds, `select`,
 *     and a `var` copy of any parameter the HLSL reassigns.
 *
 * Entries are in dependency order, so emitting the needed ones in list order
 * always defines a function before its first use.
 */

export interface LibEntry {
    name: string
    deps: string[]
    glsl: string
    wgsl: string
}

/** SDF shape id to the entry name and how its parameters map onto `a` and `b`. */
export interface SdfCall {
    fn: string
    /**
     * Each argument after `p`: indices into [a.x, a.y, a.z, a.w, b.x, b.y], or
     * `{ int: i }` for an integer parameter. The shader language always passes
     * `b` as zero; the slots exist because the dispatcher it mirrors has them.
     */
    args: Array<number[] | { int: number }>
}

export const SDF_CALLS: SdfCall[] = [
    { fn: "sdCircle", args: [[0]] },
    { fn: "sdRoundedBox", args: [[0, 1], [2, 3, 4, 5]] },
    { fn: "sdBox", args: [[0, 1]] },
    { fn: "sdOrientedBox", args: [[0, 1], [2, 3], [4]] },
    { fn: "sdSegment", args: [[0, 1], [2, 3]] },
    { fn: "sdRhombus", args: [[0, 1]] },
    { fn: "sdTrapezoid", args: [[0], [1], [2]] },
    { fn: "sdParallelogram", args: [[0], [1], [2]] },
    { fn: "sdEquilateralTriangle", args: [[0]] },
    { fn: "sdTriangleIsosceles", args: [[0, 1]] },
    { fn: "sdTriangle", args: [[0, 1], [2, 3], [4, 5]] },
    { fn: "sdUnevenCapsule", args: [[0], [1], [2]] },
    { fn: "sdPentagon", args: [[0]] },
    { fn: "sdHexagon", args: [[0]] },
    { fn: "sdOctogon", args: [[0]] },
    { fn: "sdHexagram", args: [[0]] },
    { fn: "sdStar5", args: [[0], [1]] },
    { fn: "sdStar", args: [[0], { int: 1 }, [2]] },
    { fn: "sdPie", args: [[0, 1], [2]] },
    { fn: "sdCutDisk", args: [[0], [1]] },
    { fn: "sdArc", args: [[0, 1], [2], [3]] },
    { fn: "sdRing", args: [[0, 1], [2], [3]] },
    { fn: "sdHorseshoe", args: [[0, 1], [2], [3, 4]] },
    { fn: "sdVesica", args: [[0], [1]] },
    { fn: "sdOrientedVesica", args: [[0, 1], [2, 3], [4]] },
    { fn: "sdMoon", args: [[0], [1], [2]] },
    { fn: "sdRoundedCross", args: [[0]] },
    { fn: "sdEgg", args: [[0], [1], [2], [3]] },
    { fn: "sdHeart", args: [] },
    { fn: "sdCross", args: [[0, 1], [2]] },
    { fn: "sdRoundedX", args: [[0], [1]] },
    { fn: "sdEllipse", args: [[0, 1]] },
    { fn: "sdParabola", args: [[0]] },
    { fn: "sdParabolaSegment", args: [[0], [1]] },
    { fn: "sdBezier", args: [[0, 1], [2, 3], [4, 5]] },
    { fn: "sdBlobbyCross", args: [[0]] },
    { fn: "sdTunnel", args: [[0, 1]] },
    { fn: "sdStairs", args: [[0, 1], [2]] },
    { fn: "sdQuadraticCircle", args: [] },
    { fn: "sdHyberbola", args: [[0], [1]] },
    { fn: "sdCoolS", args: [] },
    { fn: "sdCircleWave", args: [[0], [1]] },
]

const e = (name: string, deps: string[], glsl: string, wgsl: string): LibEntry => ({ name, deps, glsl, wgsl })

export const WEB_LIB: LibEntry[] = [
    // ---------------------------------------------------------------- colour
    e("sl_toLinear1", [], `
float sl_toLinear1(float c) {
    if (sl_Opt.x < 0.5) return c;
    if (c <= 0.04045) return c / 12.92;
    if (c < 1.0) return pow((c + 0.055) / 1.055, 2.4);
    return pow(c, 2.2);
}`, `
fn sl_toLinear1(c: f32) -> f32 {
    if (sl.opt.x < 0.5) { return c; }
    if (c <= 0.04045) { return c / 12.92; }
    if (c < 1.0) { return pow((c + 0.055) / 1.055, 2.4); }
    return pow(c, 2.2);
}`),
    e("sl_toLinear2", ["sl_toLinear1"], `
vec2 sl_toLinear2(vec2 c) { return vec2(sl_toLinear1(c.x), sl_toLinear1(c.y)); }`, `
fn sl_toLinear2(c: vec2f) -> vec2f { return vec2f(sl_toLinear1(c.x), sl_toLinear1(c.y)); }`),
    e("sl_toLinear3", [], `
vec3 sl_toLinear3(vec3 c) {
    if (sl_Opt.x < 0.5) return c;
    return c * (c * (c * 0.305306011 + 0.682171111) + 0.012522878);
}`, `
fn sl_toLinear3(c: vec3f) -> vec3f {
    if (sl.opt.x < 0.5) { return c; }
    return c * (c * (c * 0.305306011 + 0.682171111) + 0.012522878);
}`),
    e("sl_toLinear4", ["sl_toLinear3"], `
vec4 sl_toLinear4(vec4 c) { return vec4(sl_toLinear3(c.rgb), c.a); }`, `
fn sl_toLinear4(c: vec4f) -> vec4f { return vec4f(sl_toLinear3(c.rgb), c.a); }`),
    e("sl_hsv2rgb", [], `
vec3 sl_hsv2rgb(vec3 c) {
    vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
    vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
    return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}`, `
fn sl_hsv2rgb(c: vec3f) -> vec3f {
    let K = vec4f(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
    let p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
    return c.z * mix(K.xxx, saturate(p - K.xxx), vec3f(c.y));
}`),

    // HLSL smoothstep is the formula, whatever the edge order. GLSL leaves
    // edge0 >= edge1 undefined, so the formula is written out in both.
    ...[1, 2, 3, 4].map((w) => {
        const g = w === 1 ? "float" : `vec${w}`
        const t = w === 1 ? "f32" : `vec${w}f`
        return e(`sl_smoothstep${w}`, [], `
${g} sl_smoothstep${w}(${g} a, ${g} b, ${g} x) {
    ${g} t = clamp((x - a) / (b - a), 0.0, 1.0);
    return t * t * (3.0 - 2.0 * t);
}`, `
fn sl_smoothstep${w}(a: ${t}, b: ${t}, x: ${t}) -> ${t} {
    let t = saturate((x - a) / (b - a));
    return t * t * (3.0 - 2.0 * t);
}`)
    }),

    // ----------------------------------------------------------------- noise
    e("oj_hash21", [], `
float oj_hash21(vec2 p, float seed) {
    p = fract(p * vec2(123.34, 456.21) + seed * 0.1731);
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
}`, `
fn oj_hash21(pIn: vec2f, seed: f32) -> f32 {
    var p = fract(pIn * vec2f(123.34, 456.21) + seed * 0.1731);
    p = p + dot(p, p + 45.32);
    return fract(p.x * p.y);
}`),
    e("oj_vnoise", ["oj_hash21"], `
float oj_vnoise(vec2 p, float seed) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = oj_hash21(i, seed);
    float b = oj_hash21(i + vec2(1.0, 0.0), seed);
    float c = oj_hash21(i + vec2(0.0, 1.0), seed);
    float d = oj_hash21(i + vec2(1.0, 1.0), seed);
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}`, `
fn oj_vnoise(p: vec2f, seed: f32) -> f32 {
    let i = floor(p);
    var f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    let a = oj_hash21(i, seed);
    let b = oj_hash21(i + vec2f(1.0, 0.0), seed);
    let c = oj_hash21(i + vec2f(0.0, 1.0), seed);
    let d = oj_hash21(i + vec2f(1.0, 1.0), seed);
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}`),
    e("oj_simplexRaw", [], `
vec2 oj_mod289_2(vec2 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec3 oj_mod289_3(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec3 oj_permute(vec3 x) { return oj_mod289_3(((x * 34.0) + 1.0) * x); }
float oj_simplexRaw(vec2 v) {
    const vec4 C = vec4(0.211324865405187, 0.366025403784439, -0.577350269189626, 0.024390243902439);
    vec2 i = floor(v + dot(v, C.yy));
    vec2 x0 = v - i + dot(i, C.xx);
    vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
    vec4 x12 = x0.xyxy + C.xxzz;
    x12.xy -= i1;
    i = oj_mod289_2(i);
    vec3 p = oj_permute(oj_permute(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
    vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), 0.0);
    m = m * m; m = m * m;
    vec3 x = 2.0 * fract(p * C.www) - 1.0;
    vec3 h = abs(x) - 0.5;
    vec3 ox = floor(x + 0.5);
    vec3 a0 = x - ox;
    m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
    vec3 g;
    g.x = a0.x * x0.x + h.x * x0.y;
    g.yz = a0.yz * x12.xz + h.yz * x12.yw;
    return 130.0 * dot(m, g);
}`, `
fn oj_mod289_2(x: vec2f) -> vec2f { return x - floor(x * (1.0 / 289.0)) * 289.0; }
fn oj_mod289_3(x: vec3f) -> vec3f { return x - floor(x * (1.0 / 289.0)) * 289.0; }
fn oj_permute(x: vec3f) -> vec3f { return oj_mod289_3(((x * 34.0) + 1.0) * x); }
fn oj_simplexRaw(v: vec2f) -> f32 {
    let C = vec4f(0.211324865405187, 0.366025403784439, -0.577350269189626, 0.024390243902439);
    var i = floor(v + dot(v, C.yy));
    let x0 = v - i + dot(i, C.xx);
    let i1 = select(vec2f(0.0, 1.0), vec2f(1.0, 0.0), x0.x > x0.y);
    var x12 = x0.xyxy + C.xxzz;
    x12 = vec4f(x12.xy - i1, x12.zw);
    i = oj_mod289_2(i);
    let p = oj_permute(oj_permute(i.y + vec3f(0.0, i1.y, 1.0)) + i.x + vec3f(0.0, i1.x, 1.0));
    var m = max(0.5 - vec3f(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), vec3f(0.0));
    m = m * m; m = m * m;
    let x = 2.0 * fract(p * C.www) - 1.0;
    let h = abs(x) - 0.5;
    let ox = floor(x + 0.5);
    let a0 = x - ox;
    m = m * (1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h));
    let g = vec3f(a0.x * x0.x + h.x * x0.y, a0.yz * x12.xz + h.yz * x12.yw);
    return 130.0 * dot(m, g);
}`),
    e("oj_simplex", ["oj_simplexRaw"], `
float oj_simplex(vec2 p, float seed) { return oj_simplexRaw(p + seed * 137.13) * 0.5 + 0.5; }`, `
fn oj_simplex(p: vec2f, seed: f32) -> f32 { return oj_simplexRaw(p + seed * 137.13) * 0.5 + 0.5; }`),

    // The four octave kinds. Octaves arrive as a constant 1..4 from the
    // program; the loop is bounded at 4 exactly as Noise2D.cginc's is.
    ...([
        ["oj_fbm", "oj_vnoise", "oj_vnoise(p, seed + float(o) * 19.0)", "oj_vnoise(p, seed + f32(o) * 19.0)"],
        ["oj_fbmSimplex", "oj_simplex", "oj_simplex(p, seed + float(o) * 19.0)", "oj_simplex(p, seed + f32(o) * 19.0)"],
        ["oj_turbulence", "oj_simplexRaw", "abs(oj_simplexRaw(p + (seed + float(o) * 19.0) * 137.13))",
            "abs(oj_simplexRaw(p + (seed + f32(o) * 19.0) * 137.13))"],
    ] as const).map(([name, dep, g, w]) => e(name, [dep], `
float ${name}(vec2 p, float seed, int octaves) {
    float sum = 0.0, amp = 0.5, norm = 0.0;
    for (int o = 0; o < 4; o++) {
        if (o >= octaves) break;
        sum += ${g} * amp;
        norm += amp;
        p *= 2.0;
        amp *= 0.5;
    }
    return sum / max(norm, 1e-4);
}`, `
fn ${name}(pIn: vec2f, seed: f32, octaves: i32) -> f32 {
    var p = pIn;
    var sum = 0.0;
    var amp = 0.5;
    var norm = 0.0;
    for (var o = 0; o < 4; o++) {
        if (o >= octaves) { break; }
        sum += ${w} * amp;
        norm += amp;
        p = p * 2.0;
        amp *= 0.5;
    }
    return sum / max(norm, 1e-4);
}`)),
    e("oj_ridged", ["oj_simplexRaw"], `
float oj_ridged(vec2 p, float seed, int octaves) {
    float sum = 0.0, amp = 0.5, norm = 0.0;
    for (int o = 0; o < 4; o++) {
        if (o >= octaves) break;
        float r = 1.0 - abs(oj_simplexRaw(p + (seed + float(o) * 19.0) * 137.13));
        sum += r * r * amp;
        norm += amp;
        p *= 2.0;
        amp *= 0.5;
    }
    return sum / max(norm, 1e-4);
}`, `
fn oj_ridged(pIn: vec2f, seed: f32, octaves: i32) -> f32 {
    var p = pIn;
    var sum = 0.0;
    var amp = 0.5;
    var norm = 0.0;
    for (var o = 0; o < 4; o++) {
        if (o >= octaves) { break; }
        let r = 1.0 - abs(oj_simplexRaw(p + (seed + f32(o) * 19.0) * 137.13));
        sum += r * r * amp;
        norm += amp;
        p = p * 2.0;
        amp *= 0.5;
    }
    return sum / max(norm, 1e-4);
}`),
    e("sl_voronoi", [], `
float sl_hash21(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
}
float sl_voronoi(vec2 p) {
    vec2 cell = floor(p);
    vec2 f = fract(p);
    float best = 8.0;
    for (int y = -1; y <= 1; y++) {
        for (int x = -1; x <= 1; x++) {
            vec2 o = vec2(float(x), float(y));
            vec2 jitter = vec2(sl_hash21(cell + o), sl_hash21(cell + o + 37.7));
            best = min(best, length(o + jitter - f));
        }
    }
    return best;
}`, `
fn sl_hash21(pIn: vec2f) -> f32 {
    var p = fract(pIn * vec2f(123.34, 456.21));
    p = p + dot(p, p + 45.32);
    return fract(p.x * p.y);
}
fn sl_voronoi(p: vec2f) -> f32 {
    let cell = floor(p);
    let f = fract(p);
    var best = 8.0;
    for (var y = -1; y <= 1; y++) {
        for (var x = -1; x <= 1; x++) {
            let o = vec2f(f32(x), f32(y));
            let jitter = vec2f(sl_hash21(cell + o), sl_hash21(cell + o + 37.7));
            best = min(best, length(o + jitter - f));
        }
    }
    return best;
}`),

    // ------------------------------------------------------------------- sdf
    e("sd_util", [], `
float ndot(vec2 a, vec2 b) { return a.x * b.x - a.y * b.y; }
float dot2(vec2 v) { return dot(v, v); }`, `
fn ndot(a: vec2f, b: vec2f) -> f32 { return a.x * b.x - a.y * b.y; }
fn dot2(v: vec2f) -> f32 { return dot(v, v); }
fn glslMod(x: f32, y: f32) -> f32 { return x - y * floor(x / y); }`),

    e("sdCircle", [], `
float sdCircle(vec2 p, float r) { return length(p) - r; }`, `
fn sdCircle(p: vec2f, r: f32) -> f32 { return length(p) - r; }`),

    e("sdRoundedBox", [], `
float sdRoundedBox(vec2 p, vec2 b, vec4 r) {
    r.xy = (p.x > 0.0) ? r.xy : r.zw;
    r.x = (p.y > 0.0) ? r.x : r.y;
    vec2 q = abs(p) - b + r.x;
    return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r.x;
}`, `
fn sdRoundedBox(p: vec2f, b: vec2f, rIn: vec4f) -> f32 {
    var r = rIn;
    if (!(p.x > 0.0)) { r = vec4f(r.zw, r.zw); }
    r.x = select(r.y, r.x, p.y > 0.0);
    let q = abs(p) - b + r.x;
    return min(max(q.x, q.y), 0.0) + length(max(q, vec2f(0.0))) - r.x;
}`),

    e("sdBox", [], `
float sdBox(vec2 p, vec2 b) {
    vec2 d = abs(p) - b;
    return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
}`, `
fn sdBox(p: vec2f, b: vec2f) -> f32 {
    let d = abs(p) - b;
    return length(max(d, vec2f(0.0))) + min(max(d.x, d.y), 0.0);
}`),

    e("sdOrientedBox", [], `
float sdOrientedBox(vec2 p, vec2 a, vec2 b, float th) {
    float l = length(b - a);
    vec2 d = (b - a) / l;
    vec2 q = (p - (a + b) * 0.5);
    q = vec2(q.x * d.x + q.y * d.y, -q.x * d.y + q.y * d.x);
    q = abs(q) - vec2(l, th) * 0.5;
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
}`, `
fn sdOrientedBox(p: vec2f, a: vec2f, b: vec2f, th: f32) -> f32 {
    let l = length(b - a);
    let d = (b - a) / l;
    var q = (p - (a + b) * 0.5);
    q = vec2f(q.x * d.x + q.y * d.y, -q.x * d.y + q.y * d.x);
    q = abs(q) - vec2f(l, th) * 0.5;
    return length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0);
}`),

    e("sdSegment", [], `
float sdSegment(vec2 p, vec2 a, vec2 b) {
    vec2 pa = p - a, ba = b - a;
    float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
    return length(pa - ba * h);
}`, `
fn sdSegment(p: vec2f, a: vec2f, b: vec2f) -> f32 {
    let pa = p - a;
    let ba = b - a;
    let h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
    return length(pa - ba * h);
}`),

    e("sdRhombus", ["sd_util"], `
float sdRhombus(vec2 p, vec2 b) {
    p = abs(p);
    float h = clamp(ndot(b - 2.0 * p, b) / dot(b, b), -1.0, 1.0);
    float d = length(p - 0.5 * b * vec2(1.0 - h, 1.0 + h));
    return d * sign(p.x * b.y + p.y * b.x - b.x * b.y);
}`, `
fn sdRhombus(pIn: vec2f, b: vec2f) -> f32 {
    let p = abs(pIn);
    let h = clamp(ndot(b - 2.0 * p, b) / dot(b, b), -1.0, 1.0);
    let d = length(p - 0.5 * b * vec2f(1.0 - h, 1.0 + h));
    return d * sign(p.x * b.y + p.y * b.x - b.x * b.y);
}`),

    e("sdTrapezoid", ["sd_util"], `
float sdTrapezoid(vec2 p, float r1, float r2, float he) {
    vec2 k1 = vec2(r2, he);
    vec2 k2 = vec2(r2 - r1, 2.0 * he);
    p.x = abs(p.x);
    vec2 ca = vec2(p.x - min(p.x, (p.y < 0.0) ? r1 : r2), abs(p.y) - he);
    vec2 cb = p - k1 + k2 * clamp(dot(k1 - p, k2) / dot2(k2), 0.0, 1.0);
    float s = (cb.x < 0.0 && ca.y < 0.0) ? -1.0 : 1.0;
    return s * sqrt(min(dot2(ca), dot2(cb)));
}`, `
fn sdTrapezoid(pIn: vec2f, r1: f32, r2: f32, he: f32) -> f32 {
    let k1 = vec2f(r2, he);
    let k2 = vec2f(r2 - r1, 2.0 * he);
    var p = pIn;
    p.x = abs(p.x);
    let ca = vec2f(p.x - min(p.x, select(r2, r1, p.y < 0.0)), abs(p.y) - he);
    let cb = p - k1 + k2 * clamp(dot(k1 - p, k2) / dot2(k2), 0.0, 1.0);
    let s = select(1.0, -1.0, cb.x < 0.0 && ca.y < 0.0);
    return s * sqrt(min(dot2(ca), dot2(cb)));
}`),

    e("sdParallelogram", [], `
float sdParallelogram(vec2 p, float wi, float he, float sk) {
    vec2 e = vec2(sk, he);
    p = (p.y < 0.0) ? -p : p;
    vec2 w = p - e;
    w.x -= clamp(w.x, -wi, wi);
    vec2 d = vec2(dot(w, w), -w.y);
    float s = p.x * e.y - p.y * e.x;
    p = (s < 0.0) ? -p : p;
    vec2 v = p - vec2(wi, 0.0);
    v -= e * clamp(dot(v, e) / dot(e, e), -1.0, 1.0);
    d = min(d, vec2(dot(v, v), wi * he - abs(s)));
    return sqrt(d.x) * sign(-d.y);
}`, `
fn sdParallelogram(pIn: vec2f, wi: f32, he: f32, sk: f32) -> f32 {
    let e = vec2f(sk, he);
    var p = select(pIn, -pIn, pIn.y < 0.0);
    var w = p - e;
    w.x -= clamp(w.x, -wi, wi);
    var d = vec2f(dot(w, w), -w.y);
    let s = p.x * e.y - p.y * e.x;
    p = select(p, -p, s < 0.0);
    var v = p - vec2f(wi, 0.0);
    v = v - e * clamp(dot(v, e) / dot(e, e), -1.0, 1.0);
    d = min(d, vec2f(dot(v, v), wi * he - abs(s)));
    return sqrt(d.x) * sign(-d.y);
}`),

    e("sdEquilateralTriangle", [], `
float sdEquilateralTriangle(vec2 p, float r) {
    const float k = sqrt(3.0);
    p.x = abs(p.x) - r;
    p.y = p.y + r / k;
    if (p.x + k * p.y > 0.0) p = vec2(p.x - k * p.y, -k * p.x - p.y) / 2.0;
    p.x -= clamp(p.x, -2.0 * r, 0.0);
    return -length(p) * sign(p.y);
}`, `
fn sdEquilateralTriangle(pIn: vec2f, r: f32) -> f32 {
    let k = sqrt(3.0);
    var p = pIn;
    p.x = abs(p.x) - r;
    p.y = p.y + r / k;
    if (p.x + k * p.y > 0.0) { p = vec2f(p.x - k * p.y, -k * p.x - p.y) / 2.0; }
    p.x -= clamp(p.x, -2.0 * r, 0.0);
    return -length(p) * sign(p.y);
}`),

    e("sdTriangleIsosceles", [], `
float sdTriangleIsosceles(vec2 p, vec2 q) {
    p.x = abs(p.x);
    vec2 a = p - q * clamp(dot(p, q) / dot(q, q), 0.0, 1.0);
    vec2 b = p - q * vec2(clamp(p.x / q.x, 0.0, 1.0), 1.0);
    float s = -sign(q.y);
    vec2 d = min(vec2(dot(a, a), s * (p.x * q.y - p.y * q.x)), vec2(dot(b, b), s * (p.y - q.y)));
    return -sqrt(d.x) * sign(d.y);
}`, `
fn sdTriangleIsosceles(pIn: vec2f, q: vec2f) -> f32 {
    var p = pIn;
    p.x = abs(p.x);
    let a = p - q * clamp(dot(p, q) / dot(q, q), 0.0, 1.0);
    let b = p - q * vec2f(clamp(p.x / q.x, 0.0, 1.0), 1.0);
    let s = -sign(q.y);
    let d = min(vec2f(dot(a, a), s * (p.x * q.y - p.y * q.x)), vec2f(dot(b, b), s * (p.y - q.y)));
    return -sqrt(d.x) * sign(d.y);
}`),

    e("sdTriangle", [], `
float sdTriangle(vec2 p, vec2 p0, vec2 p1, vec2 p2) {
    vec2 e0 = p1 - p0; vec2 e1 = p2 - p1; vec2 e2 = p0 - p2;
    vec2 v0 = p - p0; vec2 v1 = p - p1; vec2 v2 = p - p2;
    vec2 pq0 = v0 - e0 * clamp(dot(v0, e0) / dot(e0, e0), 0.0, 1.0);
    vec2 pq1 = v1 - e1 * clamp(dot(v1, e1) / dot(e1, e1), 0.0, 1.0);
    vec2 pq2 = v2 - e2 * clamp(dot(v2, e2) / dot(e2, e2), 0.0, 1.0);
    float s = sign(e0.x * e2.y - e0.y * e2.x);
    vec2 d = min(min(vec2(dot(pq0, pq0), s * (v0.x * e0.y - v0.y * e0.x)),
                     vec2(dot(pq1, pq1), s * (v1.x * e1.y - v1.y * e1.x))),
                 vec2(dot(pq2, pq2), s * (v2.x * e2.y - v2.y * e2.x)));
    return -sqrt(d.x) * sign(d.y);
}`, `
fn sdTriangle(p: vec2f, p0: vec2f, p1: vec2f, p2: vec2f) -> f32 {
    let e0 = p1 - p0; let e1 = p2 - p1; let e2 = p0 - p2;
    let v0 = p - p0; let v1 = p - p1; let v2 = p - p2;
    let pq0 = v0 - e0 * clamp(dot(v0, e0) / dot(e0, e0), 0.0, 1.0);
    let pq1 = v1 - e1 * clamp(dot(v1, e1) / dot(e1, e1), 0.0, 1.0);
    let pq2 = v2 - e2 * clamp(dot(v2, e2) / dot(e2, e2), 0.0, 1.0);
    let s = sign(e0.x * e2.y - e0.y * e2.x);
    let d = min(min(vec2f(dot(pq0, pq0), s * (v0.x * e0.y - v0.y * e0.x)),
                    vec2f(dot(pq1, pq1), s * (v1.x * e1.y - v1.y * e1.x))),
                vec2f(dot(pq2, pq2), s * (v2.x * e2.y - v2.y * e2.x)));
    return -sqrt(d.x) * sign(d.y);
}`),

    e("sdUnevenCapsule", [], `
float sdUnevenCapsule(vec2 p, float r1, float r2, float h) {
    p.x = abs(p.x);
    float b = (r1 - r2) / h;
    float a = sqrt(1.0 - b * b);
    float k = dot(p, vec2(-b, a));
    if (k < 0.0) return length(p) - r1;
    if (k > a * h) return length(p - vec2(0.0, h)) - r2;
    return dot(p, vec2(a, b)) - r1;
}`, `
fn sdUnevenCapsule(pIn: vec2f, r1: f32, r2: f32, h: f32) -> f32 {
    var p = pIn;
    p.x = abs(p.x);
    let b = (r1 - r2) / h;
    let a = sqrt(1.0 - b * b);
    let k = dot(p, vec2f(-b, a));
    if (k < 0.0) { return length(p) - r1; }
    if (k > a * h) { return length(p - vec2f(0.0, h)) - r2; }
    return dot(p, vec2f(a, b)) - r1;
}`),

    e("sdPentagon", [], `
float sdPentagon(vec2 p, float r) {
    const vec3 k = vec3(0.809016994, 0.587785252, 0.726542528);
    p.x = abs(p.x);
    p -= 2.0 * min(dot(vec2(-k.x, k.y), p), 0.0) * vec2(-k.x, k.y);
    p -= 2.0 * min(dot(vec2(k.x, k.y), p), 0.0) * vec2(k.x, k.y);
    p -= vec2(clamp(p.x, -r * k.z, r * k.z), r);
    return length(p) * sign(p.y);
}`, `
fn sdPentagon(pIn: vec2f, r: f32) -> f32 {
    let k = vec3f(0.809016994, 0.587785252, 0.726542528);
    var p = pIn;
    p.x = abs(p.x);
    p = p - 2.0 * min(dot(vec2f(-k.x, k.y), p), 0.0) * vec2f(-k.x, k.y);
    p = p - 2.0 * min(dot(vec2f(k.x, k.y), p), 0.0) * vec2f(k.x, k.y);
    p = p - vec2f(clamp(p.x, -r * k.z, r * k.z), r);
    return length(p) * sign(p.y);
}`),

    e("sdHexagon", [], `
float sdHexagon(vec2 p, float r) {
    const vec3 k = vec3(-0.866025404, 0.5, 0.577350269);
    p = abs(p);
    p -= 2.0 * min(dot(k.xy, p), 0.0) * k.xy;
    p -= vec2(clamp(p.x, -k.z * r, k.z * r), r);
    return length(p) * sign(p.y);
}`, `
fn sdHexagon(pIn: vec2f, r: f32) -> f32 {
    let k = vec3f(-0.866025404, 0.5, 0.577350269);
    var p = abs(pIn);
    p = p - 2.0 * min(dot(k.xy, p), 0.0) * k.xy;
    p = p - vec2f(clamp(p.x, -k.z * r, k.z * r), r);
    return length(p) * sign(p.y);
}`),

    e("sdOctogon", [], `
float sdOctogon(vec2 p, float r) {
    const vec3 k = vec3(-0.9238795325, 0.3826834323, 0.4142135623);
    p = abs(p);
    p -= 2.0 * min(dot(vec2(k.x, k.y), p), 0.0) * vec2(k.x, k.y);
    p -= 2.0 * min(dot(vec2(-k.x, k.y), p), 0.0) * vec2(-k.x, k.y);
    p -= vec2(clamp(p.x, -k.z * r, k.z * r), r);
    return length(p) * sign(p.y);
}`, `
fn sdOctogon(pIn: vec2f, r: f32) -> f32 {
    let k = vec3f(-0.9238795325, 0.3826834323, 0.4142135623);
    var p = abs(pIn);
    p = p - 2.0 * min(dot(vec2f(k.x, k.y), p), 0.0) * vec2f(k.x, k.y);
    p = p - 2.0 * min(dot(vec2f(-k.x, k.y), p), 0.0) * vec2f(-k.x, k.y);
    p = p - vec2f(clamp(p.x, -k.z * r, k.z * r), r);
    return length(p) * sign(p.y);
}`),

    e("sdHexagram", [], `
float sdHexagram(vec2 p, float r) {
    const vec4 k = vec4(-0.5, 0.8660254038, 0.5773502692, 1.7320508076);
    p = abs(p);
    p -= 2.0 * min(dot(k.xy, p), 0.0) * k.xy;
    p -= 2.0 * min(dot(k.yx, p), 0.0) * k.yx;
    p -= vec2(clamp(p.x, r * k.z, r * k.w), r);
    return length(p) * sign(p.y);
}`, `
fn sdHexagram(pIn: vec2f, r: f32) -> f32 {
    let k = vec4f(-0.5, 0.8660254038, 0.5773502692, 1.7320508076);
    var p = abs(pIn);
    p = p - 2.0 * min(dot(k.xy, p), 0.0) * k.xy;
    p = p - 2.0 * min(dot(k.yx, p), 0.0) * k.yx;
    p = p - vec2f(clamp(p.x, r * k.z, r * k.w), r);
    return length(p) * sign(p.y);
}`),

    e("sdStar5", [], `
float sdStar5(vec2 p, float r, float rf) {
    const vec2 k1 = vec2(0.809016994375, -0.587785252292);
    const vec2 k2 = vec2(-k1.x, k1.y);
    p.x = abs(p.x);
    p -= 2.0 * max(dot(k1, p), 0.0) * k1;
    p -= 2.0 * max(dot(k2, p), 0.0) * k2;
    p.x = abs(p.x);
    p.y -= r;
    vec2 ba = rf * vec2(-k1.y, k1.x) - vec2(0.0, 1.0);
    float h = clamp(dot(p, ba) / dot(ba, ba), 0.0, r);
    return length(p - ba * h) * sign(p.y * ba.x - p.x * ba.y);
}`, `
fn sdStar5(pIn: vec2f, r: f32, rf: f32) -> f32 {
    let k1 = vec2f(0.809016994375, -0.587785252292);
    let k2 = vec2f(-k1.x, k1.y);
    var p = pIn;
    p.x = abs(p.x);
    p = p - 2.0 * max(dot(k1, p), 0.0) * k1;
    p = p - 2.0 * max(dot(k2, p), 0.0) * k2;
    p.x = abs(p.x);
    p.y -= r;
    let ba = rf * vec2f(-k1.y, k1.x) - vec2f(0.0, 1.0);
    let h = clamp(dot(p, ba) / dot(ba, ba), 0.0, r);
    return length(p - ba * h) * sign(p.y * ba.x - p.x * ba.y);
}`),

    e("sdStar", ["sd_util"], `
float sdStar(vec2 p, float r, int n, float m) {
    float an = 3.141593 / float(n);
    float en = 3.141593 / m;
    vec2 acs = vec2(cos(an), sin(an));
    vec2 ecs = vec2(cos(en), sin(en));
    float bn = mod(atan(p.x, p.y), 2.0 * an) - an;
    p = length(p) * vec2(cos(bn), abs(sin(bn)));
    p -= r * acs;
    p += ecs * clamp(-dot(p, ecs), 0.0, r * acs.y / ecs.y);
    return length(p) * sign(p.x);
}`, `
fn sdStar(pIn: vec2f, r: f32, n: i32, m: f32) -> f32 {
    let an = 3.141593 / f32(n);
    let en = 3.141593 / m;
    let acs = vec2f(cos(an), sin(an));
    let ecs = vec2f(cos(en), sin(en));
    let bn = glslMod(atan2(pIn.x, pIn.y), 2.0 * an) - an;
    var p = length(pIn) * vec2f(cos(bn), abs(sin(bn)));
    p = p - r * acs;
    p = p + ecs * clamp(-dot(p, ecs), 0.0, r * acs.y / ecs.y);
    return length(p) * sign(p.x);
}`),

    e("sdPie", [], `
float sdPie(vec2 p, vec2 c, float r) {
    p.x = abs(p.x);
    float l = length(p) - r;
    float m = length(p - c * clamp(dot(p, c), 0.0, r));
    return max(l, m * sign(c.y * p.x - c.x * p.y));
}`, `
fn sdPie(pIn: vec2f, c: vec2f, r: f32) -> f32 {
    var p = pIn;
    p.x = abs(p.x);
    let l = length(p) - r;
    let m = length(p - c * clamp(dot(p, c), 0.0, r));
    return max(l, m * sign(c.y * p.x - c.x * p.y));
}`),

    e("sdCutDisk", [], `
float sdCutDisk(vec2 p, float r, float h) {
    float w = sqrt(r * r - h * h);
    p.x = abs(p.x);
    float s = max((h - r) * p.x * p.x + w * w * (h + r - 2.0 * p.y), h * p.x - w * p.y);
    return (s < 0.0) ? length(p) - r : (p.x < w) ? h - p.y : length(p - vec2(w, h));
}`, `
fn sdCutDisk(pIn: vec2f, r: f32, h: f32) -> f32 {
    let w = sqrt(r * r - h * h);
    var p = pIn;
    p.x = abs(p.x);
    let s = max((h - r) * p.x * p.x + w * w * (h + r - 2.0 * p.y), h * p.x - w * p.y);
    if (s < 0.0) { return length(p) - r; }
    if (p.x < w) { return h - p.y; }
    return length(p - vec2f(w, h));
}`),

    e("sdArc", [], `
float sdArc(vec2 p, vec2 sc, float ra, float rb) {
    p.x = abs(p.x);
    return ((sc.y * p.x > sc.x * p.y) ? length(p - sc * ra) : abs(length(p) - ra)) - rb;
}`, `
fn sdArc(pIn: vec2f, sc: vec2f, ra: f32, rb: f32) -> f32 {
    var p = pIn;
    p.x = abs(p.x);
    return select(abs(length(p) - ra), length(p - sc * ra), sc.y * p.x > sc.x * p.y) - rb;
}`),

    e("sdRing", [], `
float sdRing(vec2 p, vec2 n, float r, float th) {
    p.x = abs(p.x);
    p = vec2(p.x * n.x - p.y * n.y, p.x * n.y + p.y * n.x);
    return max(abs(length(p) - r) - th * 0.5, length(vec2(p.x, max(0.0, abs(r - p.y) - th * 0.5))) * sign(p.x));
}`, `
fn sdRing(pIn: vec2f, n: vec2f, r: f32, th: f32) -> f32 {
    var p = pIn;
    p.x = abs(p.x);
    p = vec2f(p.x * n.x - p.y * n.y, p.x * n.y + p.y * n.x);
    return max(abs(length(p) - r) - th * 0.5, length(vec2f(p.x, max(0.0, abs(r - p.y) - th * 0.5))) * sign(p.x));
}`),

    e("sdHorseshoe", [], `
float sdHorseshoe(vec2 p, vec2 c, float r, vec2 w) {
    p.x = abs(p.x);
    float l = length(p);
    p = vec2(-p.x * c.x + p.y * c.y, p.x * c.y + p.y * c.x);
    p = vec2((p.y > 0.0 || p.x > 0.0) ? p.x : l * sign(-c.x), (p.x > 0.0) ? p.y : l);
    p = vec2(p.x, abs(p.y - r)) - w;
    return length(max(p, 0.0)) + min(0.0, max(p.x, p.y));
}`, `
fn sdHorseshoe(pIn: vec2f, c: vec2f, r: f32, w: vec2f) -> f32 {
    var p = pIn;
    p.x = abs(p.x);
    let l = length(p);
    p = vec2f(-p.x * c.x + p.y * c.y, p.x * c.y + p.y * c.x);
    p = vec2f(select(l * sign(-c.x), p.x, p.y > 0.0 || p.x > 0.0), select(l, p.y, p.x > 0.0));
    p = vec2f(p.x, abs(p.y - r)) - w;
    return length(max(p, vec2f(0.0))) + min(0.0, max(p.x, p.y));
}`),

    e("sdVesica", [], `
float sdVesica(vec2 p, float r, float d) {
    p = abs(p);
    float b = sqrt(r * r - d * d);
    return ((p.y - b) * d > p.x * b) ? length(p - vec2(0.0, b)) : length(p - vec2(-d, 0.0)) - r;
}`, `
fn sdVesica(pIn: vec2f, r: f32, d: f32) -> f32 {
    let p = abs(pIn);
    let b = sqrt(r * r - d * d);
    if ((p.y - b) * d > p.x * b) { return length(p - vec2f(0.0, b)); }
    return length(p - vec2f(-d, 0.0)) - r;
}`),

    e("sdOrientedVesica", [], `
float sdOrientedVesica(vec2 p, vec2 a, vec2 b, float w) {
    float r = 0.5 * length(b - a);
    float d = 0.5 * (r * r - w * w) / w;
    vec2 v = (b - a) / r;
    vec2 c = (b + a) * 0.5;
    vec2 pc = p - c;
    vec2 q = 0.5 * abs(vec2(pc.x * v.y - pc.y * v.x, pc.x * v.x + pc.y * v.y));
    vec3 h = (r * q.x < d * (q.y - r)) ? vec3(0.0, r, 0.0) : vec3(-d, 0.0, d + w);
    return length(q - h.xy) - h.z;
}`, `
fn sdOrientedVesica(p: vec2f, a: vec2f, b: vec2f, w: f32) -> f32 {
    let r = 0.5 * length(b - a);
    let d = 0.5 * (r * r - w * w) / w;
    let v = (b - a) / r;
    let c = (b + a) * 0.5;
    let pc = p - c;
    let q = 0.5 * abs(vec2f(pc.x * v.y - pc.y * v.x, pc.x * v.x + pc.y * v.y));
    let h = select(vec3f(-d, 0.0, d + w), vec3f(0.0, r, 0.0), r * q.x < d * (q.y - r));
    return length(q - h.xy) - h.z;
}`),

    e("sdMoon", [], `
float sdMoon(vec2 p, float d, float ra, float rb) {
    p.y = abs(p.y);
    float a = (ra * ra - rb * rb + d * d) / (2.0 * d);
    float b = sqrt(max(ra * ra - a * a, 0.0));
    if (d * (p.x * b - p.y * a) > d * d * max(b - p.y, 0.0)) return length(p - vec2(a, b));
    return max(length(p) - ra, -(length(p - vec2(d, 0.0)) - rb));
}`, `
fn sdMoon(pIn: vec2f, d: f32, ra: f32, rb: f32) -> f32 {
    var p = pIn;
    p.y = abs(p.y);
    let a = (ra * ra - rb * rb + d * d) / (2.0 * d);
    let b = sqrt(max(ra * ra - a * a, 0.0));
    if (d * (p.x * b - p.y * a) > d * d * max(b - p.y, 0.0)) { return length(p - vec2f(a, b)); }
    return max(length(p) - ra, -(length(p - vec2f(d, 0.0)) - rb));
}`),

    e("sdRoundedCross", ["sd_util"], `
float sdRoundedCross(vec2 p, float h) {
    float k = 0.5 * (h + 1.0 / h);
    p = abs(p);
    return (p.x < 1.0 && p.y < p.x * (k - h) + h)
        ? k - sqrt(dot2(p - vec2(1.0, k)))
        : sqrt(min(dot2(p - vec2(0.0, h)), dot2(p - vec2(1.0, 0.0))));
}`, `
fn sdRoundedCross(pIn: vec2f, h: f32) -> f32 {
    let k = 0.5 * (h + 1.0 / h);
    let p = abs(pIn);
    if (p.x < 1.0 && p.y < p.x * (k - h) + h) { return k - sqrt(dot2(p - vec2f(1.0, k))); }
    return sqrt(min(dot2(p - vec2f(0.0, h)), dot2(p - vec2f(1.0, 0.0))));
}`),

    e("sdEgg", [], `
float sdEgg(vec2 p, float he, float ra, float rb, float bu) {
    float r = 0.5 * (he + ra + rb) / bu;
    float da = r - ra;
    float db = r - rb;
    float y = (db * db - da * da - he * he) / (2.0 * he);
    float x = sqrt(max(da * da - y * y, 0.0));
    p.x = abs(p.x);
    p.y += 0.5 * (he + rb - ra);
    float k = p.y * x - p.x * y;
    if (k > 0.0 && k < he * (p.x + x)) return length(p + vec2(x, y)) - r;
    return min(length(p) - ra, length(vec2(p.x, p.y - he)) - rb);
}`, `
fn sdEgg(pIn: vec2f, he: f32, ra: f32, rb: f32, bu: f32) -> f32 {
    let r = 0.5 * (he + ra + rb) / bu;
    let da = r - ra;
    let db = r - rb;
    let y = (db * db - da * da - he * he) / (2.0 * he);
    let x = sqrt(max(da * da - y * y, 0.0));
    var p = pIn;
    p.x = abs(p.x);
    p.y += 0.5 * (he + rb - ra);
    let k = p.y * x - p.x * y;
    if (k > 0.0 && k < he * (p.x + x)) { return length(p + vec2f(x, y)) - r; }
    return min(length(p) - ra, length(vec2f(p.x, p.y - he)) - rb);
}`),

    e("sdHeart", [], `
float sdHeart(vec2 p) {
    p.x = abs(p.x);
    if (p.y + p.x > 1.0) return sqrt(dot(p - vec2(0.25, 0.75), p - vec2(0.25, 0.75))) - sqrt(2.0) / 4.0;
    return sqrt(min(dot(p - vec2(0.0, 1.0), p - vec2(0.0, 1.0)),
                    dot(p - 0.5 * max(p.x + p.y, 0.0), p - 0.5 * max(p.x + p.y, 0.0)))) * sign(p.x - p.y);
}`, `
fn sdHeart(pIn: vec2f) -> f32 {
    var p = pIn;
    p.x = abs(p.x);
    if (p.y + p.x > 1.0) { return sqrt(dot(p - vec2f(0.25, 0.75), p - vec2f(0.25, 0.75))) - sqrt(2.0) / 4.0; }
    return sqrt(min(dot(p - vec2f(0.0, 1.0), p - vec2f(0.0, 1.0)),
                    dot(p - 0.5 * max(p.x + p.y, 0.0), p - 0.5 * max(p.x + p.y, 0.0)))) * sign(p.x - p.y);
}`),

    e("sdCross", [], `
float sdCross(vec2 p, vec2 b, float r) {
    p = abs(p);
    p = (p.y > p.x) ? p.yx : p.xy;
    vec2 q = p - b;
    float k = max(q.y, q.x);
    vec2 w = (k > 0.0) ? q : vec2(b.y - p.x, -k);
    return sign(k) * length(max(w, 0.0)) + r;
}`, `
fn sdCross(pIn: vec2f, b: vec2f, r: f32) -> f32 {
    var p = abs(pIn);
    p = select(p.xy, p.yx, p.y > p.x);
    let q = p - b;
    let k = max(q.y, q.x);
    let w = select(vec2f(b.y - p.x, -k), q, k > 0.0);
    return sign(k) * length(max(w, vec2f(0.0))) + r;
}`),

    e("sdRoundedX", [], `
float sdRoundedX(vec2 p, float w, float r) {
    p = abs(p);
    return length(p - min(p.x + p.y, w) * 0.5) - r;
}`, `
fn sdRoundedX(pIn: vec2f, w: f32, r: f32) -> f32 {
    let p = abs(pIn);
    return length(p - min(p.x + p.y, w) * 0.5) - r;
}`),

    e("sdEllipse", [], `
float sdEllipse(vec2 p, vec2 ab) {
    p = abs(p);
    if (p.x > p.y) { p = p.yx; ab = ab.yx; }
    float l = ab.y * ab.y - ab.x * ab.x;
    float m = ab.x * p.x / l;
    float m2 = m * m;
    float n = ab.y * p.y / l;
    float n2 = n * n;
    float c = (m2 + n2 - 1.0) / 3.0;
    float c3 = c * c * c;
    float q = c3 + m2 * n2 * 2.0;
    float d = c3 + m2 * n2;
    float g = m + m * n2;
    float co;
    if (d < 0.0) {
        float h = acos(q / c3) / 3.0;
        float s = cos(h);
        float t = sin(h) * sqrt(3.0);
        float rx = sqrt(-c * (s + t + 2.0) + m2);
        float ry = sqrt(-c * (s - t + 2.0) + m2);
        co = (ry + sign(l) * rx + abs(g) / (rx * ry) - m) / 2.0;
    } else {
        float h = 2.0 * m * n * sqrt(d);
        float s = sign(q + h) * pow(abs(q + h), 1.0 / 3.0);
        float u = sign(q - h) * pow(abs(q - h), 1.0 / 3.0);
        float rx = -s - u - c * 4.0 + 2.0 * m2;
        float ry = (s - u) * sqrt(3.0);
        float rm = sqrt(rx * rx + ry * ry);
        co = (ry / sqrt(rm - rx) + 2.0 * g / rm - m) / 2.0;
    }
    vec2 r = ab * vec2(co, sqrt(1.0 - co * co));
    return length(r - p) * sign(p.y - r.y);
}`, `
fn sdEllipse(pIn: vec2f, abIn: vec2f) -> f32 {
    var p = abs(pIn);
    var ab = abIn;
    if (p.x > p.y) { p = p.yx; ab = ab.yx; }
    let l = ab.y * ab.y - ab.x * ab.x;
    let m = ab.x * p.x / l;
    let m2 = m * m;
    let n = ab.y * p.y / l;
    let n2 = n * n;
    let c = (m2 + n2 - 1.0) / 3.0;
    let c3 = c * c * c;
    let q = c3 + m2 * n2 * 2.0;
    let d = c3 + m2 * n2;
    let g = m + m * n2;
    var co: f32;
    if (d < 0.0) {
        let h = acos(q / c3) / 3.0;
        let s = cos(h);
        let t = sin(h) * sqrt(3.0);
        let rx = sqrt(-c * (s + t + 2.0) + m2);
        let ry = sqrt(-c * (s - t + 2.0) + m2);
        co = (ry + sign(l) * rx + abs(g) / (rx * ry) - m) / 2.0;
    } else {
        let h = 2.0 * m * n * sqrt(d);
        let s = sign(q + h) * pow(abs(q + h), 1.0 / 3.0);
        let u = sign(q - h) * pow(abs(q - h), 1.0 / 3.0);
        let rx = -s - u - c * 4.0 + 2.0 * m2;
        let ry = (s - u) * sqrt(3.0);
        let rm = sqrt(rx * rx + ry * ry);
        co = (ry / sqrt(rm - rx) + 2.0 * g / rm - m) / 2.0;
    }
    let r = ab * vec2f(co, sqrt(1.0 - co * co));
    return length(r - p) * sign(p.y - r.y);
}`),

    e("sdParabola", [], `
float sdParabola(vec2 pos, float k) {
    pos.x = abs(pos.x);
    float ik = 1.0 / k;
    float p = ik * (pos.y - 0.5 * ik) / 3.0;
    float q = 0.25 * ik * ik * pos.x;
    float h = q * q - p * p * p;
    float r = sqrt(abs(h));
    float x = (h > 0.0)
        ? pow(q + r, 1.0 / 3.0) - pow(abs(q - r), 1.0 / 3.0) * sign(r - q)
        : 2.0 * cos(atan(r / q) / 3.0) * sqrt(p);
    return length(pos - vec2(x, k * x * x)) * sign(pos.x - x);
}`, `
fn sdParabola(posIn: vec2f, k: f32) -> f32 {
    var pos = posIn;
    pos.x = abs(pos.x);
    let ik = 1.0 / k;
    let p = ik * (pos.y - 0.5 * ik) / 3.0;
    let q = 0.25 * ik * ik * pos.x;
    let h = q * q - p * p * p;
    let r = sqrt(abs(h));
    var x: f32;
    if (h > 0.0) { x = pow(q + r, 1.0 / 3.0) - pow(abs(q - r), 1.0 / 3.0) * sign(r - q); }
    else { x = 2.0 * cos(atan(r / q) / 3.0) * sqrt(p); }
    return length(pos - vec2f(x, k * x * x)) * sign(pos.x - x);
}`),

    e("sdParabolaSegment", [], `
float sdParabolaSegment(vec2 pos, float wi, float he) {
    pos.x = abs(pos.x);
    float ik = wi * wi / he;
    float p = ik * (he - pos.y - 0.5 * ik) / 3.0;
    float q = pos.x * ik * ik * 0.25;
    float h = q * q - p * p * p;
    float r = sqrt(abs(h));
    float x = (h > 0.0)
        ? pow(q + r, 1.0 / 3.0) - pow(abs(q - r), 1.0 / 3.0) * sign(r - q)
        : 2.0 * cos(atan(r / q) / 3.0) * sqrt(p);
    x = min(x, wi);
    return length(pos - vec2(x, he - x * x / ik)) * sign(ik * (pos.y - he) + pos.x * pos.x);
}`, `
fn sdParabolaSegment(posIn: vec2f, wi: f32, he: f32) -> f32 {
    var pos = posIn;
    pos.x = abs(pos.x);
    let ik = wi * wi / he;
    let p = ik * (he - pos.y - 0.5 * ik) / 3.0;
    let q = pos.x * ik * ik * 0.25;
    let h = q * q - p * p * p;
    let r = sqrt(abs(h));
    var x: f32;
    if (h > 0.0) { x = pow(q + r, 1.0 / 3.0) - pow(abs(q - r), 1.0 / 3.0) * sign(r - q); }
    else { x = 2.0 * cos(atan(r / q) / 3.0) * sqrt(p); }
    x = min(x, wi);
    return length(pos - vec2f(x, he - x * x / ik)) * sign(ik * (pos.y - he) + pos.x * pos.x);
}`),

    e("sdBezier", [], `
float sdBezier(vec2 pos, vec2 A, vec2 B, vec2 C) {
    vec2 a = B - A;
    vec2 b = A - 2.0 * B + C;
    vec2 c = a * 2.0;
    vec2 d = A - pos;
    float kk = 1.0 / dot(b, b);
    float kx = kk * dot(a, b);
    float ky = kk * (2.0 * dot(a, a) + dot(d, b)) / 3.0;
    float kz = kk * dot(d, a);
    float res = 0.0;
    float p = ky - kx * kx;
    float p3 = p * p * p;
    float q = kx * (2.0 * kx * kx - 3.0 * ky) + kz;
    float h = q * q + 4.0 * p3;
    if (h >= 0.0) {
        h = sqrt(h);
        vec2 x = (vec2(h, -h) - q) * 0.5;
        vec2 uv = sign(x) * pow(abs(x), vec2(1.0 / 3.0, 1.0 / 3.0));
        float t = clamp(uv.x + uv.y - kx, 0.0, 1.0);
        res = dot(d + (c + b * t) * t, d + (c + b * t) * t);
    } else {
        float z = sqrt(-p);
        float v = acos(q / (p * z * 2.0)) / 3.0;
        float m = cos(v);
        float n = sin(v) * 1.732050808;
        vec3 t = clamp(vec3(m + m, -n - m, n - m) * z - kx, 0.0, 1.0);
        res = min(dot(d + (c + b * t.x) * t.x, d + (c + b * t.x) * t.x),
                  dot(d + (c + b * t.y) * t.y, d + (c + b * t.y) * t.y));
    }
    return sqrt(res);
}`, `
fn sdBezier(pos: vec2f, A: vec2f, B: vec2f, C: vec2f) -> f32 {
    let a = B - A;
    let b = A - 2.0 * B + C;
    let c = a * 2.0;
    let d = A - pos;
    let kk = 1.0 / dot(b, b);
    let kx = kk * dot(a, b);
    let ky = kk * (2.0 * dot(a, a) + dot(d, b)) / 3.0;
    let kz = kk * dot(d, a);
    var res = 0.0;
    let p = ky - kx * kx;
    let p3 = p * p * p;
    let q = kx * (2.0 * kx * kx - 3.0 * ky) + kz;
    var h = q * q + 4.0 * p3;
    if (h >= 0.0) {
        h = sqrt(h);
        let x = (vec2f(h, -h) - q) * 0.5;
        let uv = sign(x) * pow(abs(x), vec2f(1.0 / 3.0, 1.0 / 3.0));
        let t = clamp(uv.x + uv.y - kx, 0.0, 1.0);
        res = dot(d + (c + b * t) * t, d + (c + b * t) * t);
    } else {
        let z = sqrt(-p);
        let v = acos(q / (p * z * 2.0)) / 3.0;
        let m = cos(v);
        let n = sin(v) * 1.732050808;
        let t = clamp(vec3f(m + m, -n - m, n - m) * z - kx, vec3f(0.0), vec3f(1.0));
        res = min(dot(d + (c + b * t.x) * t.x, d + (c + b * t.x) * t.x),
                  dot(d + (c + b * t.y) * t.y, d + (c + b * t.y) * t.y));
    }
    return sqrt(res);
}`),

    e("sdBlobbyCross", [], `
float sdBlobbyCross(vec2 pos, float he) {
    pos = abs(pos);
    pos = vec2(abs(pos.x - pos.y), 1.0 - pos.x - pos.y) / sqrt(2.0);
    float p = (he - pos.y - 0.25 / he) / (6.0 * he);
    float q = pos.x / (he * he * 16.0);
    float h = q * q - p * p * p;
    float x;
    if (h > 0.0) {
        float r = sqrt(h);
        x = pow(q + r, 1.0 / 3.0) - pow(abs(q - r), 1.0 / 3.0) * sign(r - q);
    } else {
        float r = sqrt(p);
        x = 2.0 * r * cos(acos(q / (p * r)) / 3.0);
    }
    x = min(x, sqrt(2.0) / 2.0);
    vec2 z = vec2(x, he * (1.0 - 2.0 * x * x)) - pos;
    return length(z) * sign(z.y);
}`, `
fn sdBlobbyCross(posIn: vec2f, he: f32) -> f32 {
    var pos = abs(posIn);
    pos = vec2f(abs(pos.x - pos.y), 1.0 - pos.x - pos.y) / sqrt(2.0);
    let p = (he - pos.y - 0.25 / he) / (6.0 * he);
    let q = pos.x / (he * he * 16.0);
    let h = q * q - p * p * p;
    var x: f32;
    if (h > 0.0) {
        let r = sqrt(h);
        x = pow(q + r, 1.0 / 3.0) - pow(abs(q - r), 1.0 / 3.0) * sign(r - q);
    } else {
        let r = sqrt(p);
        x = 2.0 * r * cos(acos(q / (p * r)) / 3.0);
    }
    x = min(x, sqrt(2.0) / 2.0);
    let z = vec2f(x, he * (1.0 - 2.0 * x * x)) - pos;
    return length(z) * sign(z.y);
}`),

    e("sdTunnel", [], `
float sdTunnel(vec2 p, vec2 wh) {
    p.x = abs(p.x);
    p.y = -p.y;
    vec2 q = p - wh;
    float d1 = dot(vec2(max(q.x, 0.0), q.y), vec2(max(q.x, 0.0), q.y));
    q.x = (p.y > 0.0) ? q.x : length(p) - wh.x;
    float d2 = dot(vec2(q.x, max(q.y, 0.0)), vec2(q.x, max(q.y, 0.0)));
    float d = sqrt(min(d1, d2));
    return (max(q.x, q.y) < 0.0) ? -d : d;
}`, `
fn sdTunnel(pIn: vec2f, wh: vec2f) -> f32 {
    var p = pIn;
    p.x = abs(p.x);
    p.y = -p.y;
    var q = p - wh;
    let d1 = dot(vec2f(max(q.x, 0.0), q.y), vec2f(max(q.x, 0.0), q.y));
    q.x = select(length(p) - wh.x, q.x, p.y > 0.0);
    let d2 = dot(vec2f(q.x, max(q.y, 0.0)), vec2f(q.x, max(q.y, 0.0)));
    let d = sqrt(min(d1, d2));
    return select(d, -d, max(q.x, q.y) < 0.0);
}`),

    e("sdStairs", [], `
float sdStairs(vec2 p, vec2 wh, float n) {
    vec2 ba = wh * n;
    float d = min(dot(p - vec2(clamp(p.x, 0.0, ba.x), 0.0), p - vec2(clamp(p.x, 0.0, ba.x), 0.0)),
                  dot(p - vec2(ba.x, clamp(p.y, 0.0, ba.y)), p - vec2(ba.x, clamp(p.y, 0.0, ba.y))));
    float s = sign(max(-p.y, p.x - ba.x));
    float dia = length(wh);
    p = vec2(p.x * wh.x + p.y * wh.y, -p.x * wh.y + p.y * wh.x) / dia;
    float id = clamp(round(p.x / dia), 0.0, n - 1.0);
    p.x = p.x - id * dia;
    p = vec2(p.x * wh.x - p.y * wh.y, p.x * wh.y + p.y * wh.x) / dia;
    float hh = wh.y / 2.0;
    p.y -= hh;
    if (p.y > hh * sign(p.x)) s = 1.0;
    p = (id < 0.5 || p.x > 0.0) ? p : -p;
    d = min(d, dot(p - vec2(0.0, clamp(p.y, -hh, hh)), p - vec2(0.0, clamp(p.y, -hh, hh))));
    d = min(d, dot(p - vec2(clamp(p.x, 0.0, wh.x), hh), p - vec2(clamp(p.x, 0.0, wh.x), hh)));
    return sqrt(d) * s;
}`, `
fn sdStairs(pIn: vec2f, wh: vec2f, n: f32) -> f32 {
    var p = pIn;
    let ba = wh * n;
    var d = min(dot(p - vec2f(clamp(p.x, 0.0, ba.x), 0.0), p - vec2f(clamp(p.x, 0.0, ba.x), 0.0)),
                dot(p - vec2f(ba.x, clamp(p.y, 0.0, ba.y)), p - vec2f(ba.x, clamp(p.y, 0.0, ba.y))));
    var s = sign(max(-p.y, p.x - ba.x));
    let dia = length(wh);
    p = vec2f(p.x * wh.x + p.y * wh.y, -p.x * wh.y + p.y * wh.x) / dia;
    let id = clamp(round(p.x / dia), 0.0, n - 1.0);
    p.x = p.x - id * dia;
    p = vec2f(p.x * wh.x - p.y * wh.y, p.x * wh.y + p.y * wh.x) / dia;
    let hh = wh.y / 2.0;
    p.y -= hh;
    if (p.y > hh * sign(p.x)) { s = 1.0; }
    p = select(-p, p, id < 0.5 || p.x > 0.0);
    d = min(d, dot(p - vec2f(0.0, clamp(p.y, -hh, hh)), p - vec2f(0.0, clamp(p.y, -hh, hh))));
    d = min(d, dot(p - vec2f(clamp(p.x, 0.0, wh.x), hh), p - vec2f(clamp(p.x, 0.0, wh.x), hh)));
    return sqrt(d) * s;
}`),

    e("sdQuadraticCircle", [], `
float sdQuadraticCircle(vec2 p) {
    p = abs(p);
    if (p.y > p.x) p = p.yx;
    float a = p.x - p.y;
    float b = p.x + p.y;
    float c = (2.0 * b - 1.0) / 3.0;
    float h = a * a + c * c * c;
    float t;
    if (h >= 0.0) {
        h = sqrt(h);
        t = sign(h - a) * pow(abs(h - a), 1.0 / 3.0) - pow(h + a, 1.0 / 3.0);
    } else {
        float z = sqrt(-c);
        float v = acos(a / (c * z)) / 3.0;
        t = -z * (cos(v) + sin(v) * 1.732050808);
    }
    t *= 0.5;
    vec2 w = vec2(-t, t) + 0.75 - t * t - p;
    return length(w) * sign(a * a * 0.5 + b - 1.5);
}`, `
fn sdQuadraticCircle(pIn: vec2f) -> f32 {
    var p = abs(pIn);
    if (p.y > p.x) { p = p.yx; }
    let a = p.x - p.y;
    let b = p.x + p.y;
    let c = (2.0 * b - 1.0) / 3.0;
    var h = a * a + c * c * c;
    var t: f32;
    if (h >= 0.0) {
        h = sqrt(h);
        t = sign(h - a) * pow(abs(h - a), 1.0 / 3.0) - pow(h + a, 1.0 / 3.0);
    } else {
        let z = sqrt(-c);
        let v = acos(a / (c * z)) / 3.0;
        t = -z * (cos(v) + sin(v) * 1.732050808);
    }
    t *= 0.5;
    let w = vec2f(-t, t) + 0.75 - t * t - p;
    return length(w) * sign(a * a * 0.5 + b - 1.5);
}`),

    e("sdHyberbola", [], `
float sdHyberbola(vec2 p, float k, float he) {
    p = abs(p);
    p = vec2(p.x - p.y, p.x + p.y) / sqrt(2.0);
    float x2 = p.x * p.x / 16.0;
    float y2 = p.y * p.y / 16.0;
    float r = k * (4.0 * k - p.x * p.y) / 12.0;
    float q = (x2 - y2) * k * k;
    float h = q * q + r * r * r;
    float u;
    if (h < 0.0) {
        float m = sqrt(-r);
        u = m * cos(acos(q / (r * m)) / 3.0);
    } else {
        float m = pow(sqrt(h) - q, 1.0 / 3.0);
        u = (m - r / m) / 2.0;
    }
    float w = sqrt(u + x2);
    float b = k * p.y - x2 * p.x * 2.0;
    float t = p.x / 4.0 - w + sqrt(2.0 * x2 - u + b / w / 4.0);
    t = max(t, sqrt(he * he * 0.5 + k) - he / sqrt(2.0));
    return length(p - vec2(t, k / t)) * sign(p.x * p.y < k ? 1.0 : -1.0);
}`, `
fn sdHyberbola(pIn: vec2f, k: f32, he: f32) -> f32 {
    var p = abs(pIn);
    p = vec2f(p.x - p.y, p.x + p.y) / sqrt(2.0);
    let x2 = p.x * p.x / 16.0;
    let y2 = p.y * p.y / 16.0;
    let r = k * (4.0 * k - p.x * p.y) / 12.0;
    let q = (x2 - y2) * k * k;
    let h = q * q + r * r * r;
    var u: f32;
    if (h < 0.0) {
        let m = sqrt(-r);
        u = m * cos(acos(q / (r * m)) / 3.0);
    } else {
        let m = pow(sqrt(h) - q, 1.0 / 3.0);
        u = (m - r / m) / 2.0;
    }
    let w = sqrt(u + x2);
    let b = k * p.y - x2 * p.x * 2.0;
    var t = p.x / 4.0 - w + sqrt(2.0 * x2 - u + b / w / 4.0);
    t = max(t, sqrt(he * he * 0.5 + k) - he / sqrt(2.0));
    return length(p - vec2f(t, k / t)) * sign(select(-1.0, 1.0, p.x * p.y < k));
}`),

    e("sdCoolS", ["sd_util"], `
float sdCoolS(vec2 p) {
    float six = (p.y < 0.0) ? -p.x : p.x;
    p.x = abs(p.x);
    p.y = abs(p.y) - 0.2;
    float rex = p.x - min(round(p.x / 0.4), 0.4);
    float aby = abs(p.y - 0.2) - 0.6;
    float d = dot2(vec2(six, -p.y) - clamp(0.5 * (six - p.y), 0.0, 0.2));
    d = min(d, dot2(vec2(p.x, -aby) - clamp(0.5 * (p.x - aby), 0.0, 0.4)));
    d = min(d, dot2(vec2(rex, p.y - clamp(p.y, 0.0, 0.4))));
    float s = 2.0 * p.x + aby + abs(aby + 0.4) - 0.4;
    return sqrt(d) * sign(s);
}`, `
fn sdCoolS(pIn: vec2f) -> f32 {
    var p = pIn;
    let six = select(p.x, -p.x, p.y < 0.0);
    p.x = abs(p.x);
    p.y = abs(p.y) - 0.2;
    let rex = p.x - min(round(p.x / 0.4), 0.4);
    let aby = abs(p.y - 0.2) - 0.6;
    var d = dot2(vec2f(six, -p.y) - clamp(0.5 * (six - p.y), 0.0, 0.2));
    d = min(d, dot2(vec2f(p.x, -aby) - clamp(0.5 * (p.x - aby), 0.0, 0.4)));
    d = min(d, dot2(vec2f(rex, p.y - clamp(p.y, 0.0, 0.4))));
    let s = 2.0 * p.x + aby + abs(aby + 0.4) - 0.4;
    return sqrt(d) * sign(s);
}`),

    e("sdCircleWave", ["sd_util"], `
float sdCircleWave(vec2 p, float tb, float ra) {
    tb = 3.1415927 * 5.0 / 6.0 * max(tb, 0.0001);
    vec2 co = ra * vec2(sin(tb), cos(tb));
    p.x = abs(mod(p.x, co.x * 4.0) - co.x * 2.0);
    vec2 p1 = p;
    vec2 p2 = vec2(abs(p.x - 2.0 * co.x), -p.y + 2.0 * co.y);
    float d1 = ((co.y * p1.x > co.x * p1.y) ? length(p1 - co) : abs(length(p1) - ra));
    float d2 = ((co.y * p2.x > co.x * p2.y) ? length(p2 - co) : abs(length(p2) - ra));
    return min(d1, d2);
}`, `
fn sdCircleWave(pIn: vec2f, tbIn: f32, ra: f32) -> f32 {
    let tb = 3.1415927 * 5.0 / 6.0 * max(tbIn, 0.0001);
    let co = ra * vec2f(sin(tb), cos(tb));
    var p = pIn;
    p.x = abs(glslMod(p.x, co.x * 4.0) - co.x * 2.0);
    let p1 = p;
    let p2 = vec2f(abs(p.x - 2.0 * co.x), -p.y + 2.0 * co.y);
    let d1 = select(abs(length(p1) - ra), length(p1 - co), co.y * p1.x > co.x * p1.y);
    let d2 = select(abs(length(p2) - ra), length(p2 - co), co.y * p2.x > co.x * p2.y);
    return min(d1, d2);
}`),
]
