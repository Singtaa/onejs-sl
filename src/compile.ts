/**
 * `onejs-sl/compile`: a program as what a host needs to draw it.
 *
 * Its hash, its uniform and texture names in slot order, its declared defaults,
 * and the program printed for each compiler that draws it: HLSL for a Unity
 * editor to generate a shader from, WGSL and GLSL ES 3.00 for a browser to
 * compile on Unity's own device.
 *
 * There is no budget: every backend is a real compiler, so a long program
 * costs what it costs, as any shader does. The caps on uniforms and textures
 * are the only refusal (`checkCaps`).
 */

import { checkCaps, type Program } from "./ir"
import { emitShader } from "./hlsl"
import { emitGLSL, emitWGSL } from "./web"
import { uniformDefaults } from "./sl"

export interface Compiled {
    /** The program's own hash: what a host finds its compiled shader by. */
    hash: string
    /**
     * Uniform names in SLOT ORDER, so a host can set one by name.
     *
     * Every backend addresses a uniform by slot. Without the names the host had
     * a name from the game and no way to turn it into a slot, so it set a
     * material property instead and every uniform stayed at zero.
     */
    uniforms: string[]
    /**
     * Declared uniform defaults, four floats per slot in slot order.
     *
     * The generated shader writes these into its Properties block, so a
     * compiled material starts at them, while the web host's uniform array
     * starts at zero. Without carrying them across, an unset uniform was its
     * default in the editor and 0 in the browser: one program, two pictures,
     * nothing to see in either. The host seeds these right after binding and
     * lets the caller's own `uniforms` write over them.
     */
    defaults: number[]
    /**
     * Texture names in SLOT order, so a host can bind one by name.
     *
     * The generated shader declares `_Tex0` and the web host binds by slot, so
     * a host handed the name an author wrote had no way to reach either.
     * Setting a material property called `grain` bound nothing, silently.
     */
    textures: string[]
    /**
     * The program as HLSL, for a host that can compile it.
     *
     * Lazy, and absent from enumeration: in Play nothing ever reads it, so the
     * emitter never runs there. In an editor the host asks for it once per
     * program it has no compiled shader for, records it, and generates the
     * shader, which is how a game ends up compiled without anybody writing a
     * manifest.
     */
    readonly hlsl: string
    /**
     * The program as WGSL and as GLSL ES 3.00, for a browser to compile on
     * Unity's own device (WebGPU and WebGL2 respectively). Lazy and absent
     * from enumeration like `hlsl`: a `.sl` import carries them as plain
     * strings from the build instead, and a host reads only the one its
     * backend needs.
     */
    readonly wgsl: string
    readonly glsl: string
}

export function compile(program: Program): Compiled {
    checkCaps(program)
    const compiled = {
        hash: program.hash,
        // Slot order, which is declaration order: Builder.uniform pushes and
        // uses the resulting index as the slot.
        uniforms: program.uniforms.map((u) => u.name),
        defaults: uniformDefaults(program),
        textures: program.textures.map((t) => t.name),
    } as Compiled
    let hlsl: string | undefined
    let wgsl: string | undefined
    let glsl: string | undefined
    Object.defineProperty(compiled, "hlsl", {
        enumerable: false,
        get: () => (hlsl ??= emitShader(program)),
    })
    Object.defineProperty(compiled, "wgsl", {
        enumerable: false,
        get: () => (wgsl ??= emitWGSL(program)),
    })
    Object.defineProperty(compiled, "glsl", {
        enumerable: false,
        get: () => (glsl ??= emitGLSL(program)),
    })
    return compiled
}
