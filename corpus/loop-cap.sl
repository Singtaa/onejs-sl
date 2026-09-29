// The turn limit that guarantees every loop stops (Specs/SL_NEXT.md 3b): a
// loop that never ends by itself leaves after 1024 turns on every backend, so
// its count is exact; a loop of continues and a return from inside a loop
// share the frame.
float4 main() {
    int n = 0;
    while (true) { n++; }
    int odd = 0;
    for (int i = 0; i < int(uv.x * 40); i++) {
        if (i % 2 == 0) continue;
        odd++;
    }
    float r = n == 1024 ? 1 : 0;
    float g = float(odd) / 20;
    for (int j = 0; j < 100; j++) {
        if (float(j) > uv.y * 100) return float4(r, g, float(j) / 100, 1);
    }
    return float4(r, g, 1, 1);
}
