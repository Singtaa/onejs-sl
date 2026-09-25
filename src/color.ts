/**
 * "#rgb", "#rrggbb" or "#rrggbbaa" to 0..1 components.
 *
 * Shared by `sl` and `fx`, so a colour is written the same way in a program
 * and in an image chain and neither has to import the other.
 */
export function parseColor(hex: string): [number, number, number, number] {
    const m = /^#([0-9a-fA-F]{3,8})$/.exec(hex.trim())
    if (m === null) throw new Error(`"${hex}" is not a colour; use #rgb, #rrggbb or #rrggbbaa`)
    const h = m[1]!
    const grab = (i: number, n: number) => parseInt(n === 1 ? h[i]! + h[i]! : h.slice(i * 2, i * 2 + 2), 16) / 255
    if (h.length === 3) return [grab(0, 1), grab(1, 1), grab(2, 1), 1]
    if (h.length === 6) return [grab(0, 2), grab(1, 2), grab(2, 2), 1]
    if (h.length === 8) return [grab(0, 2), grab(1, 2), grab(2, 2), grab(3, 2)]
    throw new Error(`"${hex}" is not a colour; use #rgb, #rrggbb or #rrggbbaa`)
}
