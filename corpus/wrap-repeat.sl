// An anchor for [Wrap(Repeat)]: the goldens' texture tiled three times each
// way, which the host binds clamped. A texture held at its edge shows as
// stripes, and a seam at a tile edge as a hard line where the filter should
// have blended the last column into the first.
[Wrap(Repeat)] texture2D t;
float4 main() { return tex2D(t, uv * 3 - 1); }
