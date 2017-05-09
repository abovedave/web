'use strict'

const _ = require('underscore')
const convict = require('convict')
const debug = require('debug')('web:templates')
const fs = require('fs')
const log = require('@dadi/logger')
const path = require('path')

let config = require(path.join(__dirname, '/../../../config.js'))
const helpers = require(path.join(__dirname, '/../help'))
const Template = require(path.join(__dirname, 'template'))

/**
  * Builds a template store.
  */
const TemplateStore = function () {
  this.engines = {}
  this.pagesPath = path.resolve(config.get('paths.pages'))
  this.templates = {}
}

/**
  * Finds a templating engine to deal with a given file extension.
  *
  * @return {object} The matching engine. undefined if none found.
  */
TemplateStore.prototype.findEngineForExtension = function (extension) {
  const engineHandle = Object.keys(this.engines).find(handle => {
    const engine = this.engines[handle]

    return engine.extensions && engine.extensions.indexOf(extension) !== -1
  })

  if (engineHandle) {
    return this.engines[engineHandle]
  }
}

/**
  * Triggers the `finishLoading` function on all templating engines.
  *
  * @return {Promise} Resolves when all functions finish executing.
  */
TemplateStore.prototype.finishLoading = function () {
  let queue = []

  Object.keys(this.engines).forEach(name => {
    const engine = this.engines[name]

    if (engine.started) {
      const finishLoadingFunction = engine.handler.finishLoading

      if (typeof finishLoadingFunction === 'function') {
        queue.push(finishLoadingFunction.call(engine.handler))
      }
    }
  })

  return Promise.all(queue)
}

/**
  * Retrieves a template by name.
  *
  * @param {string} templateName The name of the template.
  *
  * @return {Template} The template.
  */
TemplateStore.prototype.get = function (templateName) {
  return this.templates[templateName]
}

/**
  * Computes the list of file extensions supported by all engines.
  *
  * @return {Array} An array of extensions.
  */
TemplateStore.prototype.getSupportedExtensions = function () {
  let extensions = []

  Object.keys(this.engines).forEach(handle => {
    const engineExtensions = this.engines[handle].extensions

    engineExtensions.forEach(engineExtension => {
      if (extensions.indexOf(engineExtension) === -1) {
        extensions.push(engineExtension)
      }
    })
  })

  return extensions
}

/**
  * Loads all files in a directory.
  *
  * @param {string} directory The full path to the directory.
  * @param {object} options Additional options.
  * @param {boolean} options.recursive Whether to load files in sub-directories.
  * @param {string} options.namespace A namespace for the files.
  *
  * @return {Promise} A Promise resolving when all files have been loaded.
  */
TemplateStore.prototype.loadDirectory = function (directory, options) {
  options = options || {}
  options.recursive = options.recursive || false
  options.extensions = this.getSupportedExtensions()

  return helpers.readDirectory(directory, options).then(files => {
    return this.loadFiles(
      files,
      _.extend(
        {
          basePath: directory
        },
        options
      )
    )
  })
}

/**
  * Loads all templating engines.
  */
TemplateStore.prototype.loadEngines = function (engines) {
  const globalEngineConfig = config.get('engines')

  const enginesLoaded = engines.map(engine => {
    try {
      const engineConfigBlock = engine.metadata.config
      const extensions = engine.metadata.extensions
      const handle = engine.metadata.handle

      if (config && globalEngineConfig[handle]) {
        const engineConfig = convict(engineConfigBlock)

        engineConfig.load(globalEngineConfig[handle])
        engineConfig.validate({
          allowed: 'strict'
        })

        config.set(`engines.${handle}`, engineConfig.getProperties())
      }

      if (
        typeof handle === 'string' &&
        typeof this.engines[handle] === 'undefined'
      ) {
        this.engines[handle] = {
          extensions: extensions,
          handle: handle,
          factory: engine,
          started: false
        }
      }

      return handle
    } catch (err) {
      log.error(
        { module: 'templates' },
        { err: err },
        `Error initialising templating engine "${engine}".`
      )
    }
  })

  debug('Loaded templating engines: %o', enginesLoaded)
}

/**
  * Loads files from an array of paths.
  *
  * @param {array} pages The absolute paths for the files to be loaded.
  * @param {object} options Additional options.
  * @param {string} options.basePath When present, makes the name relative to this directory.
  * @param {boolean} options.recursive Whether to load files in sub-directories.
  * @param {string} options.namespace A namespace for the files.
  *
  * @return {Promise} A Promise resolving when all files have been loaded.
  */
TemplateStore.prototype.loadFiles = function (files, options) {
  options = options || {}

  return helpers.readFiles(files, {
    callback: file => {
      const extension = path.extname(file)
      const templateName = options.basePath
        ? path.relative(options.basePath, file).slice(0, -extension.length)
        : path.basename(file, extension)

      return new Promise((resolve, reject) => {
        fs.readFile(file, 'utf8', (err, data) => {
          if (err) return reject(err)

          return resolve(
            this.loadTemplate({
              data: data,
              extension: extension,
              name: templateName,
              namespace: options.namespace,
              path: file
            })
          )
        })
      })
    },

    extensions: this.getSupportedExtensions()
  })
}

/**
  * Loads page templates.
  *
  * @param {array} files The absolute paths for the files to be loaded.
  * @param {object} options Additional options.
  *
  * @return {Promise} A Promise resolving when all pages have been loaded.
  */
TemplateStore.prototype.loadPages = function (pages, options) {
  const extendedOptions = Object.assign(
    {
      basePath: this.pagesPath
    },
    options
  )

  return helpers
    .readDirectory(this.pagesPath, {
      extensions: this.getSupportedExtensions(),
      recursive: true
    })
    .then(files => {
      this.additionalTemplates = files.filter(file => {
        return pages.indexOf(file) === -1
      })

      return this.loadFiles(pages, extendedOptions)
    })
    .then(loadedTemplates => {
      debug('Loaded templates: %o', loadedTemplates)
    })
}

/**
  * Loads a template into the store.
  *
  * @param {object} parameters The template parameters.
  * @param {string} parameters.data The content of the template.
  * @param {string} parameters.extension The file extension.
  * @param {string} parameters.name The name of the template.
  * @param {string} parameters.namespace The namespace of the template.
  */
TemplateStore.prototype.loadTemplate = function (parameters) {
  parameters = parameters || {}

  const engine = this.findEngineForExtension(parameters.extension)

  if (!engine) {
    log.error(
      { module: 'templates' },
      {
        err: new Error(
          `Error loading template "${parameters.name}": no engine for extension ${parameters.extension}.`
        )
      }
    )

    return
  }

  const name = parameters.name
  const namespace = parameters.namespace || ''

  if (this.templates[name + namespace]) {
    return Promise.resolve(false)
  }

  let startQueue = []

  // If this engine hasn't been started yet, we start it now.
  if (!engine.started) {
    const EngineConstructor = engine.factory()
    const additionalTemplatesForEngine = this.additionalTemplates.filter(
      template => {
        return (
          engine.factory.metadata.extensions.indexOf(path.extname(template)) !==
          -1
        )
      }
    )

    engine.handler = new EngineConstructor({
      additionalTemplates: additionalTemplatesForEngine,
      config: config,
      helpers: helpers,
      pagesPath: this.pagesPath,
      templates: this.templates
    })

    this.validateEngine(engine.factory, engine.handler)

    engine.started = true

    // Converting the `initialise` function to a Promise, to allow engines to
    // perform asynchronous initialisation routines.
    const initialise = Promise.resolve(engine.handler.initialise())

    startQueue.push(initialise)
  }

  return Promise.all(startQueue).then(() => {
    const template = new Template(
      parameters.name,
      parameters.namespace,
      parameters.path,
      engine
    )

    this.templates[namespace + name] = template

    return template.register(parameters.data).then(data => {
      return name
    })
  })
}

/**
  * Validates a templating engine, checking for vital lifecycle methods.
  *
  * @throws {Error} If the engine fails the validation.
  */
TemplateStore.prototype.validateEngine = function (factory, engine) {
  let errors = []

  if (typeof factory.metadata !== 'object') {
    errors.push('is missing the metadata block')
  } else {
    if (!(factory.metadata.extensions instanceof Array)) {
      errors.push('is missing the extensions property on the metadata block')
    }

    if (typeof factory.metadata.handle !== 'string') {
      errors.push('is missing the handle property on the metadata block')
    }
  }

  if (typeof engine.getCore !== 'function') {
    errors.push('is missing the `getCore()` method')
  }

  if (typeof engine.getInfo !== 'function') {
    errors.push('is missing the `getInfo()` method')
  }

  if (typeof engine.initialise !== 'function') {
    errors.push('is missing the `initialise()` method')
  }

  if (typeof engine.register !== 'function') {
    errors.push('is missing the `register()` method')
  }

  if (typeof engine.render !== 'function') {
    errors.push('is missing the `render()` method')
  }

  if (errors.length) {
    const errorMessage = `Validation failed for "${factory && factory.metadata.name}" templating engine: ${errors.join(', ')}`
    const error = new Error(errorMessage)

    log.error({ module: 'templates' }, { err: error }, errorMessage)

    throw error
  }
}

module.exports = new TemplateStore()
