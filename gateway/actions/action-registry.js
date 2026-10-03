/**
 * Responsibility: Define the small, stable action protocol shared by the model and renderer.
 * Implementation:
 * 1. Keep action names aligned with renderer.js and the bundled VRMA assets.
 * 2. Validate duration and reject unknown animation requests.
 * 3. Return a serializable command for the main process to forward through preload IPC.
 */

const actionNames = ['idle', 'wave', 'walk', 'sit', 'sillyDance', 'hipHop', 'praying', 'jump'];

const actionToolDefinition = { type: 'function', function: { name: 'set_pet_action', description: '让桌宠做一个短暂的动作来配合当前语气。一次回复最多请求一个动作。', parameters: {
  type: 'object', properties: {
    action: { type: 'string', enum: actionNames, description: '动作名称。' },
    durationMs: { type: 'integer', minimum: 0, maximum: 10000, description: '持续时间；循环动作可填 0。' }
  }, required: ['action'], additionalProperties: false
} } };

// Validate model-provided action data before it crosses the gateway boundary.
function normalizeAction(input = {}) {
  const action = String(input.action || '').trim();
  if (!actionNames.includes(action)) throw new Error('桌宠动作不在允许列表中。');
  const rawDuration = Number(input.durationMs || 0);
  if (!Number.isFinite(rawDuration) || rawDuration < 0 || rawDuration > 10000) throw new Error('动作持续时间必须在 0～10000 毫秒之间。');
  return { action, durationMs: Math.floor(rawDuration) };
}

module.exports = { actionNames, actionToolDefinition, normalizeAction };
