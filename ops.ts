/**
 * The shader language opcode table.
 *
 * Phase 1 of `Specs/SHADER_LANG.md`. This is the contract three things will
 * share: the encoder that packs a program into a texture, the VM shader that
 * evaluates it, and the HLSL emitter that prints it. Two of those do not exist
 * yet, which is exactly why the numbering is fixed now rather than later.
 *
 * Numbered in families with gaps, the convention `fx/ops.ts` set, so a reader
 * can tell what an opcode is from its value:
 *
 *     0..15    construct and swizzle
 *    16..47    arithmetic
 *    48..79    maths
 *    80..95    geometry
 *    96..111   interpolate
 *   112..127   colour
 *   128..143   procedural
 *   144..159   sampling
 *
 * Leave the gaps. A later opcode landing in the right family is worth more than
 * a dense table.
 */

/** Bumped when the encoding changes. The VM accepts 1..CURRENT and refuses newer. */
export const SL_WIRE_VERSION = 1

export const SLOP = {
    // Construct and swizzle
    CONST: 0,
    INPUT: 1,
    UNIFORM: 2,
    COMPOSE: 3,   // build a wider value from narrower parts
    SWIZZLE: 4,

    // Arithmetic
    ADD: 16,
    SUB: 17,
    MUL: 18,
    DIV: 19,
    MOD: 20,
    POW: 21,
    NEG: 22,
    RECIP: 23,

    // Maths
    SIN: 48,
    COS: 49,
    TAN: 50,
    ASIN: 51,
    ACOS: 52,
    ATAN2: 53,
    EXP: 54,
    LOG: 55,
    SQRT: 56,
    ABS: 57,
    SIGN: 58,
    FLOOR: 59,
    CEIL: 60,
    ROUND: 61,
    FRACT: 62,
    MIN: 63,
    MAX: 64,
    CLAMP: 65,
    SATURATE: 66,

    // Geometry
    LENGTH: 80,
    DISTANCE: 81,
    DOT: 82,
    CROSS: 83,
    NORMALIZE: 84,
    REFLECT: 85,

    // Interpolate
    MIX: 96,
    STEP: 97,
    SMOOTHSTEP: 98,
    SELECT: 99,
    REMAP: 100,

    // Colour
    RAMP: 112,
    HSV2RGB: 113,
    RGB2HSV: 114,
    LUMINANCE: 115,

    // Procedural. These are SUPERINSTRUCTIONS: one opcode expanding to a
    // substantial block in the shader, the way SOURCE_NOISE and SOURCE_SDF
    // already do in FxSources. Making an author build fbm out of thirty
    // primitives would be slower to run and worse to write, and we already own
    // the HLSL.
    NOISE: 128,
    SIMPLEX: 129,
    FBM: 130,
    SDF: 131,
    VORONOI: 132,

    // Sampling
    SAMPLE: 144,
    SAMPLE_LOD: 145,
} as const

export type SLOpCode = (typeof SLOP)[keyof typeof SLOP]

/**
 * How many arguments each op takes, for validation and for the encoder.
 *
 * -1 means variadic: COMPOSE takes however many parts add up to its width, RAMP
 * takes a value plus its stops. Everything else is fixed, and a mismatch is a
 * bug in the builder rather than something an author can cause.
 */
export const SL_ARITY: Record<number, number> = {
    [SLOP.CONST]: 0, [SLOP.INPUT]: 0, [SLOP.UNIFORM]: 0,
    [SLOP.COMPOSE]: -1, [SLOP.SWIZZLE]: 1,

    [SLOP.ADD]: 2, [SLOP.SUB]: 2, [SLOP.MUL]: 2, [SLOP.DIV]: 2,
    [SLOP.MOD]: 2, [SLOP.POW]: 2, [SLOP.NEG]: 1, [SLOP.RECIP]: 1,

    [SLOP.SIN]: 1, [SLOP.COS]: 1, [SLOP.TAN]: 1, [SLOP.ASIN]: 1, [SLOP.ACOS]: 1,
    [SLOP.ATAN2]: 2, [SLOP.EXP]: 1, [SLOP.LOG]: 1, [SLOP.SQRT]: 1, [SLOP.ABS]: 1,
    [SLOP.SIGN]: 1, [SLOP.FLOOR]: 1, [SLOP.CEIL]: 1, [SLOP.ROUND]: 1,
    [SLOP.FRACT]: 1, [SLOP.MIN]: 2, [SLOP.MAX]: 2, [SLOP.CLAMP]: 3,
    [SLOP.SATURATE]: 1,

    [SLOP.LENGTH]: 1, [SLOP.DISTANCE]: 2, [SLOP.DOT]: 2, [SLOP.CROSS]: 2,
    [SLOP.NORMALIZE]: 1, [SLOP.REFLECT]: 2,

    [SLOP.MIX]: 3, [SLOP.STEP]: 2, [SLOP.SMOOTHSTEP]: 3, [SLOP.SELECT]: 3,
    [SLOP.REMAP]: 5,

    [SLOP.RAMP]: -1, [SLOP.HSV2RGB]: 1, [SLOP.RGB2HSV]: 1, [SLOP.LUMINANCE]: 1,

    [SLOP.NOISE]: 1, [SLOP.SIMPLEX]: 1, [SLOP.FBM]: 1, [SLOP.SDF]: -1,
    [SLOP.VORONOI]: 1,

    [SLOP.SAMPLE]: 1, [SLOP.SAMPLE_LOD]: 2,
}

/** Name per opcode, for error messages and for the HLSL emitter's comments. */
export const SL_NAME: Record<number, string> = Object.fromEntries(
    Object.entries(SLOP).map(([name, code]) => [code, name.toLowerCase()]),
)

export const FIRST_ARITHMETIC = 16
export const FIRST_MATHS = 48
export const FIRST_GEOMETRY = 80
export const FIRST_INTERPOLATE = 96
export const FIRST_COLOUR = 112
export const FIRST_PROCEDURAL = 128
export const FIRST_SAMPLING = 144

/**
 * Ops that read a texture. Sampler slots are the one resource ceiling neither
 * backend can widen (16 in a fragment shader on WebGL2), so these are counted
 * at record time.
 */
export function isSampling(op: number): boolean {
    return op >= FIRST_SAMPLING
}
