// workerd/wrangler import types for the prebuilt Opus artifacts.
// `.wasm` imports resolve to a compiled WebAssembly.Module; the `.cjs` Emscripten glue resolves to
// its module factory function.
declare module '*.wasm' {
	const module: WebAssembly.Module;
	export default module;
}
declare module '*.cjs' {
	const factory: any;
	export default factory;
}
