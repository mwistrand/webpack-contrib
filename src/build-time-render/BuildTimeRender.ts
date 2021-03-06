import { Compiler } from 'webpack';
import { outputFileSync, removeSync, ensureDirSync } from 'fs-extra';

import { join, resolve } from 'path';
import {
	serve,
	getClasses,
	generateBasePath,
	generateRouteInjectionScript,
	getScriptSources,
	getForSelector,
	setupEnvironment,
	getPageStyles,
	getRenderHooks,
	getPageLinks
} from './helpers';

import renderer, { Renderer } from './Renderer';
import * as cssnano from 'cssnano';
const filterCss = require('filter-css');
const webpack = require('webpack');
const postcss = require('postcss');
const clearModule = require('clear-module');
const createHash = require('webpack/lib/util/createHash');
import { parse } from 'node-html-parser';

export interface RenderResult {
	path?: string | BuildTimePath;
	content: string;
	styles: string;
	script: string;
	blockScripts: string[];
	additionalScripts: string[];
	additionalCss: string[];
}

export interface BuildTimePath {
	path: string;
	match?: string[];
	static?: boolean;
}

export interface BuildTimeRenderArguments {
	root: string;
	entries: string[];
	useManifest?: boolean;
	paths?: (BuildTimePath | string)[];
	useHistory?: boolean;
	static?: boolean;
	puppeteerOptions?: any;
	basePath: string;
	baseUrl?: string;
	scope: string;
	sync?: boolean;
	renderer?: Renderer;
	discoverPaths?: boolean;
	writeHtml?: boolean;
}

function genHash(content: string): string {
	return createHash('md4')
		.update(content)
		.digest('hex')
		.substr(0, 20);
}

const trailingSlash = new RegExp(/\/$/);
const leadingSlash = new RegExp(/^\//);

export default class BuildTimeRender {
	private _cssFiles: string[] = [];
	private _entries: string[];
	private _manifest: any;
	private _manifestContent: any = {};
	private _buildBridgeResult: any = {};
	private _output?: string;
	private _jsonpName?: string;
	private _paths: (BuildTimePath | string)[];
	private _static = false;
	private _puppeteerOptions: any;
	private _root: string;
	private _useHistory = false;
	private _basePath = '';
	private _baseUrl: string;
	private _filesToWrite = new Set();
	private _filesToRemove = new Set();
	private _originalRoot!: string;
	private _blockErrors: Error[] = [];
	private _hasBuildBridgeCache = false;
	private _scope: string;
	private _renderer: Renderer;
	private _discoverPaths: boolean;
	private _sync: boolean;
	private _writeHtml: boolean;
	private _writtenHtmlFiles: string[] = [];

	constructor(args: BuildTimeRenderArguments) {
		const {
			paths = [],
			scope,
			root = '',
			entries,
			useHistory,
			puppeteerOptions,
			basePath,
			baseUrl = '/',
			renderer = 'puppeteer',
			discoverPaths = true,
			sync = false,
			writeHtml = true
		} = args;
		const path = paths[0];
		const initialPath = typeof path === 'object' ? path.path : path;

		this._basePath = basePath;
		this._baseUrl = baseUrl;
		if (!trailingSlash.test(this._baseUrl)) {
			this._baseUrl = `${this._baseUrl}/`;
		}
		if (!leadingSlash.test(this._baseUrl)) {
			this._baseUrl = `/${this._baseUrl}`;
		}
		this._renderer = renderer;
		this._discoverPaths = discoverPaths;
		this._puppeteerOptions = puppeteerOptions;
		this._paths = ['', ...paths];
		this._root = root;
		this._sync = sync;
		this._scope = scope;
		this._writeHtml = writeHtml;
		this._entries = entries.map((entry) => `${entry.replace('.js', '')}.js`);
		this._useHistory = useHistory !== undefined ? useHistory : paths.length > 0 && !/^#.*/.test(initialPath);
		if (this._useHistory || paths.length === 0) {
			this._static = !!args.static;
		}
	}

	private async _writeIndexHtml({
		content,
		script,
		path = '',
		styles,
		blockScripts,
		additionalScripts,
		additionalCss
	}: RenderResult) {
		let staticPath = false;
		if (typeof path === 'object') {
			if (this._useHistory) {
				staticPath = !!path.static;
			}
			path = path.path;
		} else {
			path = path;
		}

		let html = this._manifestContent['index.html'];
		const writtenAssets: string[] = this._entries.map((entry) => this._manifest[entry]);
		if (this._writeHtml) {
			html = html.replace(this._originalRoot, content);
			let css = this._entries.reduce((css, entry) => {
				const cssFile = this._manifest[entry.replace('.js', '.css')];
				if (cssFile) {
					html = html.replace(`<link href="${cssFile}" rel="stylesheet">`, '');
					css = `${css}<link rel="stylesheet" href="${cssFile}" />`;

					writtenAssets.push(cssFile);
				}
				return css;
			}, '');

			css = additionalCss.reduce((prev, url) => {
				url = url.replace(this._baseUrl.slice(1), '');
				writtenAssets.push(url);

				return `${prev}<link rel="preload" href="${url}" as="style">`;
			}, css);

			styles = await this._processCss(styles);
			html = html.replace(`</head>`, `<style>${styles}</style></head>`);
			if (this._static || staticPath) {
				html = html.replace(this._createScripts(), '');
			} else {
				html = html.replace(this._createScripts(), `${script}${css}${this._createScripts(false)}`);

				const mainScript = this._manifest['main.js'];

				additionalScripts
					.sort((script1, script2) => {
						return script1 === mainScript && !(script2 === mainScript) ? 1 : -1;
					})
					.forEach((additionalChunk: string) => {
						additionalChunk = additionalChunk.replace(this._baseUrl.slice(1), '');
						writtenAssets.push(additionalChunk);

						html = html.replace(
							'</body>',
							`<link rel="preload" href="${additionalChunk}" as="script"></body>`
						);
					});

				Object.keys(this._manifest)
					.filter((name) => name.endsWith('.js') || name.endsWith('.css'))
					.filter((name) => !name.startsWith('runtime/'))
					.filter((name) => !writtenAssets.some((asset) => this._manifest[name] === asset))
					.forEach((preload) => {
						html = html.replace(
							'</body>',
							`<link rel="prefetch" href="${this._manifest[preload].replace(
								this._baseUrl.slice(1),
								''
							)}" /></body>`
						);
					});
			}
		} else {
			if (!this._sync) {
				html = html.replace(
					'</body>',
					`<script type="text/javascript" src="${this._manifest['runtime/blocks.js']}"></script></body>`
				);
			}
		}
		if (!this._static && !staticPath) {
			blockScripts.forEach((blockScript, i) => {
				writtenAssets.push(blockScript);
				html = html.replace('</body>', `<script type="text/javascript" src="${blockScript}"></script></body>`);
			});
		}
		const htmlPath = join(this._output!, ...path.split('/'), 'index.html');
		if (path) {
			this._writtenHtmlFiles.push(htmlPath);
		}
		outputFileSync(htmlPath, html);
	}

	private _createScripts(regex = true) {
		const scripts = this._entries.reduce(
			(script, entry) => `${script}<script${regex ? '.*' : ''} src="${this._manifest[entry]}"></script>`,
			''
		);
		return regex ? new RegExp(scripts) : scripts;
	}

	private _filterCss(classes: string[]): string {
		return this._cssFiles.reduce((result, entry: string) => {
			let filteredCss: string = filterCss(join(this._output!, entry), (context: string, value: string) => {
				if (context === 'selector') {
					value = value.replace(/(:| ).*/, '');
					value = value
						.split('.')
						.slice(0, 2)
						.join('.');
					const firstChar = value.substr(0, 1);

					return classes.indexOf(value) === -1 && ['.', '#'].indexOf(firstChar) !== -1;
				}
			});

			return `${result}${filteredCss}`;
		}, '');
	}

	private async _processCss(css: string) {
		const cssnanoConfig = cssnano({ preset: ['default', { calc: false, normalizeUrl: false }] });
		const processedCss = await postcss([cssnanoConfig]).process(css, { from: undefined });
		return processedCss.css;
	}

	private async _getRenderResult(
		page: any,
		path: BuildTimePath | string | undefined = undefined
	): Promise<RenderResult> {
		const classes: any[] = await getClasses(page);
		let pathValue = typeof path === 'object' ? path.path : path;
		let content = await getForSelector(page, `#${this._root}`);
		let styles = this._filterCss(classes);
		let script = '';

		content = content.replace(/http:\/\/localhost:\d+\//g, '');
		content = content.replace(new RegExp(this._baseUrl.slice(1), 'g'), '');
		if (this._useHistory) {
			script = generateBasePath(pathValue, this._scope);
		}

		return {
			content,
			styles,
			script,
			path,
			blockScripts: [],
			additionalScripts: [],
			additionalCss: []
		};
	}

	private async _buildBridge(modulePath: string, args: any[]) {
		try {
			const module = require(`${this._basePath}/${modulePath}`);
			if (module && module.default) {
				const promise = module.default(...args);
				const result = await promise;
				this._buildBridgeResult[modulePath] = this._buildBridgeResult[modulePath] || {};
				this._buildBridgeResult[modulePath][JSON.stringify(args)] = JSON.stringify(result);
				return result;
			}
		} catch (e) {
			this._blockErrors.push(e);
		}
	}

	private _updateHTML(oldHash: string, hash: string) {
		const name = 'index.html';
		let content = this._manifestContent[name];
		content = content.replace(new RegExp(oldHash, 'g'), hash);
		this._manifestContent[name] = content;
		this._filesToWrite.add(name);
	}

	private _createCombinedRenderResult(renderResults: RenderResult[]) {
		const combined = renderResults.reduce(
			(combined, result) => {
				combined.styles = result.styles ? `${combined.styles}\n${result.styles}` : combined.styles;
				combined.html.push(result.content);
				combined.paths.push(result.path || '');
				combined.blockScripts.push(...result.blockScripts);
				combined.additionalScripts.push(...result.additionalScripts);
				combined.additionalCss.push(...result.additionalCss);
				return combined;
			},
			{ styles: '', html: [], paths: [], blockScripts: [], additionalScripts: [], additionalCss: [] } as {
				paths: (string | BuildTimePath)[];
				styles: string;
				html: string[];
				blockScripts: string[];
				additionalScripts: string[];
				additionalCss: string[];
			}
		);
		const script = generateRouteInjectionScript(combined.html, combined.paths, this._root);
		return {
			styles: combined.styles,
			content: this._originalRoot,
			script,
			blockScripts: combined.blockScripts,
			additionalScripts: combined.additionalScripts,
			additionalCss: combined.additionalCss
		};
	}

	private _writeSyncBuildBridgeCache() {
		const [, , mainHash] = this._manifest['main.js'].match(/(main\.)(.*)(\.bundle)/) || ([] as any);
		Object.keys(this._buildBridgeResult).forEach((modulePath) => {
			Object.keys(this._buildBridgeResult[modulePath]).forEach((args) => {
				this._hasBuildBridgeCache = true;
				const blockResult = this._buildBridgeResult[modulePath][args];
				const blockCacheEntry = ` blockCacheEntry('${modulePath}', '${args}', ${blockResult});`;
				if (this._manifestContent['main.js'].indexOf(blockCacheEntry) === -1) {
					this._manifestContent['main.js'] = this._manifestContent['main.js'].replace(
						'APPEND_BLOCK_CACHE_ENTRY **/',
						`APPEND_BLOCK_CACHE_ENTRY **/${blockCacheEntry}`
					);
				}

				if (mainHash) {
					const currentMainChunkName = this._manifest['main.js'];
					const currentMainHash = this._manifest['main.js']
						.replace('main.js'.replace('js', ''), '')
						.replace(/\..*/, '');
					const newMainHash = genHash(this._manifestContent['main.js']);

					const mainChunkName = `main.${newMainHash}.bundle.js`;
					this._manifest['main.js'] = mainChunkName;
					this._updateHTML(currentMainHash, newMainHash);
					this._filesToRemove.add(currentMainChunkName);
					this._filesToRemove.add(mainChunkName);
				}
				this._filesToWrite.add('main.js');
			});
		});
		this._buildBridgeResult = {};
		return [];
	}

	private _writeBuildBridgeCache(additionalScripts: string[]) {
		const scripts: string[] = [];
		const [, , mainHash] = this._manifest['main.js'].match(/(main\.)(.*)(\.bundle)/) || ([] as any);
		const chunkMarker = `main:"${mainHash}",`;
		const blockChunk = 'runtime/blocks.js';
		Object.keys(this._buildBridgeResult).forEach((modulePath) => {
			Object.keys(this._buildBridgeResult[modulePath]).forEach((args) => {
				this._hasBuildBridgeCache = true;
				const chunkName = `runtime/block-${genHash(modulePath + args)}`;
				const blockCacheEntry = `blockCacheEntry('${modulePath}', '${args}', '${chunkName}')`;
				const blockResult = this._buildBridgeResult[modulePath][args];
				const blockResultChunk = `
(window['${this._jsonpName}'] = window['${this._jsonpName}'] || []).push([['${chunkName}'],{
/***/ '${chunkName}.js':
/*! exports provided: default */
/***/ (function(module, __webpack_exports__, __webpack_require__) {
"use strict";
__webpack_require__.r(__webpack_exports__);
/* harmony default export */ __webpack_exports__["default"] = (${blockResult});
/***/ })
}]);
`;
				if (mainHash) {
					scripts.push(`${chunkName}.${genHash(blockResultChunk)}.bundle.js`);
				} else {
					scripts.push(`${chunkName}.js`);
				}

				if (this._manifestContent[blockChunk].indexOf(blockCacheEntry) === -1) {
					this._manifestContent[blockChunk] = this._manifestContent[blockChunk].replace(
						'APPEND_BLOCK_CACHE_ENTRY **/',
						`APPEND_BLOCK_CACHE_ENTRY **/
${blockCacheEntry}`
					);
					this._manifest[`${chunkName}.js`] = `${chunkName}.js`;
					if (mainHash) {
						const newBlockHash = genHash(this._manifestContent[blockChunk]);
						const currentBlockChunkName = this._manifest[blockChunk];
						const currentBootstrapChunkName = this._manifest['bootstrap.js'];
						const currentBlockHash = currentBlockChunkName
							.replace(blockChunk.replace('js', ''), '')
							.replace(/\..*/, '');
						const blockResultChunkHash = genHash(blockResultChunk);
						this._manifest[`${chunkName}.js`] = `${chunkName}.${blockResultChunkHash}.bundle.js`;
						this._manifestContent['bootstrap.js'] = this._manifestContent['bootstrap.js'].replace(
							chunkMarker,
							`${chunkMarker}"${chunkName}":"${blockResultChunkHash}",`
						);
						this._manifestContent['bootstrap.js'] = this._manifestContent['bootstrap.js'].replace(
							currentBlockHash,
							newBlockHash
						);
						const currentBootstrapHash = this._manifest['bootstrap.js']
							.replace('bootstrap.js'.replace('js', ''), '')
							.replace(/\..*/, '');
						const newBootstrapHash = genHash(this._manifestContent['bootstrap.js']);
						const bootstrapChunkName = `bootstrap.${newBootstrapHash}.bundle.js`;
						const blockChunkName = `runtime/blocks.${newBlockHash}.bundle.js`;
						this._manifest['bootstrap.js'] = bootstrapChunkName;
						this._manifest[blockChunk] = blockChunkName;
						this._updateHTML(currentBootstrapHash, newBootstrapHash);
						this._updateHTML(currentBlockHash, newBlockHash);
						this._filesToRemove.add(currentBootstrapChunkName);
						this._filesToRemove.add(currentBlockChunkName);
						this._filesToRemove.add(blockChunkName);
						this._filesToRemove.add(bootstrapChunkName);
						this._filesToWrite.add('bootstrap.js');
						const additionalScriptIndex = additionalScripts.indexOf(currentBlockChunkName);
						if (additionalScriptIndex !== -1) {
							additionalScripts[additionalScriptIndex] = blockChunkName;
						}
					}
					this._manifestContent[`${chunkName}.js`] = blockResultChunk;
					this._filesToWrite.add(blockChunk);
					this._filesToWrite.add(`${chunkName}.js`);
				}
			});
		});
		this._buildBridgeResult = {};
		return scripts;
	}

	private _writeBuildTimeCacheFiles() {
		if (this._hasBuildBridgeCache) {
			outputFileSync(join(this._output!, 'manifest.json'), JSON.stringify(this._manifest, null, 2), 'utf-8');
			this._filesToRemove.forEach((name) => {
				removeSync(join(this._output!, name));
			});

			this._filesToRemove = new Set();

			this._filesToWrite.forEach((name) => {
				this._filesToRemove.add(this._manifest[name]);
				outputFileSync(join(this._output!, this._manifest[name]), this._manifestContent[name], 'utf-8');
			});

			this._filesToWrite = new Set();
		}
	}

	private async _createPage(browser: any) {
		const reportError = (err: Error) => {
			if (err.message.indexOf('http://localhost') !== -1) {
				err.message = `BTR runtime ${err.message}`;
				this._blockErrors.push(err);
			}
		};
		const page = await browser.newPage();
		page.on('error', reportError);
		page.on('pageerror', reportError);
		await setupEnvironment(page, this._baseUrl, this._scope);
		await page.exposeFunction('__dojoBuildBridge', this._buildBridge.bind(this));
		return page;
	}

	public apply(compiler: Compiler) {
		if (!this._root) {
			return;
		}

		const plugin = new webpack.NormalModuleReplacementPlugin(/\.block/, (resource: any) => {
			const modulePath = join(resource.context, resource.request)
				.replace(this._basePath, '')
				.replace(/\\/g, '/')
				.replace(/^\//, '');
			resource.request = `@dojo/webpack-contrib/build-time-render/build-bridge-loader?modulePath='${modulePath}'!@dojo/webpack-contrib/build-time-render/bridge`;
		});
		plugin.apply(compiler);

		compiler.hooks.afterEmit.tapAsync(this.constructor.name, async (compilation, callback) => {
			this._buildBridgeResult = {};
			this._blockErrors = [];

			let htmlFileToRemove = this._writtenHtmlFiles.pop();
			while (htmlFileToRemove) {
				removeSync(htmlFileToRemove);
				htmlFileToRemove = this._writtenHtmlFiles.pop();
			}

			if (compiler.options.output) {
				this._output = compiler.options.output.path;
				this._jsonpName = compiler.options.output.jsonpFunction;
			}

			if (!this._output || compilation.errors.length > 0) {
				return Promise.resolve().then(() => {
					callback();
				});
			}

			this._manifest = JSON.parse(compilation.assets['manifest.json'].source());
			this._manifestContent = Object.keys(this._manifest).reduce((obj: any, chunkname: string) => {
				obj[chunkname] = compilation.assets[this._manifest[chunkname]].source();
				return obj;
			}, this._manifestContent);
			const originalManifest = { ...this._manifest };

			const html = this._manifestContent['index.html'];
			const root = parse(html);
			const rootNode = root.querySelector(`#${this._root}`);
			if (!rootNode) {
				const error = new Error(
					`Failed to run build time rendering. Could not find DOM node with id: "${
						this._root
					}" in src/index.html`
				);
				compilation.errors.push(error);
				callback();
				return;
			}
			this._originalRoot = `${rootNode.toString()}`;
			this._cssFiles = Object.keys(this._manifest)
				.filter((key) => {
					return /\.css$/.test(key);
				})
				.map((key) => this._manifest[key]);

			clearModule.match(new RegExp(`${resolve(this._basePath, 'src')}.*`));
			const browser = await renderer(this._renderer).launch(this._puppeteerOptions);
			const app = await serve(`${this._output}`, this._baseUrl);
			try {
				const screenshotDirectory = join(this._output, '..', 'info', 'screenshots');
				ensureDirSync(screenshotDirectory);
				let renderResults: RenderResult[] = [];
				let paths = [...this._paths];
				let registeredPaths = paths.map((path) => (typeof path === 'object' ? path.path : path));
				let path: BuildTimePath | string | undefined;

				while ((path = paths.shift()) != null) {
					let parsedPath = typeof path === 'object' ? path.path : path;
					let page = await this._createPage(browser);
					await page.goto(`http://localhost:${app.port}${this._baseUrl}${parsedPath}`);
					const pathDirectories = parsedPath.replace('#', '').split('/');
					if (pathDirectories.length > 0) {
						pathDirectories.pop();
						ensureDirSync(join(screenshotDirectory, ...pathDirectories));
					}
					let { rendering, blocksPending } = await getRenderHooks(page, this._scope);
					while (rendering || blocksPending) {
						({ rendering, blocksPending } = await getRenderHooks(page, this._scope));
					}
					const scripts = await getScriptSources(page, app.port);
					const additionalScripts = scripts.filter(
						(script) => script && this._entries.every((entry) => !script.endsWith(originalManifest[entry]))
					);
					const additionalCss = (await getPageStyles(page)).filter((url: string) =>
						this._entries.every((entry) => !url.endsWith(originalManifest[entry.replace('.js', '.css')]))
					);
					const blockScripts = this._sync
						? this._writeSyncBuildBridgeCache()
						: this._writeBuildBridgeCache(additionalScripts);
					await page.screenshot({
						path: join(screenshotDirectory, `${parsedPath ? parsedPath.replace('#', '') : 'default'}.png`)
					});
					if (this._discoverPaths) {
						const links = await getPageLinks(page);
						for (let i = 0; i < links.length; i++) {
							if (registeredPaths.indexOf(links[i]) === -1) {
								paths.push(links[i]);
								registeredPaths.push(links[i]);
							}
						}
					}
					let result = await this._getRenderResult(page, path);
					result.blockScripts = blockScripts;
					result.additionalScripts = additionalScripts;
					result.additionalCss = additionalCss;
					renderResults.push(result);

					await page.close();
				}

				this._writeBuildTimeCacheFiles();

				if (!this._useHistory && this._paths.length > 1) {
					renderResults = [this._createCombinedRenderResult(renderResults)];
				}

				await Promise.all(renderResults.map((result) => this._writeIndexHtml(result)));
				if (this._hasBuildBridgeCache) {
					outputFileSync(
						join(this._output, '..', 'info', 'manifest.original.json'),
						compilation.assets['manifest.json'].source(),
						'utf8'
					);
				}
				if (this._blockErrors.length) {
					compilation.errors.push(...this._blockErrors);
				}
			} catch (error) {
				if (this._blockErrors.length) {
					compilation.errors.push(...this._blockErrors);
				}
				compilation.errors.push(error);
			} finally {
				await browser.close();
				await app.server.close();
				callback();
			}
		});
	}
}
