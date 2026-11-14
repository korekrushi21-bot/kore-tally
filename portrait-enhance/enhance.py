import numpy as np
from PIL import Image, ImageFilter
src = r"C:\Users\NATION~1\AppData\Local\Temp\claude\C--kore-tally\14c1c538-223b-4002-a764-b1aa2b6115e7\images\1.jpg"
out = r"C:\kore tally\portrait-enhance\portrait_enhanced.jpg"
im = Image.open(src).convert("RGB")
W, H = im.size
S = 2  # upscale for 4K-ish delivery
im = im.resize((W*S, H*S), Image.LANCZOS)
a = np.asarray(im).astype(np.float32)/255

# gentle S-curve on luminance (contrast, keeps hue)
def scurve(x, k=0.35):
    return x + k*(x-0.5)*(1-np.abs(2*x-1))*0.9
lum = (0.2126*a[...,0]+0.7152*a[...,1]+0.0722*a[...,2])[...,None]
new = np.clip(scurve(lum), 0, 1)
a = np.clip(a*(new/np.maximum(lum,1e-4))**0.85 + 0*a, 0, 1)

# split tone: warm highlights, cool shadows
l = (0.2126*a[...,0]+0.7152*a[...,1]+0.0722*a[...,2])[...,None]
hi = np.clip((l-0.55)/0.45,0,1); sh = np.clip((0.45-l)/0.45,0,1)
a = a + hi*np.array([0.020,0.008,-0.018]) + sh*np.array([-0.012,0.000,0.020])

# natural saturation (very slight)
l = (0.2126*a[...,0]+0.7152*a[...,1]+0.0722*a[...,2])[...,None]
a = np.clip(l + (a-l)*1.04, 0, 1)
im = Image.fromarray((a*255+0.5).astype(np.uint8))

# micro-contrast + clarity, then fine texture sharpening
im = im.filter(ImageFilter.UnsharpMask(radius=40, percent=18, threshold=0))
im = im.filter(ImageFilter.UnsharpMask(radius=1.4, percent=70, threshold=3))

# subtle film grain (luma only)
rng = np.random.default_rng(7)
g = rng.normal(0, 1, (im.size[1], im.size[0])).astype(np.float32)
g = np.asarray(Image.fromarray(((g*40)+128).clip(0,255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(0.6))).astype(np.float32)-128
b = np.asarray(im).astype(np.float32) + (g/40*3.0)[...,None]
Image.fromarray(b.clip(0,255).astype(np.uint8)).save(out, quality=96, subsampling=0)
print(out, im.size)
