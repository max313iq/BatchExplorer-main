/** Singleton — every page-enhancer references this object. */
export const OPUS_47_MAX_PROFILE = Object.freeze({
    model: "claude-opus-4-7",
    contextWindowTokens: 1000000,
    effort: "max",
});
/**
 * Build helpers — most pages just need a small UI panel + a handful of tools
 * + a workflow that delegates to next(). These factories keep the per-page
 * files tiny and uniform.
 */
export function defineUIAgent(pageKey, spec) {
    var _a;
    return {
        kind: "ui",
        pageKey,
        profile: OPUS_47_MAX_PROFILE,
        id: (_a = spec.id) !== null && _a !== void 0 ? _a : `${pageKey}/ui`,
        title: spec.title,
        description: spec.description,
        render: spec.render,
    };
}
export function defineToolsAgent(pageKey, spec) {
    var _a;
    return {
        kind: "tools",
        pageKey,
        profile: OPUS_47_MAX_PROFILE,
        id: (_a = spec.id) !== null && _a !== void 0 ? _a : `${pageKey}/tools`,
        title: spec.title,
        description: spec.description,
        tools: spec.tools,
    };
}
export function defineWorkflowAgent(pageKey, spec) {
    var _a;
    return {
        kind: "workflow",
        pageKey,
        profile: OPUS_47_MAX_PROFILE,
        id: (_a = spec.id) !== null && _a !== void 0 ? _a : `${pageKey}/workflow`,
        title: spec.title,
        description: spec.description,
        intercept: spec.intercept,
        suggestDefaults: spec.suggestDefaults,
    };
}
//# sourceMappingURL=types.js.map