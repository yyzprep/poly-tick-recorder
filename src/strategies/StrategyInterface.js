/**
 * StrategyInterface — Defines the contract all strategies must follow.
 *
 * Required:
 *   - name: string
 *   - onTick(tick, history, portfolio, state, ctx): signal | null
 *
 * Optional:
 *   - description: string
 *   - params: { [key]: { type, default, min?, max?, options?, desc } }
 *   - init(ctx): state object
 *   - onSettle(outcome, portfolio, state, ctx): void
 */

function validateStrategy(strategy) {
  const errors = [];

  if (!strategy.name || typeof strategy.name !== 'string') {
    errors.push('Strategy must have a "name" (string)');
  }

  if (typeof strategy.onTick !== 'function') {
    errors.push('Strategy must have an "onTick" function');
  }

  if (strategy.init && typeof strategy.init !== 'function') {
    errors.push('"init" must be a function if provided');
  }

  if (strategy.onSettle && typeof strategy.onSettle !== 'function') {
    errors.push('"onSettle" must be a function if provided');
  }

  if (strategy.params && typeof strategy.params !== 'object') {
    errors.push('"params" must be an object if provided');
  }

  if (strategy.params) {
    for (const [key, schema] of Object.entries(strategy.params)) {
      if (!schema.type) {
        errors.push(`Param "${key}" must have a "type" (number, string, boolean, select)`);
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Get the params schema with defaults applied
 */
function resolveParams(strategy, userParams = {}) {
  const resolved = {};
  const schema = strategy.params || {};

  for (const [key, def] of Object.entries(schema)) {
    if (key in userParams) {
      resolved[key] = userParams[key];
    } else if ('default' in def) {
      resolved[key] = def.default;
    }
  }

  // Pass through any extra params the user provided
  for (const [key, val] of Object.entries(userParams)) {
    if (!(key in resolved)) {
      resolved[key] = val;
    }
  }

  return resolved;
}

module.exports = { validateStrategy, resolveParams };
