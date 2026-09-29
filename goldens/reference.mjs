/**
 * The library's hashes as arithmetic, and what each hash probe has to draw.
 *
 * `goldens/run.mjs` compares the probes (`probes.hlsl`, and `probe-hash.sl` in
 * the corpus) with these, pixel for pixel and allowing nothing, on every
 * backend it draws on. The hashes are 32 bit unsigned integer arithmetic,
 * which every target does exactly (`lib/noise2d.hlsl` says why): `Math.imul`
 * and `>>> 0` here are the same wrapping multiply and add. The only floats are
 * the conversions in and out, and `Math.fround` rounds those as a GPU does.
 */

const f = Math.fround
const MIN = -2147483648
const MAX = 2147483520
const clamp = (x) => Math.min(Math.max(x, MIN), MAX)
const u32 = (x) => x >>> 0
const mul = (a, b) => Math.imul(a, b) >>> 0

/** pcg2d, as onejsPcg2d. */
export function pcg2d(x, y) {
    x = u32(mul(x, 1664525) + 1013904223)
    y = u32(mul(y, 1664525) + 1013904223)
    x = u32(x + mul(y, 1664525))
    y = u32(y + mul(x, 1664525))
    x = u32(x ^ (x >>> 16))
    y = u32(y ^ (y >>> 16))
    x = u32(x + mul(y, 1664525))
    y = u32(y + mul(x, 1664525))
    x = u32(x ^ (x >>> 16))
    y = u32(y ^ (y >>> 16))
    return [x, y]
}

/** onejsHashKey: a float to int conversion truncates, and wraps into a uint. */
export function hashKey(cx, cy, seed) {
    const s = clamp(f(seed))
    const whole = Math.floor(s)
    const kx = u32(Math.trunc(whole)), ky = u32(Math.trunc(f(f(s - whole) * 65536)))
    return [u32(u32(Math.trunc(clamp(f(cx)))) + mul(kx, 2654435769)), u32(u32(Math.trunc(clamp(f(cy)))) + mul(ky, 2246822507))]
}

const unit = (word) => (word >>> 8) * 2 ** -24

/** onejsHash21: the value noise hash. */
export function hash21(x, y, seed) {
    return unit(pcg2d(...hashKey(x, y, seed))[0])
}

/** sl_hash22: voronoi's jitter. */
export function hash22(x, y) {
    const [kx, ky] = hashKey(x, y, 0)
    return pcg2d(u32(kx + 1759714724), u32(ky + 3002137945)).map(unit)
}

// MARK: probes

/** Bits 11 - 3g, 10 - 3g and 9 - 3g of a value's top twelve, as a pixel. */
function bits(h, group) {
    const t = Math.floor(Math.floor(h * 4096) / 2 ** (9 - 3 * group))
    return [(t >> 2) & 1, (t >> 1) & 1, t & 1].map((b) => b * 255).concat(255)
}

const CASES21 = [
    [0, 0, 0, 1], [0, 0, 0, -1], [0, 0, -0, 1], [0, 0, 0.5, 1], [0, 0, 1, 1], [0, 0, 19, 1], [0, 0, 57, 1],
    [0, 0, 1e6, 1], [-4, -4, 0, 1], [1e4, -1e4, 0, 1], [1e6, 1e6, 0, 1], [2 ** 30, -(2 ** 30), 0, 1],
    [3e9, -3e9, 0, 1], [2147483520, -(2 ** 31), 0, 1], [123, 456, -3.5, 1], [-777, 333, 57.25, 1],
]
const CASES22 = [
    [0, 0, 1], [0, 0, -1], [-4, -4, 1], [8, 8, 1], [-100, 50, 1], [1000, -1000, 1], [1e4, -1e4, 1], [65536, 65536, 1],
    [1e6, 1e6, 1], [-1e6, 1e6, 1], [2 ** 24, -(2 ** 24), 1], [2 ** 30, -(2 ** 30), 1], [2147483520, -(2 ** 31), 1],
    [3e9, -3e9, 1], [-3e9, 3e9, 1], [123, 456, 1],
]

/** A block's cell, as the shader computes it: the start plus the offset, then the sign. */
const cellOf = (sx, sy, ox, oy, sign) => [f(f(sx + ox) * sign), f(f(sy + oy) * sign)]

/** What each probe draws, at a pixel counted from the top left. */
export const PROBE_PIXELS = {
    hash21(x, y) {
        const k = y * 64 + x, block = k >> 8, j = k & 255, n = j >> 2
        const [sx, sy, seed, sign] = CASES21[block]
        const [cx, cy] = cellOf(sx, sy, n & 7, n >> 3, sign)
        return bits(hash21(cx, cy, seed), j & 3)
    },
    hash22(x, y) {
        const k = y * 64 + x, block = k >> 8, j = k & 255, n = j >> 3, g = j & 7
        const [sx, sy, sign] = CASES22[block]
        const [cx, cy] = cellOf(sx, sy, n & 7, n >> 3, sign)
        return bits(hash22(cx, cy)[g < 4 ? 0 : 1], g & 3)
    },
}

const STARTS = [
    [0, 0, 1], [0, 0, -1], [-8, -4, 1], [1e4, -1e4, 1], [1e6, 1e6, 1], [2 ** 24, -(2 ** 24), 1], [2 ** 30, -(2 ** 30), 1], [3e9, -3e9, 1],
]

/** What corpus/probe-hash.sl draws: noise at seed 0, at whole number points, is the hash. */
export function probeProgramPixel(x, y) {
    const k = y * 64 + x, block = k >> 9, j = k & 511, n = j >> 2
    const [sx, sy, sign] = STARTS[block]
    const [cx, cy] = cellOf(sx, sy, n & 15, n >> 4, sign)
    return bits(hash21(cx, cy, 0), j & 3)
}

/**
 * What corpus/int-ops.sl draws at uv: each channel 0 or 255, from int and uint
 * arithmetic done here as the GPU does it. Division and remainder truncate, a
 * zero divisor gives 0, a float converts held to MIN and MAX, a sum wraps, and
 * a shift takes its count modulo 32.
 */
export function intOpsPixel(u, v) {
    const cell = Math.floor(f(u * 8)) + 8 * Math.floor(f(v * 8))
    const a = cell - 32, b = (cell % 5) - 2
    let h = u32(mul(cell, 747796405) + 2891336453)
    h = mul(u32((h >>> (((h >>> 28) + 4) & 31)) ^ h), 277803737)
    h = u32(h ^ (h >>> 22))
    const big = (Math.trunc(clamp(f(f(cell) * 1e9))) + 2147483647) | 0
    const odd = (a & 1) !== 0
    const neg = Math.trunc(a / 3) < 0 || a % 3 < 0
    const mid = a >= -8 && a <= 8
    const q = b === 0 ? a : Math.trunc(a / b)
    const r = ((q | (mid ? 1 : 0)) % 2) !== 0
    const g = ((h & 0xff) > 127) !== odd
    const bl = ((big >> 31) & 1) ^ (neg ? 1 : 0) ^ ((~cell & ((1 << ((cell + 30) & 31)) >> 1)) !== 0 ? 1 : 0)
    return [r ? 255 : 0, g ? 255 : 0, bl ? 255 : 0, 255]
}

/**
 * What corpus/loop-cap.sl draws at uv, as linear values before the store: red
 * 1 where a loop that never stops by itself left after exactly 1024 turns,
 * green the odd counts a loop of continues kept, blue where a return left a loop.
 */
export function loopCapLinear(u, v) {
    const odd = Math.floor(Math.trunc(f(u * 40)) / 2)
    const j = Math.floor(f(v * 100)) + 1
    return [1, odd / 20, j <= 99 ? j / 100 : 1]
}
