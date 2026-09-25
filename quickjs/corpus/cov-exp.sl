// atan2, exp, log and sqrt over continuous inputs, clear of atan2's seam.
float4 main() {
    float2 q = (uv - 0.5) * 2.0;
    float c = atan2(q.y + 0.013, q.x + 0.021) * 0.15 + exp(q.x) * 0.1;
    float d = log(q.y + 2.0) * 0.3 + sqrt(q.x + 1.0) * 0.2;
    return float4(saturate(c * 0.5 + 0.5), saturate(d), 0.5, 1);
}
