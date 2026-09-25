// The whole shader, and nothing that is not the shader.
//
// No Properties block, no SubShader, no CGPROGRAM, no appdata or v2f, no
// _Time.y: `uniform` declares both the slot and the name the sliders bind
// against, and the file IS the fragment function.
uniform float warp = 0.5;
uniform float hue = 0.5;
uniform float speed = 0.5;

float4 main() {
    float t = time * (speed * 1.6 + 0.1);
    float2 p = (uv - 0.5) * (warp * 14 + 2);

    float v = sin(p.x + t)
            + sin(p.y - t * 0.8)
            + sin((p.x + p.y) * 0.7 + t * 1.3);

    float n = saturate(v * 0.22 + 0.5);
    float3 rgb = hsv2rgb(float3(frac(hue + n * 0.18), 0.75, n * 0.7 + 0.25));
    return float4(rgb, 1);
}
