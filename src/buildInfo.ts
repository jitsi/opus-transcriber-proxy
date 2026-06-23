// Build-time information baked into the bundle.
//
// `__GIT_HASH__` is replaced at bundle time by esbuild (see build.mjs) with the git commit the
// build was made from. When running unbundled (tsx dev), the identifier is undefined, so we fall
// back to the GIT_HASH env var and finally to 'dev'. This makes the running commit observable at
// runtime regardless of how the image was built (docker:build or wrangler/Cloudflare).
declare const __GIT_HASH__: string;

export const GIT_HASH: string =
	typeof __GIT_HASH__ !== 'undefined' ? __GIT_HASH__ : process.env.GIT_HASH || 'dev';
