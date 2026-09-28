/**
 * 浏览器端 bundle 的 stub-loader 夹具。
 *
 * `src/client.js` 是传统 `<script src>` 加载的手写 bundle：它不能写静态 `import`，
 * 只在加载时调用 `window.__ModuleLoader__.load({ id, factory })`，由宿主把
 * `factory` 物化。所以想在 Node 里拿到它的导出，只能自己扮一次宿主：
 *
 * 1. 装上 `window` / `document` 桩，读源码后用 `new Function(source)()` 执行；
 * 2. 从 `load` 的入参里截下注册项，再调用 `registration.factory(requireStub)`；
 * 3. `requireStub` 只认 `"react"`——factory 拿到的 `require` 不认相对路径，
 *    这也是这份测试不拆分 `client.js`、不新建共享模块的原因。
 *
 * 默认在返回前恢复全局桩。组件测试在调用组件时还需要 `window` / `document` /
 * `fetch`，可以传 `keepStubs: true`，并用 `t.after(restore)` 收尾。
 *
 * @module usage-ledger/test/client-harness
 */

import { readFile } from "node:fs/promises";

/** `src/client.js` 的位置。 */
const CLIENT_URL = new URL("../src/client.js", import.meta.url);

/** 需要临时顶掉的全局名。 */
const GLOBAL_KEYS = ["window", "document", "fetch"];

/** 源码只读一次；每个用例仍会重新执行一遍，模块级状态因此互不串味。 */
let sourcePromise = null;

/**
 * 读取 bundle 源码（带缓存）。
 *
 * @returns 源码文本。
 */
function clientSource() {
	sourcePromise ??= readFile(CLIENT_URL, "utf8");
	return sourcePromise;
}

/**
 * 造一个最小 React 桩。
 *
 * `createElement` 只返回普通对象，不做真实渲染；`useState` / `useRef` /
 * `useCallback` 返回初值，于是组件能在**不渲染**的情况下跑完并交出元素树。
 *
 * `useEffect` **立刻执行再立刻清理**：`useUsage` 的数据预取挂在副作用里，
 * 不执行就永远拿不到缓存；立刻清理则避免 `setInterval` 与 `AbortController`
 * 留在进程里。
 *
 * @returns React 桩。
 */
export function createReactStub() {
	return {
		createElement: (type, props, ...children) => ({
			$$typeof: Symbol.for("react.element"),
			type,
			props: { ...(props ?? {}), children },
		}),
		useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
		useEffect: (effect) => {
			const cleanup = effect();
			if (typeof cleanup === "function") cleanup();
		},
		useRef: (value) => ({ current: value }),
		useCallback: (callback) => callback,
	};
}

/**
 * 造 factory 的 `require` 桩。
 *
 * 只认 `"react"`：client.js 一旦多 require 一个包，这里会立刻报错，而不是
 * 悄悄拿到 `undefined`（那正是整个插槽静默崩溃的起点）。
 *
 * @param react - React 桩。
 * @returns `require` 函数。
 */
function makeRequire(react) {
	return (spec) => {
		if (spec === "react") return react;
		throw new Error(`require 桩不认识 "${spec}"：src/client.js 只允许 require("react")`);
	};
}

/**
 * 记下全局桩之前的取值，供恢复时用。
 *
 * @returns 每个键的 `{key, had, value}`。
 */
function snapshotGlobals() {
	return GLOBAL_KEYS.map((key) => ({
		key,
		had: Object.prototype.hasOwnProperty.call(globalThis, key),
		value: globalThis[key],
	}));
}

/**
 * 载入 `src/client.js` 并交出它的导出。
 *
 * @param options - `{fetch, keepStubs, react, source}`；`fetch` 会替换
 *   `globalThis.fetch`，`source` 可换成一段假 bundle 用来测夹具自身的契约，
 *   `keepStubs` 为 true 时保留全局桩（调用方必须自己调 `restore`）。
 * @returns `{exports, registration, react, fetchCalls, window, restore}`。
 */
export async function loadClient(options = {}) {
	const { fetch: fetchImpl = null, keepStubs = false, react = createReactStub(), source: injected = null } = options;
	const source = injected ?? (await clientSource());
	const previous = snapshotGlobals();
	const fetchCalls = [];

	/** 截获的注册项。 */
	let registration = null;

	const windowStub = {
		__ModuleLoader__: {
			load(entry) {
				registration = entry;
			},
		},
		addEventListener() {},
		removeEventListener() {},
		localStorage: {
			store: new Map(),
			getItem(key) {
				return this.store.has(key) ? this.store.get(key) : null;
			},
			setItem(key, value) {
				this.store.set(key, String(value));
			},
			removeItem(key) {
				this.store.delete(key);
			},
		},
	};

	globalThis.window = windowStub;
	globalThis.document = {
		getElementById: () => null,
		createElement: () => ({ id: "", textContent: "" }),
		head: { append() {} },
	};
	if (fetchImpl !== null) {
		globalThis.fetch = (...args) => {
			fetchCalls.push(args);
			return fetchImpl(...args);
		};
	}

	let restored = false;

	/** 恢复全局桩；重复调用无副作用。 */
	const restore = () => {
		if (restored) return;
		restored = true;
		for (const { key, had, value } of previous) {
			if (had) globalThis[key] = value;
			else delete globalThis[key];
		}
	};

	try {
		new Function(source)();
		if (registration === null) throw new Error("bundle 没有调用 window.__ModuleLoader__.load");
		const exports = registration.factory(makeRequire(react));
		// factory 必须显式返回 module.exports，否则宿主会抛
		// `invalid plugin ... received undefined`，整个 Web 界面起不来。
		if (exports === undefined) throw new Error("factory 返回 undefined：模块契约被破坏");
		return { exports, registration, react, fetchCalls, window: windowStub, restore };
	} finally {
		if (!keepStubs) restore();
	}
}

/**
 * 遍历元素树。
 *
 * 函数组件会被就地调用——我们不做真实渲染，但组件返回值就是它该渲染出的子节点。
 *
 * @param node - 元素、数组或文本。
 * @param onElement - 每个元素节点回调。
 * @param onText - 每段文本回调。
 */
function walk(node, onElement, onText) {
	if (node === null || node === undefined || typeof node === "boolean") return;
	if (typeof node === "string" || typeof node === "number") {
		onText(String(node));
		return;
	}
	if (Array.isArray(node)) {
		for (const child of node) walk(child, onElement, onText);
		return;
	}
	onElement(node);
	if (typeof node.type === "function") {
		walk(node.type(node.props ?? {}), onElement, onText);
		return;
	}
	walk(node.props?.children ?? null, onElement, onText);
}

/**
 * 把元素树里所有文本拼起来。
 *
 * @param node - 元素树。
 * @returns 拼接后的文本。
 */
export function textOf(node) {
	const parts = [];
	walk(node, () => {}, (text) => parts.push(text));
	return parts.join("");
}

/**
 * 找出所有满足条件的元素节点。
 *
 * @param node - 元素树。
 * @param predicate - 判定函数。
 * @returns 命中的元素数组。
 */
export function findAll(node, predicate) {
	const found = [];
	walk(node, (element) => {
		if (predicate(element)) found.push(element);
	}, () => {});
	return found;
}

/**
 * 找出所有 `className` 精确匹配的元素。
 *
 * @param node - 元素树。
 * @param className - 类名。
 * @returns 命中的元素数组。
 */
export function findAllByClass(node, className) {
	return findAll(node, (element) => element.props?.className === className);
}
