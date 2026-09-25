/**
 * Shape names and ids for `sl.sdf`.
 *
 * A SECOND COPY of `fx/sdf.ts`'s table, deliberately, and guarded by a test
 * that compares the two.
 *
 * The eject scaffold vendors each onejs-unity module a game uses into a
 * self-contained folder, rewriting `"onejs-unity/<mod>"` specifiers as it goes.
 * It does not rewrite relative paths across modules, and it refuses outright
 * rather than shipping a scaffold that cannot build. So `sl` importing
 * `../fx/sdf` would have produced an ejected project that fails to compile, for
 * a table of forty-two integers.
 *
 * Duplicating and pinning is the trade this repository already makes for the
 * painter and particle opcode tables, and for the SDF dispatcher that exists in
 * both FxSources and SLCommon. The ids are a contract with SDF2D.cginc either
 * way; what matters is that a test fails when they drift, not that there is
 * only one copy.
 */
export const SL_SDF_SHAPES = {
    circle: 0, roundedBox: 1, box: 2, orientedBox: 3, segment: 4, rhombus: 5,
    trapezoid: 6, parallelogram: 7, equilateralTriangle: 8, triangleIsosceles: 9,
    triangle: 10, unevenCapsule: 11, pentagon: 12, hexagon: 13, octagon: 14,
    hexagram: 15, star5: 16, star: 17, pie: 18, cutDisk: 19, arc: 20, ring: 21,
    horseshoe: 22, vesica: 23, orientedVesica: 24, moon: 25, roundedCross: 26,
    egg: 27, heart: 28, cross: 29, roundedX: 30, ellipse: 31, parabola: 32,
    parabolaSegment: 33, bezier: 34, blobbyCross: 35, tunnel: 36, stairs: 37,
    quadraticCircle: 38, hyperbola: 39, coolS: 40, circleWave: 41,
} as const

export type SlSdfKind = keyof typeof SL_SDF_SHAPES

/**
 * How many parameters each shape reads, in the order SDF2D.cginc takes them
 * (its `a` then `b`). Six shapes take more than four: roundedBox's last two
 * corner radii, orientedBox's thickness, triangle's third vertex, horseshoe's
 * second width, orientedVesica's width and bezier's end point. `sl.sdf` takes
 * up to this many, and a test derives the same counts from the web emitters'
 * call table, so the two cannot drift.
 */
export const SL_SDF_PARAMS: Record<SlSdfKind, number> = {
    circle: 1, roundedBox: 6, box: 2, orientedBox: 5, segment: 4, rhombus: 2,
    trapezoid: 3, parallelogram: 3, equilateralTriangle: 1, triangleIsosceles: 2,
    triangle: 6, unevenCapsule: 3, pentagon: 1, hexagon: 1, octagon: 1,
    hexagram: 1, star5: 2, star: 3, pie: 3, cutDisk: 2, arc: 4, ring: 4,
    horseshoe: 5, vesica: 2, orientedVesica: 5, moon: 3, roundedCross: 1,
    egg: 4, heart: 0, cross: 3, roundedX: 2, ellipse: 2, parabola: 1,
    parabolaSegment: 2, bezier: 6, blobbyCross: 1, tunnel: 2, stairs: 3,
    quadraticCircle: 0, hyperbola: 2, coolS: 0, circleWave: 2,
}
