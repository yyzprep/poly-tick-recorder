const fs = require('fs');
const path = require('path');
const { validateStrategy, resolveParams } = require('./StrategyInterface');
const { hashSource } = require('../utils/hash');

const BUILTIN_DIR = path.join(__dirname, 'builtin');
const CUSTOM_DIR = path.join(__dirname, '..', '..', 'strategies');

// Strategy registry
const registry = new Map();

/**
 * Load all built-in and custom strategies.
 */
function loadAll() {
  registry.clear();

  // Load built-ins
  if (fs.existsSync(BUILTIN_DIR)) {
    for (const file of fs.readdirSync(BUILTIN_DIR)) {
      if (!file.endsWith('.js')) continue;
      loadFile(path.join(BUILTIN_DIR, file), 'builtin');
    }
  }

  // Load custom strategies
  if (fs.existsSync(CUSTOM_DIR)) {
    for (const file of fs.readdirSync(CUSTOM_DIR)) {
      if (!file.endsWith('.js')) continue;
      loadFile(path.join(CUSTOM_DIR, file), 'custom');
    }
  }

  return listStrategies();
}

function loadFile(filePath, source) {
  try {
    // Clear require cache for hot-reload
    delete require.cache[require.resolve(filePath)];

    const sourceCode = fs.readFileSync(filePath, 'utf-8');
    const strategy = require(filePath);

    const validation = validateStrategy(strategy);
    if (!validation.valid) {
      console.warn(`Invalid strategy ${filePath}: ${validation.errors.join(', ')}`);
      return null;
    }

    // Attach metadata
    strategy._sourceHash = hashSource(sourceCode);
    strategy._sourcePath = filePath;
    strategy._source = source;
    strategy._fileName = path.basename(filePath, '.js');

    registry.set(strategy.name, strategy);
    return strategy;
  } catch (err) {
    console.warn(`Failed to load strategy ${filePath}: ${err.message}`);
    return null;
  }
}

function getStrategy(name) {
  return registry.get(name) || null;
}

function listStrategies() {
  return Array.from(registry.values()).map(s => ({
    name: s.name,
    description: s.description || '',
    params: s.params || {},
    source: s._source,
    fileName: s._fileName,
  }));
}

/**
 * Get a strategy instance with resolved params.
 */
function prepareStrategy(name, userParams = {}) {
  const strategy = getStrategy(name);
  if (!strategy) throw new Error(`Strategy not found: ${name}`);

  const params = resolveParams(strategy, userParams);

  return {
    strategy,
    params,
  };
}

// Hot-reload: re-scan strategies
function reload() {
  return loadAll();
}

module.exports = { loadAll, getStrategy, listStrategies, prepareStrategy, reload };
