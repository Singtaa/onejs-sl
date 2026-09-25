// Uniforms at every width and a texture, so the host's slot layout is
// exercised, not only the maths.
texture2D grain;
uniform float amount = 0.6;
uniform float2 offset = float2(0.1, -0.2);
uniform float3 tint = float3(0.9, 0.5, 0.2);
uniform float4 edge = float4(0.2, 0.4, 0.6, 0.8);
float4 main() {
    float g = tex2D(grain, uv * 2.0 + offset).r;
    float e = smoothstep(edge.x, edge.w, uv.x) * edge.y + edge.z * 0.2;
    return float4(tint * (g * amount + e), 1);
}
