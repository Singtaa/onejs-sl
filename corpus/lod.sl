// An anchor for tex2Dlod: four bands, left to right, each reading one mip level
// of the goldens' texture. Level 0 is the image and levels 1 to 3 are each one
// solid colour, so a band that read the wrong level shows it.
texture2D t;
float4 main() { return tex2Dlod(t, uv, floor(uv.x * 4)); }
