import * as Humanizing from "@sb-types/Localizer/Humanizer";
import * as Types from "@sb-types/Types";
import * as path from "path";
import * as formatMessage from "format-message";
import * as getLogger from "loggy";
import * as Interfaces from "@sb-types/Localizer/HumanizerInterfaces";
import { ILogFunction } from "loggy";
import { InterfaceSchema } from "@sb-types/Typer";
import { LocalizerParser } from "@sb-types/Localizer/LocalizerParser";
import { LocalizerFileLoader, LangFileToCodeFunction, FilterFunc } from "@sb-types/Localizer/LocalizerFileLoader";
import { LocalizerKeysAssignation } from "@sb-types/Localizer/LocalizerKeysAssignation";

export interface ILocalizerOptions {
	languages: string[];
	sourceLanguage: string;
	defaultLanguage: string;
	directory: string;
	disableCoverageLog: boolean | string[];
	extendOverride?: boolean;
	parsersPreset?: LocalizerParser[];
}

export const SCHEMA_LOCALIZEROPTIONS: InterfaceSchema<ILocalizerOptions> = {
	"languages": {
		type: "object",
		isArray: true,
		elementSchema: { type: "string" }
	},
	"sourceLanguage": { type: "string", optional: true, eitherRequired: "defaultLanguage" },
	"defaultLanguage": { type: "string", optional: true, eitherRequired: "sourceLanguage" },
	"directory": { type: "string" },
	"disableCoverageLog": { type: "boolean", optional: true },
	"extendOverride": { type: "boolean", optional: true },
	"parsersPreset": { type: "object", isArray: true, optional: true }
};

const META_KEYS = ["+NAME", "+COUNTRY"];
const DYNAMIC_META_KEYS = ["+COVERAGE"];
const HUMANIZER_META_KEYS = ["+HUMANIZE:DURATION:YEARS", "+HUMANIZE:DURATION:MONTHS", "+HUMANIZE:DURATION:WEEKS", "+HUMANIZE:DURATION:DAYS", "+HUMANIZE:DURATION:HOURS", "+HUMANIZE:DURATION:MINUTES", "+HUMANIZE:DURATION:SECONDS", "+HUMANIZE:DURATION:MILLISECONDS"];
const PRUNE_BANNED_KEYS = [...META_KEYS, ...DYNAMIC_META_KEYS, ...HUMANIZER_META_KEYS];

const OWNERSHIP = Symbol("LocalizerStrings");

export class Localizer {
	private readonly _opts: ILocalizerOptions;
	private readonly _log: ILogFunction;
	private readonly _sourceLang: string;
	private readonly _fallbackQueue: string[] = [];
	private readonly _humanizersMap: Interfaces.ILanguageHashMap<Humanizing.Humanizer>;
	private readonly _formatMessage = formatMessage.namespace();
	private readonly _loader: LocalizerFileLoader;
	private readonly _langsMap: Interfaces.ILanguageHashMap<Interfaces.IStringsMap | undefined>;
	private readonly _keysAssignation: LocalizerKeysAssignation;
	private _initDone: boolean = false;
	private _loadedLanguages: string[] = [];

	/**
	 * Language specified in configuration as default
	 * @returns Base name of the file without extension
	 */
	public get defaultLanguage() {
		return this._opts.defaultLanguage;
	}

	/**
	 * Language specified in configuration as source
	 * @returns Base name of the file without extension
	 */
	public get sourceLanguage() {
		return this._sourceLang;
	}

	/**
	 * Key assigning management
	 */
	public get keysAssignation() {
		return this._keysAssignation;
	}

	/**
	 * Language files loader
	 */
	public get fileLoader() {
		return this._loader;
	}

	constructor(name: string, opts: ILocalizerOptions) {
		this._log = getLogger(name);

		if (!opts.sourceLanguage) {
			if (!opts.defaultLanguage) {
				throw new Error("No source language specified in options");
			}

			this._log("warn", "Only default language specified. Default language will be set as source language");
			opts.sourceLanguage = opts.defaultLanguage;
		}

		// killing console spam about no translations???
		this._formatMessage.setup({
			missingTranslation: "ignore"
		});

		const { sourceLanguage, disableCoverageLog } = opts;
		let { defaultLanguage } = opts;

		if (!opts.defaultLanguage) {
			defaultLanguage = opts.defaultLanguage = this._sourceLang;
		} else if (defaultLanguage !== sourceLanguage) {
			this._fallbackQueue.push(opts.defaultLanguage);
		}

		if (disableCoverageLog != null) {
			const covgLogDisabledType = typeof disableCoverageLog;

			if (covgLogDisabledType === "object") {
				if (!Array.isArray(disableCoverageLog)) {
					throw new Error("`disable_coverage_log` should be either array or boolean");
				}

				const possibleLanguages = [sourceLanguage];

				if (defaultLanguage && defaultLanguage !== sourceLanguage) {
					possibleLanguages.push(defaultLanguage);
				}

				opts.disableCoverageLog = disableCoverageLog
					.filter(possibleLanguages.includes);
			} else if (covgLogDisabledType === "boolean") {
				this._coverageDisabledGlobally = opts.disableCoverageLog;
			} else {
				throw new Error("`disable_coverage_log` should be either array or boolean");
			}

			this._coverageDisablingSet = true;
		}

		// Creating file loader

		this._loader = new LocalizerFileLoader(
			`${name}:FileLoader`,
			opts.parsersPreset
		);

		// Creating key assignation

		const keysAssignation = new LocalizerKeysAssignation(
			`${name}:KeysAssignation`
		);

		this._keysAssignation = keysAssignation;

		keysAssignation.assignKeys(PRUNE_BANNED_KEYS, OWNERSHIP);

		// Creating default maps
		this._humanizersMap = Object.create(null);
		this._langsMap = Object.create(null);

		this._sourceLang = sourceLanguage;
		this._fallbackQueue.push(sourceLanguage);

		this._opts = opts;
	}

	/**
	 * Initiates all loading and checks
	 */
	public async init() {
		if (this._initDone) throw new Error("Initialization is already done");

		try {
			this._log("info", "Started loading of language files...");

			const langFileNames = this._opts.languages;

			for (let i = 0, l = langFileNames.length; i < l; i++) {
				const langFileName = langFileNames[i];

				const langName = path.basename(
					langFileName,
					path.extname(langFileName)
				);

				if (langName in this._langsMap) {
					throw new Error(`Language "${langFileName}" is already registered`);
				}

				const langFilePath = path.join(this._opts.directory, langFileName);

				let stringsMap: Interfaces.IStringsMap = Object.create(null);

				try {
					stringsMap = await this._loader.loadStringsMap(langFilePath);
				} catch (err) {
					this._log("err", `Cannot read "${langFileName}":`, err);

					continue;
				}

				let rejectLoading = false;

				let requiredMetaKey: string;

				for (let i = 0, l = META_KEYS.length; i < l; i++) {
					requiredMetaKey = META_KEYS[i];

					if (requiredMetaKey in stringsMap) continue;

					rejectLoading = true;
				}

				if (rejectLoading) {
					// tslint:disable-next-line: no-unnecessary-type-assertion
					this._log("err", `Cannot read "${langFileName}": required key "${requiredMetaKey!}" is missing`);

					continue;
				}

				this._langsMap[langName] = stringsMap;

				this._humanizersMap[langName] = this.createCustomHumanizer(langName);

				this._log("ok", `Loaded "${langName}" language (file "${langFileName}")`);
			}

			this._log("info", "Requesting source language");

			const sourceLanguage = this._opts.sourceLanguage;

			if (!(sourceLanguage in this._langsMap)) {
				throw new Error(`Source language ("${sourceLanguage}") not found`);
			}

			this._log("info", "Calculating language files coverages...");

			await this.calculateCoverages();
		} catch (err) {
			this._log("err", "Error at initializing localizer", err);

			throw err;
		}

		this._loadedLanguages = Object.keys(this._langsMap);

		this._initDone = true;
	}

	/**
	 * Calculates coverages for languages
	 * 
	 * 'Coverage' means how many strings were translated
	 * @param langNames Names of languages. By default all languages
	 * @param log Should it log to console the results of calculation
	 * @returns Hash map where key is language name and value is percentage of 'coverage'
	 */
	public async calculateCoverages(langNames = Object.keys(this._langsMap), log = false) {
		const results: Types.INullableHashMap<number> = Object.create(null);
		const sourceLanguage = this._langsMap[this._sourceLang];

		for (let i = 0, l = langNames.length; i < l; i++) {
			const langName = langNames[i];

			const langFile = this._langsMap[langName]!;

			if (langName === this._sourceLang) {
				langFile["+COVERAGE"] = "100";

				results[langName] = 100;

				continue;
			}

			if (!langFile) { continue; }

			results[langName] = await this.calculateCoverage(langFile, sourceLanguage, log);
		}

		return results;
	}

	private async calculateCoverage(langFile: string | Interfaces.IStringsMap, sourceLanguage?: Interfaces.IStringsMap, log = false, _langName?: string): Promise<number> {
		let knownName: string | undefined;
		
		if (typeof langFile === "string") {
			if (_langName) {
				if (_langName !== langFile) throw new Error("Wrong language specified");

				knownName = _langName;
			} else {
				knownName = langFile;
			}

			langFile = this._langsMap[langFile]!;

			if (!langFile) { throw new Error("Language name with this name is not found"); }
		}

		const isSourceLanguage = sourceLanguage
			? langFile === sourceLanguage
			: false;

		if (isSourceLanguage) {
			langFile["+COVERAGE"] = "100";

			return 100;
		}

		const coverage = await this.testCoverage(langFile, (sourceLanguage || this._langsMap[this.sourceLanguage]), knownName);

		langFile["+COVERAGE"] = `${coverage}`;

		if (log) { this._log("ok", `- ${langFile["+NAME"]} (${langFile["+COUNTRY"]}) - ${coverage}`); }

		return coverage;
	}

	/**
	 * Checks converage of default language by selected language's dictionary
	 * @param langFile Dictionary of strings
	 * @param defaultLanguage Default language
	 */
	private async testCoverage(langFile: Interfaces.IStringsMap, defaultLanguage = this._langsMap[this._opts.sourceLanguage]!, _langName?: string) {
		let total = 0;
		let unique = 0;

		const coverageDisabled = this._isCoverageDisabledFor(_langName);

		for (const key in defaultLanguage) {
			total++;

			if (DYNAMIC_META_KEYS.includes(key) || (typeof langFile[key] === "string" && langFile[key] !== "")) {
				unique++;

				continue;
			}
			
			if (coverageDisabled) continue;

			this._log("warn", `String "${key}" not translated in lang ${langFile["+NAME"]}`);
		}

		const coverage = (100 * (unique / total));

		return Math.round(coverage * 100) / 100; // 99.99%
	}

	private readonly _coverageDisabledGlobally: boolean | string[];
	private readonly _coverageDisablingSet: boolean;

	private _isCoverageDisabledFor(langName?: string) {
		if (this._coverageDisabledGlobally) return true;

		if (this._coverageDisablingSet) {
			if (!langName) return false;

			if (this._opts.disableCoverageLog) {
				return (<string[]> this._opts.disableCoverageLog).includes(langName);
			}
		}

		return false;
	}

	/**
	 * Extends selected language with strings
	 * @param langName Language name to extend
	 * @param langFile Language file or filename
	 * @returns List of imported keys to language
	 */
	public async extendLanguage(langName: string, langFile: string | string[] | Interfaces.IStringsMap) {
		const keysAssignation = this._keysAssignation;
		const importedKeys: string[] = [];
		const langMap = this._langsMap[langName];

		const sourceLanguage = langName !== this._sourceLang
			? this._langsMap[this._sourceLang]
			: undefined;

		if (!langMap) { 
			if (process.env["NODE_ENV"] !== "production") {
				throw new Error(`Language "${langName}" is not loaded yet`);
			}

			this._log("warn_trace", `Language "${langName}" is not loaded, skipping...`);

			return;
		}

		if (typeof langFile !== "object" || Array.isArray(langFile)) {
			langFile = await this._loader.loadStringsMap(langFile);
		}

		for (const key in langFile) {
			let value = langFile[key];
			const valueType = typeof value;

			if (valueType !== "string") {
				if (valueType === "number" || valueType === "boolean") {
					value = String(value);
				} else {
					this._log("info", `Invalid type of "${key}" - "${valueType}"`);

					continue;
				}
			}

			if (sourceLanguage && !(key in sourceLanguage)) {
				this._log("warn", `"${key}" is not found in source language yet.`);
			}

			if (key in langMap) {
				if (keysAssignation.isAssigned(key)) {
					this._log("warn", `Don't override key "${key}" in language "${langName}" as it bound by someone`);

					continue;
				}

				if (!this._opts.extendOverride) {
					this._log("info", `Don't override key "${key}" in language "${langName}" as override is set to \`false\``);

					continue;
				}
			}

			langMap[key] = value;

			importedKeys.push(key);
		}

		return importedKeys;
	}

	/**
	 * Extends language using hash map
	 * @param languagesTree Hash map where key is language name and value is strings map or filename
	 * @param toLangCode Function to convert strings map to language name, takes two arguments - filename and map itself
	 * @param filter Glob string(s) to filter files in directory or function
	 * @param throwOnError Throw error if reading of file in directory fails
	 * @returns List of all imported keys to all languages
	 */
	public async extendLanguages(
		languagesTree: Types.IHashMap<Interfaces.IStringsMap | string> | string,
		toLangCode?: LangFileToCodeFunction,
		filter?: FilterFunc,
		throwOnError = false
	) {

		if (typeof languagesTree !== "object") {
			languagesTree = await
				this._loader
					.directoryToLanguagesTree(
						languagesTree,
						toLangCode,
						filter,
						throwOnError
					);
		}

		const importedKeys: string[] = [];
		const langs = Object.keys(languagesTree);

		{ // swap source with other language (moving so to the begining of array)
			const sourceLangInd = langs.indexOf(this._sourceLang);

			if (sourceLangInd > 0) { // -1 & 0
				arrSwap(
					langs,
					sourceLangInd,
					0 // the begining
				);
			}
		}

		for (let i = 0, l = langs.length; i < l; i++) {
			const langName = langs[i];
			const langFile = languagesTree[langName];

			const langKeys = await this.extendLanguage(langName, langFile);

			if (!langKeys) { continue; }

			for (let i = 0, l = langKeys.length; i < l; i++) {
				const key = langKeys[i];

				if (!importedKeys.includes(key)) importedKeys.push(key);
			}
		}

		return importedKeys;
	}

	/**
	 * Removes specified keys from all languages
	 * @param keys Keys to remove
	 * @example $localizer.pruneLanguages(["8BALL_ANSWER_CERTAIN", ...])
	 * @returns Keys that were removed
	 */
	public pruneLanguages(keys: string[]) {
		const keysAssignation = this._keysAssignation;

		keys = keys.filter(key => !PRUNE_BANNED_KEYS.includes(key));

		const _pruneResults: string[] = [];

		for (const langName in this._langsMap) {
			const langFile = this._langsMap[langName];

			if (!langFile) { continue; }

			for (let i = 0, l = keys.length; i < l; i++) {
				const key = keys[i];

				if (keysAssignation.isAssigned(key)) {
					this._log(
						"info",
						`Not removing key ${key} from "${langName}" because it is bound by someone`
					);
				}

				delete langFile[key];

				_pruneResults.push(key);
			}
		}

		return _pruneResults;
	}

	/**
	 * Returns list of all loaded languages
	 */
	public get loadedLanguages() {
		return this._loadedLanguages.slice(0);
	}

	/**
	 * Checks if dictionary of selected language exists
	 * @param language Language to check
	 */
	public languageExists(language: string) {
		return language in this._langsMap;
	}

	/**
	 * Gets all the keys for the selected language
	 * 
	 * **Warning**: This function is ineffective due to usage `Object.keys`,
	 * inspect ways to avoid multiple calls of it
	 * @param language Language which keys to obtain
	 * @returns Keys of the prefered locale
	 */
	public getLanguageKeys(language: string) {
		const langMap = this._langsMap[language];

		if (langMap == null) throw new Error(`Language "${language}" not found`);

		return Object.keys(langMap);
	}

	/**
	 * Returns string from dictionary of translated strings of selected language
	 * @param preferedLang Language to get string from
	 * @param key Key in language dictionary
	 * @param fallback true if should try to find the fallback string in default and source languages
	 */
	public getString(preferedLang: string = this._opts.sourceLanguage, key: string, fallback: boolean = true): string {
		const queue = fallback ? [preferedLang].concat(this._fallbackQueue) : [preferedLang];

		for (let i = 0, l = queue.length; i < l; i++) {
			const lang = queue[i];
			const langMap = this._langsMap[lang];

			if (!langMap) throw new Error(`Language "${lang}" not found`);

			const foundStr = langMap[key];

			if (foundStr && foundStr !== "") return foundStr;
		}

		const errStr = fallback
			? `String "${key}" not found nor in "${preferedLang}", nor in default & source languages`
			: `String "${key}" not found in "${preferedLang}"`;

		this._log("err", errStr);

		throw new Error(errStr);
	}

	/**
	 * Returns formatted string in selected language using ICU formatting
	 * @param lang Language to get string from
	 * @param key Key in language translations
	 * @param variables Variables for selected key and futher formatting
	 * @param fallback true if should use string from default language as fallback
	 */
	public getFormattedString(
		lang: string = this.sourceLanguage,
		key: string,
		variables: Interfaces.IFormatMessageVariables,
		fallback: boolean = true
	) {
		const str = this.getString(lang, key, fallback);

		return this.formatString(lang, str, variables);
	}

	public formatString(
		lang: string,
		str: string,
		variables?: Interfaces.IFormatMessageVariables
	) {
		return this._formatMessage(str, variables, lang);
	}

	/**
	 * Returns humanized string for time in selected unit
	 * @param lang Which language's Humanizer to use
	 * @param duration Time to humanize
	 * @param unit Unit of time
	 * @param overrides Overrides of default options
	 */
	public humanizeDuration(
		lang: string = this.sourceLanguage,
		duration: number,
		unit: Humanizing.Unit = "ms",
		overrides?: Humanizing.IHumanizerOptionsOverrides
	) {
		const humanizer = this._humanizersMap[lang];

		if (!humanizer) throw new Error("Could not find humanizer in selected language");

		return humanizer.humanize(
			unit !== "ms" ? humanizer.convertDuration(
				duration,
				unit
			) : duration,
			overrides
		);
	}

	/**
	 * Creates custom humanizer with choosen overrides
	 * @param lang Language to use in Humanizer
	 * @param overrides Custom language overrides for Humanizer
	 */
	public createCustomHumanizer(
		lang: string = this.sourceLanguage,
		languageOverride?: {
			// it's overrides, so we gonna create anotha inline-interface?
			y?: Humanizing.IHumanizerPluralOverride;
			mo?: Humanizing.IHumanizerPluralOverride;
			w?: Humanizing.IHumanizerPluralOverride;
			d?: Humanizing.IHumanizerPluralOverride;
			h?: Humanizing.IHumanizerPluralOverride;
			m?: Humanizing.IHumanizerPluralOverride;
			s?: Humanizing.IHumanizerPluralOverride;
			ms?: Humanizing.IHumanizerPluralOverride;
		}, defaultOptions?: Humanizing.IHumanizerDefaultOptions
	) {
		// OwO

		let defaultDefinition: Humanizing.IHumanizerLanguage = {
			y: (years: number) => this.getFormattedString(lang, "+HUMANIZE:DURATION:YEARS", { years }),
			mo: (months: number) => this.getFormattedString(lang, "+HUMANIZE:DURATION:MONTHS", { months }),
			w: (weeks: number) => this.getFormattedString(lang, "+HUMANIZE:DURATION:WEEKS", { weeks }),
			d: (days: number) => this.getFormattedString(lang, "+HUMANIZE:DURATION:DAYS", { days }),
			h: (hours: number) => this.getFormattedString(lang, "+HUMANIZE:DURATION:HOURS", { hours }),
			m: (minutes: number) => this.getFormattedString(lang, "+HUMANIZE:DURATION:MINUTES", { minutes }),
			s: (seconds: number) => this.getFormattedString(lang, "+HUMANIZE:DURATION:SECONDS", { seconds }),
			ms: (milliseconds: number) => this.getFormattedString(lang, "+HUMANIZE:DURATION:MILLISECONDS", { milliseconds })
		};

		if (languageOverride) {
			defaultDefinition = {
				...defaultDefinition,
				...languageOverride
			};
		}

		return new Humanizing.Humanizer(defaultDefinition, defaultOptions);
	}
}

function arrSwap<T>(arr: T[], fromIndex: number, toIndex: number) {
	[
		arr[fromIndex],
		arr[toIndex]
	] = [
		arr[toIndex],
		arr[fromIndex]
	];

	return arr;
}
