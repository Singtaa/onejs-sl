import { describe, expect, it, vi } from "vitest"

// Move the caps and nothing else. If the builder and the parser each held their
// own 16 and 4, both would still refuse at the real numbers and this would fail.
vi.mock("./ops", async (original) => ({
    ...(await original<typeof import("./ops")>()),
    UNIFORM_SLOTS: 2,
    TEXTURE_SLOTS: 1,
}))

const { sl } = await import("./index")
const { parse } = await import("./lang/index")

function message(f: () => unknown): string {
    try {
        f()
    } catch (e) {
        return (e as Error).message
    }
    throw new Error("expected this to be refused, and it was not")
}

describe("the builder and the parser read one pair of caps", () => {
    it("moves both uniform refusals together", () => {
        const built = message(() => sl.program(() => {
            for (let i = 0; i < 3; i++) sl.uniform.float("u" + i)
            return sl.vec4(0, 0, 0, 1)
        }))
        const parsed = message(() => parse(
            "uniform float u0 = 0;\nuniform float u1 = 0;\nuniform float u2 = 0;\nfloat4 main() { return float4(u0, 0, 0, 1); }",
        ))
        expect(built).toContain("this program declares 3 uniforms and a program may hold 2.")
        expect(parsed).toContain("this file declares 3 uniforms and a program may hold 2.")
    })

    it("moves both texture refusals together", () => {
        const built = message(() => sl.program(({ uv }) => {
            sl.texture("a")
            sl.texture("b")
            return sl.vec4(uv, 0, 1)
        }))
        const parsed = message(() => parse("texture2D a;\ntexture2D b;\nfloat4 main() { return tex2D(a, uv); }"))
        expect(built).toContain("this program declares 2 textures and a program may sample 1.")
        expect(parsed).toContain("this file declares 2 textures and a program may sample 1.")
    })
})
