// Vector geometry and the colour helpers, toLinear at three widths.
float4 main() {
    float2 q = uv - 0.5;
    float3 n = normalize(float3(q, 0.4));
    float3 r = reflect(float3(0.3, -0.5, -0.8), n);
    float3 c = cross(n, float3(0.0, 1.0, 0.0));
    float d = length(q) + distance(q, float2(0.2, 0.1)) * 0.5 + dot(q, float2(0.7, 0.3));
    float3 h = hsv2rgb(float3(frac(uv.x * 2.0), 0.8, 0.9));
    float l = luminance(h);
    float2 t2 = toLinear(uv);
    float t1 = toLinear(uv.y);
    float3 base = toLinear(float3(r.x * 0.5 + 0.5, c.z * 0.5 + 0.5, d * 0.7));
    return float4(base * l * 0.6 + h * 0.3 + float3(t2 * 0.2, t1 * 0.1), 1);
}
