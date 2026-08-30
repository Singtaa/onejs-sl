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
