/**
 * The manifest an app writes so an editor can compile its programs.
 *
 * Phase 4 of `Specs/SHADER_LANG.md`. Programs are recorded when JavaScript runs,
 * so nothing on the Unity side can find them by reading source. The app's build
 * writes this instead, and `SLShaderGenerator` turns each entry into a `.shader`
 * that Unity compiles like any other asset.
 *
 * The split is deliberate: the emitter, which is the part with interesting
 * logic, stays in TypeScript where it is unit tested, and the editor side stays
 * ignorant of JavaScript.
 *
 *     import { writeFileSync } from "node:fs"
 *     import { manifest } from "onejs-unity/sl"
 *     writeFileSync("app.sl.json", JSON.stringify(manifest([plasma, glow])))
 */

import type { Program } from "./ir"
import { emitShader } from "./hlsl"

export interface ManifestEntry {
    hash: string
    hlsl: string
    /** Uniform names in slot order, so a host can bind them by name. */
    uniforms: string[]
}

export interface ProgramManifest {
    version: 1
    programs: ManifestEntry[]
}

/**
 * Builds a manifest from programs.
 *
 * Duplicates collapse by hash rather than erroring: two programs with the same
 * hash ARE the same program, since the hash is over the graph's shape. That
 * matters for a real app, where a shared helper returning a program can easily
 * be called from several places.
 */
export function manifest(programs: Program[]): ProgramManifest {
    const seen = new Map<string, ManifestEntry>()
    for (const p of programs) {
        if (seen.has(p.hash)) continue
        seen.set(p.hash, {
            hash: p.hash,
            hlsl: emitShader(p),
            uniforms: p.uniforms.map((u) => u.name),
        })
    }
    // Sorted by hash so the file does not churn when declaration order changes.
    // A manifest that rewrote itself on every build would dirty the generated
    // shaders and make Unity recompile all of them for nothing.
    return { version: 1, programs: [...seen.values()].sort((a, b) => a.hash.localeCompare(b.hash)) }
}
