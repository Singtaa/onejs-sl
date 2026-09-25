/** One function of the helper library, as `lib/generate.ts` records it. */
export interface LibFunction {
    name: string
    /** Parameter types, HLSL spelling: `float`, `float2`, `int`... */
    params: readonly string[]
    ret: string
    /** Its WGSL name: an overloaded name carries its signature there, since WGSL has no overloading. */
    wgsl: string
    /** Indices of the functions it calls, all earlier in the list. */
    deps: readonly number[]
    /** Written once per colour space (`#ifdef UNITY_COLORSPACE_GAMMA`). */
    colour: boolean
}

/**
 * How a shape's parameters reach its function: each argument after the point
 * is a list of indices into `[a.x, a.y, a.z, a.w, b.x, b.y]`, or `{ int: i }`
 * for an integer parameter.
 */
export interface SdfCall {
    fn: string
    args: ReadonlyArray<readonly number[] | { int: number }>
}
