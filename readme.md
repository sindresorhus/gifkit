# gifkit

> Encode, decode, and render GIF files

This package is a small JavaScript GIF toolkit. It can decode GIF87a/GIF89a files into structured blocks, encode structured GIF descriptions back to bytes, and render image blocks to RGBA pixels.

## Install

```sh
npm install @sindresorhus/gifkit
```

## Usage

```js
import {decodeAnimatedGIF, encodeAnimatedGIF} from '@sindresorhus/gifkit';

const bytes = encodeAnimatedGIF(frames, {
	width: 640,
	height: 480,
	fps: 14,
	playCount: 5,
	quality: 0.7,
});

const animation = decodeAnimatedGIF(bytes);

console.log(animation.frames[0].pixels);
console.log(animation.frames[0].delay);
```

> [!NOTE]
> If you accept untrusted input in a server context, it's up to you to enforce limits like timeouts and memory usage.

## Common recipes

### Encode RGBA frames to a GIF

```js
import {encodeAnimatedGIF} from '@sindresorhus/gifkit';

const bytes = encodeAnimatedGIF(frames, {
	width: 640,
	height: 480,
	fps: 14,
	playCount: 5,
	quality: 0.7,
});
```

GIF stores frame timing in 0.01 second increments, so `fps` and `delay` values are rounded.

For photos and screenshots, keep the default `quality` or lower it. Use `quality: 1` only when every frame already has at most 256 exact colors.

### Decode a GIF to RGBA frames

```js
import {decodeAnimatedGIF} from '@sindresorhus/gifkit';

const animation = decodeAnimatedGIF(bytes);

console.log(animation.width);
console.log(animation.height);
console.log(animation.frames[0].pixels);
console.log(animation.frames[0].delay);
```

### Decode and encode again

```js
import {decodeAnimatedGIF, encodeAnimatedGIF} from '@sindresorhus/gifkit';

const animation = decodeAnimatedGIF(bytes);

const options = {
	width: animation.width,
	height: animation.height,
};

if (animation.playCount !== undefined) {
	options.playCount = animation.playCount;
}

const newBytes = encodeAnimatedGIF(animation.frames, options);
```

### Use per-frame delays

```js
import {encodeAnimatedGIF} from '@sindresorhus/gifkit';

const bytes = encodeAnimatedGIF([
	{pixels: frame1, delay: 0.1},
	{pixels: frame2, delay: 0.2},
], {
	width: 640,
	height: 480,
	playCount: 5,
	quality: 0.7,
});
```

## API

### `decodeGIF(inputBytes, options?)`

Decodes a `Uint8Array` containing a GIF file and returns a structured GIF object with logical-screen metadata, extension blocks, image blocks, color tables, and decoded indexed pixels.

Options:

- `strict` - Default: `true`. Reject reserved bits, malformed extension sequencing, and trailing bytes. Use `false` for best-effort decoding.

Decoding enforces internal pixel, block-count, data sub-block-count, and data payload byte limits to avoid resource exhaustion.

### `decodeAnimatedGIF(inputBytes, options?)`

Decodes an animated GIF to rendered full-frame RGBA frames. This is the easiest API when you want image buffers and frame timing instead of GIF internals.

```js
import {decodeAnimatedGIF} from '@sindresorhus/gifkit';

const animation = decodeAnimatedGIF(bytes);

console.log(animation.width);
console.log(animation.height);
console.log(animation.playCount);
console.log(animation.frames[0].pixels);
console.log(animation.frames[0].delay);
```

Returns:

- `width` / `height` - Logical screen size.
- `playCount` - Total animation plays. `'forever'` means infinite playback. Omitted when no loop extension was present.
- `frames` - Rendered full-frame RGBA frames.
- `frames[].pixels` - `Uint8ClampedArray` of flat RGBA bytes: `[red, green, blue, alpha, ...]`.
- `frames[].delay` - Frame delay in seconds. GIF stores delays in 0.01 second increments.

Options:

- `background` - Default: `'transparent'`. Use `'gif'` to render the logical-screen background color.
- `strict` - Default: `true`. Reject malformed decode data and render data like color indexes outside the active color table. Use `false` for best-effort decoding and rendering.

### `encodeAnimatedGIF(frames, options)`

Encodes RGBA frames as an animated GIF. This is the easiest API when you have a list of image buffers and want a normal animation.

```js
import {encodeAnimatedGIF} from '@sindresorhus/gifkit';

const bytes = encodeAnimatedGIF(frames, {
	width: 640,
	height: 480,
	fps: 14,
	playCount: 5,
	quality: 0.7,
});
```

Options:

- `width` / `height` - Required. Frame size.
- `fps` - Frames per second for uniform timing. Cannot be combined with per-frame `delay`. GIF stores delays in 0.01 second increments, so timing is rounded to the nearest increment.
- `playCount` - Total animation plays. Finite values must be integers from `1` to `65_536`. Use `'forever'` for infinite playback. Omit it to omit the loop extension. `playCount: 1` also omits the loop extension because that matches default GIF playback.
- `quality` - Default: `0.8`. `0...1`, where lower values quantize each frame more aggressively to fit GIF’s 256-color palette. Quantization is per-frame and does not dither. For photos and screenshots, keep the default or lower it. Use `1` only when every frame already has at most 256 exact colors.

Frames can be `Uint8Array` or `Uint8ClampedArray` RGBA pixels. Pixels are flat RGBA bytes: `[red, green, blue, alpha, ...]`.

For per-frame timing, use frame objects with `pixels` and `delay` in seconds. Delays are rounded to GIF’s 0.01 second increments:

```js
const bytes = encodeAnimatedGIF([
	{pixels: frame1, delay: 0.1},
	{pixels: frame2, delay: 0.2},
], {
	width: 640,
	height: 480,
	playCount: 5,
	quality: 0.7,
});
```

### `encodeGIF(gif)`

Encodes a structured GIF object to a `Uint8Array`. Use `image` blocks when you already have indexed pixels and a palette. Use `rgbaImage` blocks when you have flat RGBA bytes that fit GIF’s 256-color model.

The `gif` object has this shape:

- `width` / `height` - Required. Logical screen size.
- `globalColorTable` - Optional. Global palette as flat RGB bytes (`[red, green, blue, ...]`), a `Uint8Array`, or RGB triplets (`[[red, green, blue], ...]`).
- `backgroundColorIndex` - Optional. Palette index used as the logical-screen background color. Requires `globalColorTable`.
- `playCount` - Total animation plays. Finite values must be integers from `1` to `65_536`. Use `'forever'` for infinite playback. Omit it to omit the loop extension. `playCount: 1` also omits the loop extension because that matches default GIF playback.
- `blocks` - Structured GIF blocks in file order.

Encoded GIFs are always written as GIF89a.

Block types:

- Indexed image block: `{type: 'image', width, height, pixels, colorTable?}`. `pixels` is one palette index per pixel and uses the image `colorTable` or GIF `globalColorTable`. `left` and `top` are optional image offsets and default to `0`. Advanced fields include `isInterlaced`.
- RGBA image block: `{type: 'rgbaImage', width, height, pixels}`. `pixels` is flat RGBA bytes: `[red, green, blue, alpha, ...]`. gifkit builds a color table from the pixels, so this only works when the image has at most 256 colors and alpha values are fully transparent or fully opaque. `transparentColor` is the RGB palette value stored for transparent pixels.
- Graphic control metadata for an image block: `graphicControlExtension: {disposalMethod?, delay?, transparentColorIndex?}`. `delay` is in seconds. `transparentColorIndex` is a palette index, or `undefined` for no transparent color. `disposalMethod` is exposed so structured GIF data can be preserved or re-encoded. It controls what happens to the current frame’s pixels before the next frame is drawn: `'unspecified'` leaves the choice to the decoder, `'keep'` keeps the pixels, `'restoreBackground'` clears them to the background, and `'restorePrevious'` restores the previous canvas. Rendered pixels already have this applied, so most users do not need to read or set it.
- Comment extension: `{type: 'commentExtension', data}`. Strings must be ASCII.
- Application extension: `{type: 'applicationExtension', identifier, authenticationCode, data?}`. `authenticationCode` accepts a 3-byte string or byte array. Decoded Netscape loop extensions also expose `isNetscapeLoopingExtension` and `playCount`. When encoding an explicit Netscape application extension block, finite `playCount` values must be from `2` to `65_536` because `1` is represented by omitting the loop extension.

Encoding enforces internal pixel, block-count, encode work cost, data payload byte, and total encoded byte limits to avoid resource exhaustion.

Extension payload strings must contain only ASCII characters. Use `Uint8Array` for binary extension data.

### `renderGIFFrameSequence(gif, options?)`

Renders image blocks as an iterable sequence of full logical-screen RGBA frames while applying transparency and disposal methods. Use this for playback or large GIFs where materializing every rendered frame would be wasteful.

```js
import {decodeGIF, renderGIFFrameSequence} from '@sindresorhus/gifkit';

const gif = decodeGIF(bytes, {strict: false});

for (const frame of renderGIFFrameSequence(gif, {strict: false})) {
	console.log(frame.pixels);
	console.log(frame.delay);
}
```

Options:

- `background` - Default: `'gif'`. Use `'transparent'` to render the logical-screen background as transparent.
- `strict` - Default: `true`. Reject malformed render data like color indexes outside the active color table.
- `repeat` - Default: `true`. Repeat according to GIF `playCount` metadata. Missing metadata means one pass, a finite number means that many total passes, and `'forever'` means infinite playback. Set to `false` to render exactly one pass.
- `signal` - Optional abort signal. When aborted, iteration ends.

Yields:

- `left` / `top` - Frame source offset in logical-screen pixels.
- `width` / `height` - Frame source size.
- `delay` - Frame delay in seconds.
- `disposalMethod` - Advanced GIF compositing metadata kept so rendered frames can still be related back to the original GIF structure.
- `pixels` - `Uint8ClampedArray` of rendered full logical-screen RGBA bytes.
- `index` - Zero-based image-frame index within the current pass.
- `loopIndex` - Zero-based repetition index for this frame.

### `renderGIFFrames(gif, options?)`

Renders image blocks to full logical-screen RGBA frames while applying transparency and disposal methods. Most users should use `decodeAnimatedGIF()` instead; use this when you need decoded GIF structure and rendered pixels.

Options:

- `background` - Default: `'gif'`. Use `'transparent'` to render the logical-screen background as transparent.
- `strict` - Default: `true`. Reject malformed render data like color indexes outside the active color table.

Returns:

- `width` / `height` - Logical screen size.
- `playCount` - Total animation plays. `'forever'` means infinite playback. Omitted when no loop extension was present.
- `frames` - Rendered full logical-screen RGBA frames.
- `frames[].left` / `frames[].top` - Frame source offset in logical-screen pixels.
- `frames[].width` / `frames[].height` - Frame source size.
- `frames[].delay` - Frame delay in seconds.
- `frames[].disposalMethod` - Advanced GIF compositing metadata kept so rendered frames can still be related back to the original GIF structure. `'unspecified'` leaves the choice to the decoder, `'keep'` keeps the pixels, `'restoreBackground'` clears them to the background, and `'restorePrevious'` restores the previous canvas before the next frame is drawn. gifkit already applies this when producing `frames[].pixels`, so use it only if you need to inspect or preserve the original animation metadata.
- `frames[].pixels` - `Uint8ClampedArray` of rendered full logical-screen RGBA bytes.

Rendering enforces internal logical-screen, rendered-output, render block-count, and image-block pixel limits to avoid huge allocations.

### `indexedImage(pixels, options?)`

Use this when you have raw RGBA pixels, for example from a canvas or image decoder, and want the `pixels` and `colorTable` needed for an image block. It only works when the pixels already fit GIF’s palette model.

Converts RGBA pixels to GIF indexed pixels and a power-of-two color table without quantizing or dithering. Each unique opaque RGB color becomes a palette entry. All fully transparent pixels share one palette entry and set `transparentColorIndex`.

Throws if the image exceeds the internal pixel limit, uses more than 256 palette entries, or uses partial alpha. GIF only supports fully transparent or fully opaque pixels.

Options:

- `transparentColor` - Default: `[0, 0, 0]`. RGB value stored in the palette entry used for transparent pixels.

```js
import {indexedImage} from '@sindresorhus/gifkit';

const image = indexedImage(new Uint8ClampedArray([
	255, 0, 0, 255,
	0, 0, 0, 0,
]));

console.log(image.pixels);
console.log(image.colorTable);
```

## Intentionally unsupported GIF spec features

gifkit focuses on GIF features that are useful in modern JavaScript workflows. It intentionally does not expose the GIF user-input flag, pixel aspect ratio byte, color-resolution metadata, color-table sort flags, or Plain Text Extension rendering/encoding. These are legacy display-era features, are rarely present in real GIFs, and are easy to misunderstand. Unknown extensions, including Plain Text Extensions, are preserved as `unknownExtension` blocks.
