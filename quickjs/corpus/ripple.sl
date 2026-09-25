// Every pixel of the surface runs this function, at once, on the GPU.
//
// uv says where this pixel is, 0 to 1 across the surface. time is the clock.
// `uniform` is the wire back to JavaScript: declare one here and its name is
// what the uniforms prop accepts, checked against the .d.ts the build writes
// beside this file.
uniform float spread = 0.4;

float4 main() {
    float d = length(uv - 0.5);
    float wave = sin(d * 44 - time * 3) * 0.5 + 0.5;
    float ring = wave * smoothstep(0.55, 0.0, d) * (spread * 0.9 + 0.1);
    return float4(lerp(float3(0.05, 0.06, 0.09), float3(0.42, 0.78, 1.0), ring), 1);
}
