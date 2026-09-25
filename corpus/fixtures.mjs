/**
 * The corpus as `{ name: source }`: every `.sl` file here, then one program per
 * distance shape at its full parameter count. The QuickJS run and the goldens
 * both read it from here, so the two cannot cover different programs.
 */
import fs from "node:fs"
import path from "node:path"

const HERE = import.meta.dirname

/**
 * Ordinary sizes for every shape, at its FULL parameter count (#129): a shape
 * given generic numbers can be degenerate (star with 0.2 points) and then draws
 * noise that agrees with nothing. The same values as OneJS's parity harness.
 */
const SHAPE_PARAMS = {
    circle: [0.35], roundedBox: [0.3, 0.2, 0.05, 0.1, 0.15, 0.02], box: [0.3, 0.2],
    orientedBox: [-0.3, -0.2, 0.3, 0.2, 0.1], segment: [-0.3, -0.2, 0.3, 0.25], rhombus: [0.35, 0.2],
    trapezoid: [0.3, 0.15, 0.25], parallelogram: [0.25, 0.2, 0.1], equilateralTriangle: [0.3],
    triangleIsosceles: [0.25, 0.4], triangle: [-0.3, -0.2, 0.3, -0.2, 0.0, 0.35], unevenCapsule: [0.15, 0.08, 0.35],
    pentagon: [0.3], hexagon: [0.3], octagon: [0.3], hexagram: [0.2], star5: [0.35, 0.5], star: [0.35, 6, 3],
    pie: [0.717, 0.697, 0.35], cutDisk: [0.35, 0.1], arc: [0.932, 0.362, 0.3, 0.05], ring: [0.8, 0.6, 0.3, 0.06],
    horseshoe: [0.362, 0.932, 0.3, 0.05, 0.08], vesica: [0.4, 0.25], orientedVesica: [-0.3, -0.1, 0.3, 0.1, 0.12],
    moon: [0.2, 0.35, 0.28], roundedCross: [0.5], egg: [0.3, 0.2, 0.08, 0.7], heart: [], cross: [0.35, 0.1, 0.02],
    roundedX: [0.4, 0.05], ellipse: [0.35, 0.2], parabola: [2], parabolaSegment: [0.3, 0.3],
    bezier: [-0.3, -0.2, 0.0, 0.4, 0.3, -0.2], blobbyCross: [0.6], tunnel: [0.25, 0.3], stairs: [0.1, 0.08, 4],
    quadraticCircle: [], hyperbola: [0.05, 0.3], coolS: [], circleWave: [0.5, 0.2],
}

/** Bands of one shape's distance, so a wrong distance anywhere in the frame shows. */
export function shapeSource(kind, params) {
    const args = ["p", ...params.map((v) => (Number.isInteger(v) ? v.toFixed(1) : String(v)))].join(", ")
    return `float4 main() {
    float2 p = (uv - 0.5) * 1.2;
    float d = sdf.${kind}(${args});
    return float4(0.5 + 0.5 * cos(d * 40.0), 0.5 + 0.5 * sin(d * 23.0), saturate(0.5 - d * 2.0), 1);
}`
}

/**
 * `counts` is SL_SDF_PARAMS, passed in so this file needs no TypeScript, and
 * checked: a shape added to the language without sizes here is refused, not
 * skipped.
 */
export function fixtureSources(counts) {
    const out = {}
    for (const f of fs.readdirSync(HERE).filter((f) => f.endsWith(".sl")).sort()) {
        out[f] = fs.readFileSync(path.join(HERE, f), "utf8").replace(/\r\n/g, "\n")
    }
    for (const [kind, count] of Object.entries(counts)) {
        const params = SHAPE_PARAMS[kind]
        if (params === undefined || params.length !== count) {
            throw new Error(`corpus/fixtures.mjs has ${params?.length ?? "no"} parameters for sdf.${kind}, which takes ${count}`)
        }
        out[`sdf-${kind}.sl`] = shapeSource(kind, params)
    }
    return out
}
