// Every noise: value, simplex, fbm, turbulence, ridged, voronoi.
float4 main() {
    float2 p = uv * 5.0 + time * 0.1;
    float a = noise(p) * 0.5 + simplex(p * 1.3) * 0.5;
    float b = fbm(p, 3) * 0.5 + turbulence(p * 0.7, 2) * 0.5;
    float c = ridged(p * 0.6, 4) * 0.6 + voronoi(p * 1.5) * 0.4;
    return float4(a, b, c, 1);
}
