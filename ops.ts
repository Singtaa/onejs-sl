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

/**
 * What the VM shader actually declares, and therefore what a program may use.
 *
 * `FxProgram.shader` has `float4 _Uniforms[16]` and four `sampler2D`s, and
 * `SLProgramBridge.cs` fills exactly those. Past either ceiling the VM does not
 * fail, it clamps: uniform 17 reads slot 15 and texture slot 4 samples `_Tex3`,
 * while the generated HLSL would declare both correctly. That is a silent
 * disagreement between the backends, so the text form reports it at the
 * declaration with a file and a line. See `Specs/SL_TEXT.md` 3.7.
 */
export const VM_UNIFORMS = 16
export const VM_TEXTURES = 4

/** Input ids, fixed here because the shader switches on them. */
export const INPUT_ID: Record<string, number> = {
    uv: 0, fragCoord: 1, resolution: 2, time: 3, aspect: 4,
}

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
    // A colour as written (sRGB, like CSS) to the working space the target
    // holds. Gamma-aware in both backends; alpha is left alone.
    TO_LINEAR: 116,

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
    // Same field family as fx noise: |simplex| octaves summed, and the crease
    // made bright. imm.x carries the octave count, as FBM does.
    TURBULENCE: 133,
    RIDGED: 134,

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

    [SLOP.RAMP]: -1, [SLOP.HSV2RGB]: 1, [SLOP.RGB2HSV]: 1, [SLOP.LUMINANCE]: 1, [SLOP.TO_LINEAR]: 1,

    [SLOP.NOISE]: 1, [SLOP.SIMPLEX]: 1, [SLOP.FBM]: 1, [SLOP.SDF]: 1,
    [SLOP.VORONOI]: 1, [SLOP.TURBULENCE]: 1, [SLOP.RIDGED]: 1,

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

/**
 * How each opcode is written in the text form, `Specs/SL_TEXT.md` 3.4.
 *
 * ONE COLUMN, READ BY BOTH SURFACES. The EDSL's names and the parser's names
 * are the same set by construction rather than by two lists that have to be
 * kept level; `lang/builtins.ts` attaches a lowering to each `call` entry here
 * and a contract test refuses an opcode that has neither a spelling nor a
 * reason to lack one.
 *
 * `call` is a name an author writes as a function. `syntax` is everything the
 * language produces from a form instead: an operator, a constructor, a swizzle,
 * the conditional. An opcode has exactly one of the two.
 */
export interface SLSurface {
    call?: string
    syntax?: string
    /**
     * Set when the surface form does not emit this opcode at all: it expands
     * into ops both backends already have. `ramp` and `remap` are macros for
     * the same reason `sl.ramp` is, and the opcode number stays reserved.
     */
    macro?: true
}

export const SL_HLSL: Record<number, SLSurface> = {
    [SLOP.CONST]: { syntax: "a number literal" },
    [SLOP.INPUT]: { syntax: "uv, fragCoord, resolution, time, aspect" },
    [SLOP.UNIFORM]: { syntax: "uniform <type> name = <default>;" },
    [SLOP.COMPOSE]: { syntax: "float2(), float3(), float4()" },
    [SLOP.SWIZZLE]: { syntax: ".xyzw / .rgba" },

    [SLOP.ADD]: { syntax: "+" },
    [SLOP.SUB]: { syntax: "-" },
    [SLOP.MUL]: { syntax: "*" },
    [SLOP.DIV]: { syntax: "/" },
    [SLOP.MOD]: { syntax: "%" },
    [SLOP.POW]: { call: "pow" },
    [SLOP.NEG]: { syntax: "unary -" },
    [SLOP.RECIP]: { call: "rcp" },

    [SLOP.SIN]: { call: "sin" },
    [SLOP.COS]: { call: "cos" },
    [SLOP.TAN]: { call: "tan" },
    [SLOP.ASIN]: { call: "asin" },
    [SLOP.ACOS]: { call: "acos" },
    [SLOP.ATAN2]: { call: "atan2" },
    [SLOP.EXP]: { call: "exp" },
    [SLOP.LOG]: { call: "log" },
    [SLOP.SQRT]: { call: "sqrt" },
    [SLOP.ABS]: { call: "abs" },
    [SLOP.SIGN]: { call: "sign" },
    [SLOP.FLOOR]: { call: "floor" },
    [SLOP.CEIL]: { call: "ceil" },
    [SLOP.ROUND]: { call: "round" },
    [SLOP.FRACT]: { call: "frac" },
    [SLOP.MIN]: { call: "min" },
    [SLOP.MAX]: { call: "max" },
    [SLOP.CLAMP]: { call: "clamp" },
    [SLOP.SATURATE]: { call: "saturate" },

    [SLOP.LENGTH]: { call: "length" },
    [SLOP.DISTANCE]: { call: "distance" },
    [SLOP.DOT]: { call: "dot" },
    [SLOP.CROSS]: { call: "cross" },
    [SLOP.NORMALIZE]: { call: "normalize" },
    [SLOP.REFLECT]: { call: "reflect" },

    [SLOP.MIX]: { call: "lerp" },
    [SLOP.STEP]: { call: "step" },
    [SLOP.SMOOTHSTEP]: { call: "smoothstep" },
    // `select` exists as a name too, because `sl.select` does and a contract
    // test holds the two surfaces level, but `?:` is how anyone writes it.
    [SLOP.SELECT]: { syntax: "?:" },
    [SLOP.REMAP]: { call: "remap", macro: true },

    [SLOP.RAMP]: { call: "ramp", macro: true },
    [SLOP.HSV2RGB]: { call: "hsv2rgb" },
    [SLOP.RGB2HSV]: { call: "rgb2hsv" },
    [SLOP.LUMINANCE]: { call: "luminance" },
    [SLOP.TO_LINEAR]: { call: "toLinear" },

    [SLOP.NOISE]: { call: "noise" },
    [SLOP.SIMPLEX]: { call: "simplex" },
    [SLOP.FBM]: { call: "fbm" },
    [SLOP.SDF]: { call: "sdf" },
    [SLOP.VORONOI]: { call: "voronoi" },
    [SLOP.TURBULENCE]: { call: "turbulence" },
    [SLOP.RIDGED]: { call: "ridged" },

    [SLOP.SAMPLE]: { call: "tex2D" },
    [SLOP.SAMPLE_LOD]: { call: "tex2Dlod" },
}

/**
 * Opcodes no backend implements.
 *
 * Numbered so the families stay in order, and refused at the surface until
 * somebody writes both halves. A program reaching one would render as whatever
 * the VM's dispatch falls through to and fail outright in the HLSL emitter,
 * which is the silent-disagreement failure this design exists to prevent, so
 * the parser names them rather than treating them as unknown identifiers.
 *
 * `REMAP` is here because the opcode is unimplemented; the SURFACE `remap` is a
 * macro over arithmetic and works everywhere.
 */
export const SL_UNIMPLEMENTED: Record<number, string> = {
    [SLOP.RGB2HSV]: "neither the VM shader nor the HLSL emitter has a case for it",
    [SLOP.SAMPLE_LOD]: "the VM samples without an explicit LOD; use tex2D",
    [SLOP.REMAP]: "the surface form is a macro over arithmetic, so the opcode is unused",
}

/**
 * GLSL spellings, recognised only so they can be refused by their HLSL name.
 *
 * Accepting both would be two ways to write everything and a table that has to
 * stay complete in two columns forever (`Specs/SL_TEXT.md` 9.1). Recognising
 * them costs one entry each and turns "unknown identifier mix" into the answer.
 */
export const SL_GLSL_HINT: Record<string, string> = {
    mix: "lerp",
    fract: "frac",
    mod: "%",
    texture: "tex2D",
    textureLod: "tex2Dlod",
    vec2: "float2",
    vec3: "float3",
    vec4: "float4",
    ivec2: "float2",
    ivec3: "float3",
    ivec4: "float4",
    inversesqrt: "1 / sqrt(x); there is no rsqrt opcode",
    atan: "atan2",
    sampler2D: "texture2D",
    gl_FragCoord: "fragCoord",
    gl_FragColor: "the value main returns",
    iTime: "time",
    iResolution: "resolution",
    iMouse: "a uniform you declare",
}

/** Every opcode that an author can write as a call, by the name they write. */
export const SL_CALL_NAMES: Record<string, number> = Object.fromEntries(
    Object.entries(SL_HLSL)
        .filter(([, s]) => s.call !== undefined)
        .map(([code, s]) => [s.call!, Number(code)]),
)
