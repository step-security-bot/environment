import path, { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createConflicterTransform, createYoResolveTransform } from '@yeoman/conflicter';
import { QueuedAdapter } from '@yeoman/adapter';
import { toNamespace } from '@yeoman/namespace';
import { passthrough } from '@yeoman/transform';
import chalk from 'chalk';
import { defaults, pick, uniq } from 'lodash-es';
import GroupedQueue from 'grouped-queue';
import { create as createMemFs } from 'mem-fs';
import { create as createMemFsEditor } from 'mem-fs-editor';
import createdLogger from 'debug';
import { flyImport } from 'fly-import';
// eslint-disable-next-line n/file-extension-in-import
import { isFilePending } from 'mem-fs-editor/state';
// eslint-disable-next-line n/file-extension-in-import
import { createCommitTransform } from 'mem-fs-editor/transform';
import YeomanCommand, { addEnvironmentOptions } from './util/command.js';
import { packageManagerInstallTask } from './package-manager.js';
import { findPackagesIn, getNpmPaths, moduleLookupSync } from './module-lookup.js';
import EnvironmentBase from './environment-base.js';
import { asNamespace, defaultLookups } from './util/namespace.js';
import { defaultQueues } from './constants.js';

const debug = createdLogger('yeoman:environment');

/**
 * Two-step argument splitting function that first splits arguments in quotes,
 * and then splits up the remaining arguments if they are not part of a quote.
 */
function splitArgsFromString(argsString) {
  let result = [];
  if (!argsString) {
    return result;
  }

  const quoteSeparatedArgs = argsString.split(/("[^"]*")/).filter(Boolean);
  for (const arg of quoteSeparatedArgs) {
    if (arg.match('\u0022')) {
      result.push(arg.replace(/"/g, ''));
    } else {
      result = result.concat(arg.trim().split(' '));
    }
  }

  return result;
}

export default class Environment extends EnvironmentBase {
  static get UNKNOWN_NAMESPACE() {
    return 'unknownnamespace';
  }

  static get UNKNOWN_RESOLVED() {
    return 'unknown';
  }

  static get queues() {
    return [...defaultQueues];
  }

  static get lookups() {
    return [...defaultLookups];
  }

  /**
   * Make sure the Environment present expected methods if an old version is
   * passed to a Generator.
   * @param  {Environment} env
   * @return {Environment} The updated env
   */
  static enforceUpdate(env) {
    if (!env.adapter) {
      env.adapter = new QueuedAdapter();
    }

    if (!env.runLoop) {
      env.runLoop = new GroupedQueue(Environment.queues, false);
    }

    if (!env.sharedFs) {
      env.sharedFs = createMemFs();
    }

    if (!env.fs) {
      env.fs = createMemFsEditor(env.sharedFs);
    }

    return env;
  }

  /**
   * Prepare a commander instance for cli support.
   *
   * @param {Class} GeneratorClass - Generator to create Command
   * @return {Command} Return a Command instance
   */
  static prepareCommand(GeneratorClass, command = new YeomanCommand()) {
    command = addEnvironmentOptions(command);
    return Environment.prepareGeneratorCommand(command, GeneratorClass);
  }

  /**
   * Prepare a commander instance for cli support.
   *
   * @param {Command} command - Command to be prepared
   * @param {Class} GeneratorClass - Generator to create Command
   * @return {Command} return command
   */
  static prepareGeneratorCommand(command, GeneratorClass, namespace) {
    const generator = new GeneratorClass([], { help: true, env: {} });
    command.registerGenerator(generator);

    command.action(async function () {
      let rootCommand = this;
      while (rootCommand.parent) {
        rootCommand = rootCommand.parent;
      }

      command.env = await Environment.createEnv(rootCommand.opts());

      rootCommand.emit('yeoman:environment', command.env);

      if (namespace) {
        await command.env.run([namespace, ...(this.args || [])], this.opts());
        return command.env;
      }

      const generator = await command.env.instantiate(GeneratorClass, this.args, this.opts());
      await command.env.queueGenerator(generator);
      await command.env.start();
      return command.env;
    });
    return command;
  }

  /**
   * Factory method to create an environment instance. Take same parameters as the
   * Environment constructor.
   *
   * @deprecated
   * @param {string[]} [args] - arguments.
   * @param {object} [options] - Environment options.
   * @param {Adapter} [adapter] - Terminal adapter.
   *
   * @return {Environment} a new Environment instance
   */
  static createEnv(args, options, adapter) {
    if (args && !Array.isArray(args)) {
      options = args;
    }

    options = options || {};
    return new Environment(options, adapter);
  }

  /**
   * Factory method to create an environment instance. Take same parameters as the
   * Environment constructor.
   *
   * @param {String} version - Version of the Environment
   * @param {...any} args - Same arguments as {@link Environment}#createEnv.
   * @return {Environment} a new Environment instance
   */
  static async createEnvWithVersion(version, ...args) {
    const envModule = await flyImport(`yeoman-environment@${version}`);
    const createEnv = envModule.createEnv ?? envModule.default.createEnv;
    return createEnv(...args);
  }

  /**
   * Convert a generators namespace to its name
   *
   * @param  {String} namespace
   * @return {String}
   */
  static namespaceToName(namespace) {
    return namespace.split(':')[0];
  }

  /**
   * Lookup for a specific generator.
   *
   * @param  {String} namespace
   * @param  {Object} [options]
   * @param {Boolean} [options.localOnly=false] - Set true to skip lookups of
   *                                                     globally-installed generators.
   * @param {Boolean} [options.packagePath=false] - Set true to return the package
   *                                                       path instead of generators file.
   * @param {Boolean} [options.singleResult=true] - Set false to return multiple values.
   * @return {String} generator
   */
  static lookupGenerator(namespace, options) {
    options =
      typeof options === 'boolean'
        ? { singleResult: true, localOnly: options }
        : { singleResult: !(options && options.multiple), ...options };

    options.filePatterns = options.filePatterns || Environment.lookups.map(prefix => path.join(prefix, '*/index.{js,ts}'));

    const name = Environment.namespaceToName(namespace);
    options.packagePatterns = options.packagePatterns || toNamespace(name)?.generatorHint;

    options.npmPaths = options.npmPaths || getNpmPaths({ localOnly: options.localOnly, filePaths: false }).reverse();
    options.packagePatterns = options.packagePatterns || 'generator-*';
    options.packagePaths = options.packagePaths || findPackagesIn(options.npmPaths, options.packagePatterns);

    let paths = options.singleResult ? undefined : [];
    moduleLookupSync(options, ({ files, packagePath }) => {
      for (const filename of files) {
        const fileNS = asNamespace(filename, { lookups: Environment.lookups });
        if (namespace === fileNS || (options.packagePath && namespace === Environment.namespaceToName(fileNS))) {
          // Version 2.6.0 returned pattern instead of modulePath for options.packagePath
          const returnPath = options.packagePath ? packagePath : options.generatorPath ? path.posix.join(filename, '../../') : filename;
          if (options.singleResult) {
            paths = returnPath;
            return filename;
          }

          paths.push(returnPath);
        }
      }
      return undefined;
    });

    if (options.singleResult) {
      return paths && isAbsolute(paths) ? pathToFileURL(paths).toString() : paths;
    }

    return paths.map(gen => (isAbsolute(gen) ? pathToFileURL(gen).toString() : gen));
  }

  /**
   * @classdesc `Environment` object is responsible of handling the lifecyle and bootstrap
   * of generators in a specific environment (your app).
   *
   * It provides a high-level API to create and run generators, as well as further
   * tuning where and how a generator is resolved.
   *
   * An environment is created using a list of `arguments` and a Hash of
   * `options`. Usually, this is the list of arguments you get back from your CLI
   * options parser.
   *
   * An optional adapter can be passed to provide interaction in non-CLI environment
   * (e.g. IDE plugins), otherwise a `QueuedAdapter` is instantiated by default
   *
   * @constructor
   * @implements {import('@yeoman/types').BaseEnvironment}
   * @mixes env/resolver
   * @mixes env/composability
   * @param {String|Array}          args
   * @param {Object}                opts
   * @param {Boolean} [opts.experimental]
   * @param {Object} [opts.sharedOptions]
   * @param {Console}      [opts.console]
   * @param {Stream}         [opts.stdin]
   * @param {Stream}        [opts.stdout]
   * @param {Stream}        [opts.stderr]
   * @param {QueuedAdapter} [adapter] - A QueuedAdapter instance or another object
   *                                     implementing this adapter interface. This is how
   *                                     you'd interface Yeoman with a GUI or an editor.
   */
  constructor(options, adapter) {
    if (adapter) {
      options.adapter = adapter;
    }
    super(options);

    this.loadSharedOptions(this.options);
    if (this.sharedOptions.skipLocalCache === undefined) {
      this.sharedOptions.skipLocalCache = true;
    }
  }

  /**
   * Load options passed to the Generator that should be used by the Environment.
   *
   * @param {Object} options
   */
  loadEnvironmentOptions(options) {
    const environmentOptions = pick(options, ['skipInstall', 'nodePackageManager']);
    defaults(this.options, environmentOptions);
    return environmentOptions;
  }

  /**
   * Load options passed to the Environment that should be forwarded to the Generator.
   *
   * @param {Object} options
   */
  loadSharedOptions(options) {
    const optionsToShare = pick(options, [
      'skipInstall',
      'forceInstall',
      'skipCache',
      'skipLocalCache',
      'skipParseOptions',
      'localConfigOnly',
      'askAnswered',
    ]);
    Object.assign(this.sharedOptions, optionsToShare);
    return optionsToShare;
  }

  /**
   * Outputs the general help and usage. Optionally, if generators have been
   * registered, the list of available generators is also displayed.
   *
   * @param {String} name
   */
  help(name = 'init') {
    const out = [
      'Usage: :binary: GENERATOR [args] [options]',
      '',
      'General options:',
      "  --help       # Print generator's options and usage",
      '  -f, --force  # Overwrite files that already exist',
      '',
      'Please choose a generator below.',
      '',
    ];

    const ns = this.namespaces();

    const groups = {};
    for (const namespace of ns) {
      const base = namespace.split(':')[0];

      if (!groups[base]) {
        groups[base] = [];
      }

      groups[base].push(namespace);
    }

    for (const key of Object.keys(groups).sort()) {
      const group = groups[key];

      if (group.length > 0) {
        out.push('', key.charAt(0).toUpperCase() + key.slice(1));
      }

      for (const ns of groups[key]) {
        out.push(`  ${ns}`);
      }
    }

    return out.join('\n').replace(/:binary:/g, name);
  }

  /**
   * Registers a specific `generator` to this environment. This generator is stored under
   * provided namespace, or a default namespace format if none if available.
   *
   * @param  {String} name      - Filepath to the a generator or a npm package name
   * @param  {String} namespace - Namespace under which register the generator (optional)
   * @param  {String} packagePath - PackagePath to the generator npm package (optional)
   * @return {Object} environment - This environment
   */
  register(pathOrStub, meta, ...args) {
    if (typeof pathOrStub === 'string') {
      if (typeof meta === 'object') {
        return this._registerGeneratorPath(pathOrStub, meta.namespace, meta.packagePath);
      }
      return this._registerGeneratorPath(pathOrStub, meta, ...args);
    }
    if (pathOrStub) {
      if (typeof meta === 'object') {
        return this.registerStub(pathOrStub, meta.namespace, meta.resolved, meta.packagePath);
      }
      return this.registerStub(pathOrStub, meta, ...args);
    }
    throw new TypeError('You must provide a generator name to register.');
  }

  /**
   * Registers a specific `generator` to this environment. This generator is stored under
   * provided namespace, or a default namespace format if none if available.
   *
   * @param  {String} name      - Filepath to the a generator or a npm package name
   * @param  {String} namespace - Namespace under which register the generator (optional)
   * @param  {String} packagePath - PackagePath to the generator npm package (optional)
   * @return {Object} environment - This environment
   */
  _registerGeneratorPath(generatorPath, namespace, packagePath) {
    if (typeof generatorPath !== 'string') {
      throw new TypeError('You must provide a generator name to register.');
    }

    if (!isAbsolute(generatorPath)) {
      throw new Error(`An absolute path is required to register`);
    }

    namespace = namespace || this.namespace(generatorPath);

    if (!namespace) {
      throw new Error('Unable to determine namespace.');
    }

    // Generator is already registered and matches the current namespace.
    const generatorMeta = this.store.getMeta(namespace);
    if (generatorMeta && generatorMeta.resolved === generatorPath) {
      return this;
    }

    const meta = this.store.add({ namespace, resolved: generatorPath, packagePath });

    debug('Registered %s (%s) on package %s (%s)', namespace, generatorPath, meta.packageNamespace, packagePath);
    return this;
  }

  /**
   * Register a stubbed generator to this environment. This method allow to register raw
   * functions under the provided namespace. `registerStub` will enforce the function passed
   * to extend the Base generator automatically.
   *
   * @param  {Function} Generator  - A Generator constructor or a simple function
   * @param  {String}   namespace  - Namespace under which register the generator
   * @param  {String}   [resolved] - The file path to the generator
   * @param  {String} [packagePath] - The generator's package path
   * @return {this}
   */
  registerStub(Generator, namespace, resolved = Environment.UNKNOWN_RESOLVED, packagePath = undefined) {
    if (typeof Generator !== 'function' && typeof Generator.createGenerator !== 'function') {
      throw new TypeError('You must provide a stub function to register.');
    }

    if (typeof namespace !== 'string') {
      throw new TypeError('You must provide a namespace to register.');
    }

    this.store.add({ namespace, resolved, packagePath }, Generator);

    debug('Registered %s (%s) on package (%s)', namespace, resolved, packagePath);
    return this;
  }

  /**
   * Returns the list of registered namespace.
   * @return {Array}
   */
  namespaces() {
    return this.store.namespaces();
  }

  /**
   * Returns stored generators meta
   * @return {Object}
   */
  getGeneratorsMeta() {
    return this.store.getGeneratorsMeta();
  }

  /**
   * Get registered generators names
   *
   * @return {Array}
   */
  getGeneratorNames() {
    return uniq(Object.keys(this.getGeneratorsMeta()).map(namespace => Environment.namespaceToName(namespace)));
  }

  /**
   * Get last added path for a namespace
   *
   * @param  {String} - namespace
   * @return {String} - path of the package
   */
  async getPackagePath(namespace) {
    if (namespace.includes(':')) {
      const generator = (await this.get(namespace)) || {};
      return generator.packagePath;
    }

    const packagePaths = this.getPackagePaths(namespace) || [];
    return packagePaths[0];
  }

  /**
   * Get paths for a namespace
   *
   * @param  {String} - namespace
   * @return  {Array} - array of paths.
   */
  getPackagePaths(namespace) {
    return this.store.getPackagesPaths()[namespace] || this.store.getPackagesPaths()[Environment.namespaceToName(this.alias(namespace))];
  }

  /**
   * Create is the Generator factory. It takes a namespace to lookup and optional
   * hash of options, that lets you define `arguments` and `options` to
   * instantiate the generator with.
   *
   * An error is raised on invalid namespace.
   *
   * @param {String} namespaceOrPath
   * @param {Array} [args]
   * @param {Object} [options]
   * @return {Promise<Generator>} The instantiated generator
   */
  async create(namespaceOrPath, args, options) {
    if (!Array.isArray(args) && typeof args === 'object') {
      options = args.options || args;
      args = args.arguments || args.args || [];
    } else {
      args = Array.isArray(args) ? args : splitArgsFromString(args);
      options = options || {};
    }

    const namespace = toNamespace(namespaceOrPath);

    let maybeGenerator = this.get(namespaceOrPath);
    if (!maybeGenerator) {
      await this.lookupLocalNamespaces(namespace);
      maybeGenerator = await this.get(namespace);
    }

    const checkGenerator = Generator => {
      if (
        namespace &&
        Generator &&
        Generator.namespace &&
        Generator.namespace !== namespace.namespace &&
        Generator.namespace !== Environment.UNKNOWN_NAMESPACE
      ) {
        // Update namespace object in case of aliased namespace.
        try {
          namespace.namespace = Generator.namespace;
        } catch {
          // Invalid namespace can be aliased to a valid one.
        }
      }

      if (typeof Generator !== 'function') {
        throw new TypeError(
          chalk.red(`You don't seem to have a generator with the name “${namespace?.generatorHint}” installed.`) +
            '\n' +
            'But help is on the way:\n\n' +
            'You can see available generators via ' +
            chalk.yellow('npm search yeoman-generator') +
            ' or via ' +
            chalk.yellow('http://yeoman.io/generators/') +
            '. \n' +
            'Install them with ' +
            chalk.yellow(`npm install ${namespace?.generatorHint}`) +
            '.\n\n' +
            'To see all your installed generators run ' +
            chalk.yellow('yo --generators') +
            '. ' +
            'Adding the ' +
            chalk.yellow('--help') +
            ' option will also show subgenerators. \n\n' +
            'If ' +
            chalk.yellow('yo') +
            ' cannot find the generator, run ' +
            chalk.yellow('yo doctor') +
            ' to troubleshoot your system.',
        );
      }

      return Generator;
    };

    return this.instantiate(checkGenerator(await maybeGenerator), args, options);
  }

  /**
   * Compose with the generator.
   *
   * @param {String} namespaceOrPath
   * @param {Array} [args]
   * @param {Object} [options]
   * @param {Boolean} [schedule]
   * @return {Generator} The instantiated generator or the singleton instance.
   */
  async composeWith(generator, args, options, composeOptions) {
    let schedule;
    if (typeof args === 'boolean') {
      schedule = args;
      args = undefined;
      options = undefined;
    } else if (typeof options === 'boolean') {
      schedule = options;
      options = undefined;
    }
    schedule = typeof composeOptions === 'boolean' ? composeOptions : composeOptions?.schedule ?? true;

    const generatorInstance = await this.create(generator, args, options);
    return this.queueGenerator(generatorInstance, { schedule });
  }

  /**
   * Queue generator run (queue itself tasks).
   *
   * @param {Generator} generator Generator instance
   * @param {boolean} [schedule=false] Whether to schedule the generator run.
   * @return {Generator} The generator or singleton instance.
   */
  async queueGenerator(generator, queueOptions) {
    const schedule = typeof queueOptions === 'boolean' ? queueOptions : queueOptions?.schedule ?? false;
    const { added, identifier, generator: composedGenerator } = this.composedStore.addGenerator(generator);
    if (!added) {
      debug(`Using existing generator for namespace ${identifier}`);
      return composedGenerator;
    }

    this.emit('compose', identifier, generator);
    this.emit(`compose:${identifier}`, generator);

    const runGenerator = async () => {
      if (generator.queueTasks) {
        // Generator > 5
        this.once('run', () => generator.emit('run'));
        this.once('end', () => generator.emit('end'));
        await generator.queueTasks();
        return;
      }

      if (!generator.options.forwardErrorToEnvironment) {
        generator.on('error', error => this.emit('error', error));
      }

      generator.promise = generator.run();
    };

    if (schedule) {
      this.queueTask('environment:run', () => runGenerator());
    } else {
      await runGenerator();
    }

    return generator;
  }

  /**
   * Tries to locate and run a specific generator. The lookup is done depending
   * on the provided arguments, options and the list of registered generators.
   *
   * When the environment was unable to resolve a generator, an error is raised.
   *
   * @param {String|Array} args
   * @param {Object}       [options]
   */
  async run(args, options) {
    args = Array.isArray(args) ? args : splitArgsFromString(args);
    options = { ...options };

    const name = args.shift();
    if (!name) {
      throw new Error('Must provide at least one argument, the generator namespace to invoke.');
    }

    this.loadEnvironmentOptions(options);

    const instantiateAndRun = async () => {
      const generator = await this.create(name, args, {
        ...options,
        initialGenerator: true,
      });
      if (options.help) {
        console.log(generator.help());
        return undefined;
      }

      return this.runGenerator(generator);
    };

    if (this.experimental && !this.get(name)) {
      debug(`Generator ${name} was not found, trying to install it`);
      try {
        await this.prepareEnvironment(name);
      } catch {}
    }

    return instantiateAndRun();
  }

  /**
   * Start Environment queue
   * @param {Object} options - Conflicter options.
   */
  start(options) {
    return new Promise((resolve, reject) => {
      if (this.conflicter === undefined) {
        this.conflicterOptions = pick(defaults({}, this.options, options), [
          'force',
          'bail',
          'ignoreWhitespace',
          'dryRun',
          'skipYoResolve',
          'logCwd',
        ]);
        this.conflicterOptions.cwd = this.conflicterOptions.logCwd;

        this.queueCommit();
        this.queuePackageManagerInstall();
      }

      /*
       * Listen to errors and reject if emmited.
       * Some cases the generator relied at the behavior that the running process
       * would be killed if an error is thrown to environment.
       * Make sure to not rely on that behavior.
       */
      this.on('error', error => {
        reject(error);
      });

      /*
       * For backward compatibility
       */
      this.on('generator:reject', error => {
        reject(error);
      });

      this.on('generator:resolve', error => {
        resolve(error);
      });

      this.runLoop.on('error', error => {
        this.emit('error', error);
        this.adapter.close();
      });

      this.runLoop.on('paused', () => {
        this.emit('paused');
      });

      this.once('end', () => {
        resolve();
      });

      /* If runLoop has ended, the environment has ended too. */
      this.runLoop.once('end', () => {
        this.emit('end');
      });

      this.emit('run');
      this.runLoop.start();
    });
  }

  /**
   * Convenience method to run the generator with callbackWrapper.
   * See https://github.com/yeoman/environment/pull/101
   *
   * @param {Object}       generator
   */
  async runGenerator(generator) {
    generator = await generator;
    generator = await this.queueGenerator(generator);

    this.compatibilityMode = generator.queueTasks ? false : 'v4';
    this._rootGenerator = this._rootGenerator || generator;

    return this.start(generator.options);
  }

  /**
   * Commits the MemFs to the disc.
   * @param {Stream} [stream] - files stream, defaults to this.sharedFs.stream().
   * @return {Promise}
   */
  commitSharedFs(stream = this.sharedFs.stream({ filter: file => isFilePending(file) })) {
    debug('committing files');

    return this.fs.commit(
      [
        passthrough(
          file => {
            file.conflicter = 'force';
          },
          { pattern: '**/{.yo-rc.json,.yo-resolve,.yo-rc-global.json}' },
        ),
        createYoResolveTransform(),
        createConflicterTransform(this.adapter, this.conflicterOptions),
        // Use custom commit transform due to out of order transform.
        createCommitTransform(this.fs),
      ],
      stream,
    );
  }

  /**
   * Queue environment's commit task.
   */
  queueCommit() {
    const queueCommit = () => {
      debug('Queueing conflicts task');
      this.queueTask(
        'environment:conflicts',
        async () => {
          const { customCommitTask = this.commitSharedFs.bind(this) } = this.composedStore;
          if (typeof customCommitTask !== 'function') {
            // There is a custom commit task or just disabled
            return;
          }

          await customCommitTask();

          debug('Adding queueCommit event listener');
          this.sharedFs.once('change', queueCommit);
        },
        {
          once: 'write memory fs to disk',
        },
      );
    };

    queueCommit();
  }

  /**
   * Queue environment's package manager install task.
   */
  queuePackageManagerInstall() {
    const { adapter, sharedFs: memFs } = this;
    const { skipInstall, nodePackageManager } = this.options;
    const { customInstallTask } = this.composedStore;
    this.queueTask(
      'install',
      () => {
        if (this.compatibilityMode === 'v4') {
          debug('Running in generator < 5 compatibility. Package manager install is done by the generator.');
          return false;
        }

        return packageManagerInstallTask({
          adapter,
          memFs,
          packageJsonLocation: this.cwd,
          skipInstall,
          nodePackageManager,
          customInstallTask,
        });
      },
      { once: 'package manager install' },
    );
  }
}
