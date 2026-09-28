/**
 * The library's hashes as arithmetic, and what each hash probe has to draw.
 *
 * `goldens/run.mjs` compares the probes (`probes.hlsl`, and `probe-hash.sl` in
 * the corpus) with these, pixel for pixel and allowing nothing, on every
 * backend it draws on. These are the float hashes, evaluated the way IEEE 754
 * single precision says, every operation rounded on its own: `Math.fround`
 * after each one, and no two fused into a single rounding.
 */

const f = Math.fround
const frac = (x) => f(x - Math.floor(x))
const K = [f(123.34), f(456.21)]
const SEED = f(0.1731)
const DOT = f(45.32)
const JITTER = f(37.7)

function mix(px, py) {
    const d = f(f(px * f(px + DOT)) + f(py * f(py + DOT)))
    const x = f(px + d), y = f(py + d)
    return frac(f(x * y))
}

/** onejsHash21: the value noise hash. */
export function hash21(x, y, seed) {
    const s = frac(f(f(seed) * SEED))
    return mix(frac(f(frac(f(f(x) * K[0])) + s)), frac(f(frac(f(f(y) * K[1])) + s)))
}

const slHash21 = (x, y) => mix(frac(f(f(x) * K[0])), frac(f(f(y) * K[1])))

/** sl_hash22: voronoi's jitter. */
export function hash22(x, y) {
    return [slHash21(x, y), slHash21(f(f(x) + JITTER), f(f(y) + JITTER))]
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
