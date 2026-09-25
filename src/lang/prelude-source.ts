/**
 * The prelude's source, and what an editor reads from it without parsing it.
 *
 * Kept out of `prelude.ts`, which parses it, so that `onejs-sl/tables` can offer
 * the prelude's names and descriptions with no parser in the bundle. Each
 * function's description is the comment above it, so there is one place to
 * write it.
 */

export const PRELUDE_SOURCE = `
// Rotate a point about the origin. Translate first if you want another centre.
float2 rotate(float2 p, float angle) {
    float c = cos(angle);
    float s = sin(angle);
    return float2(p.x * c - p.y * s, p.x * s + p.y * c);
}

// Cartesian to polar: x is the angle in radians, y is the radius.
float2 polar(float2 p) {
    return float2(atan2(p.y, p.x), length(p));
}

// Signed distance to a circle at the origin. Negative inside.
float circle(float2 p, float r) {
    return length(p) - r;
}

// Signed distance to an axis aligned box of the given half extents.
float box(float2 p, float2 size) {
    float2 d = abs(p) - size;
    return length(max(d, 0)) + min(max(d.x, d.y), 0);
}

// Repeat a unit cell n times across the input, centred on zero in each cell.
float2 tile(float2 p, float n) {
    return frac(p * n) - 0.5;
}

// Inigo Quilez's cosine palette. Four float3s in, a colour out, no texture.
float3 palette(float t, float3 a, float3 b, float3 c, float3 d) {
    return a + b * cos(6.28318530718 * (c * t + d));
}
`

/** Each prelude function's name, in the order the source declares them. */
const DECLARED = /* @__PURE__ */ [...PRELUDE_SOURCE.matchAll(/^\/\/ (.+)\n\w+ (\w+)\(/gm)]

export const PRELUDE_NAMES: ReadonlySet<string> = /* @__PURE__ */ new Set(DECLARED.map((m) => m[2]!))

/** Each prelude function's one line description: the comment above it. */
export const PRELUDE_DOCS: Readonly<Record<string, string>> = /* @__PURE__ */ Object.fromEntries(
    DECLARED.map((m) => [m[2]!, m[1]!]),
)
