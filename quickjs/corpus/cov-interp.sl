// lerp, step, smoothstep with its edges both ways round, and ?:.
float4 main() {
    float a = smoothstep(0.2, 0.8, uv.x);
    float b = smoothstep(0.7, 0.3, uv.y);
    float3 m = lerp(float3(0.1, 0.2, 0.9), float3(0.9, 0.6, 0.1), a);
    float s = step(0.5, uv.y);
    float3 c = uv.x > 0.3 ? m : float3(b, s, 0.5);
    return float4(c, 1);
}
